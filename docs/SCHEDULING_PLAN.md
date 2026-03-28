# Scheduling System Plan

> Two-tier scheduling: heartbeat wheel for sub-hourly intervals, calendar for day/time events.
> Both backed by the database. Both use window-based polling to avoid missed ticks.
> Agent-linked rows are cleaned up automatically on agent delete.

---

## Overview

Two primitives:

1. **Heartbeat** — sub-hourly recurring tasks. Agent gets poked every N seconds. Based on a 3600-second wheel with slot-to-agent pairings in the DB, but processed using an elapsed time window so manager start time does not matter.

2. **Calendar** — day/time scheduled events. One-off (specific local date) or recurring (days of week). Time stored as seconds since midnight in the scheduler timezone. Events can have multiple agents.

Both are configured in the YAML deploy config and stored in the DB at deploy time.

---

## Tier 1: Heartbeat Wheel

### Concept

A 3600-second (1-hour) wheel. Each second (0–3599) can have agents mapped to it. Every 60 seconds, the manager checks the full elapsed slot window since the previous tick and fires any matched agents. This avoids drift and works regardless of which second the manager process started.

An agent with `every: 5m` (300s) gets mapped to 12 slots: 0, 300, 600, ..., 3300.
An agent with `every: 30m` (1800s) gets mapped to 2 slots: 0, 1800.
An agent with `every: 1h` (3600s) gets mapped to 1 slot: 0.

### Database

```sql
CREATE TABLE heartbeat_slots (
  slot INTEGER NOT NULL,          -- 0-3599
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message TEXT NOT NULL,           -- what to tell the agent
  PRIMARY KEY (slot, team_id, agent_id),
  FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
);

CREATE INDEX heartbeat_slot_idx ON heartbeat_slots(slot);
```

### Tick (every 60 seconds, window-based)

```typescript
const nowSec = Math.floor(Date.now() / 1000);
const prevSec = this.lastSchedulerTickSec ?? (nowSec - 60);

const slots = new Set<number>();
for (let t = prevSec + 1; t <= nowSec; t++) {
  slots.add(t % 3600);
}

const matches = await db.query(
  `SELECT DISTINCT slot, team_id, agent_id, message
   FROM heartbeat_slots
   WHERE slot IN (${Array.from(slots).map(() => '?').join(',')})`,
  Array.from(slots)
);

for (const match of matches.rows) {
  sendToAgent(match.agent_id, match.message, 'heartbeat');
}

this.lastSchedulerTickSec = nowSec;
```

Notes:
- The manager tracks `lastSchedulerTickSec` in memory.
- On first boot, default to `now - 60` so the first pass checks the last minute.
- `SELECT DISTINCT` prevents duplicate sends when the elapsed window wraps across the hour boundary and the same slot appears twice.
- This design tolerates normal timer drift and manager start at arbitrary seconds.

### Slot Calculation on Deploy

```typescript
function computeSlots(everySeconds: number): number[] {
  const slots: number[] = [];
  for (let s = 0; s < 3600; s += everySeconds) {
    slots.push(s);
  }
  return slots;
}
```

### YAML Config

```yaml
agents:
  - name: contracts
    heartbeat:
      every: 300          # seconds (5 minutes)
      message: "Run test suite and report results"

  - name: indexer
    heartbeat:
      every: 600          # 10 minutes
      message: "Check indexer health and sync status"
```

### Cleanup

Agent deleted → `ON DELETE CASCADE` removes all its slots. No orphan timers.
Agent redeployed → old rows deleted with agent, new rows inserted on deploy.

### Constraints

- Minimum interval: 60 seconds (matches tick rate)
- Maximum interval: 3600 seconds (1 hour — use calendar for longer)
- `every` must divide evenly into 3600 (60, 120, 180, 300, 600, 900, 1200, 1800, 3600)
- Reject invalid intervals at config/deploy time instead of rounding silently
- Heartbeat-specific limits such as `maxBeats` and `expiresAfter` should remain part of the stored schedule model if the current product behavior is preserved

---

## Tier 2: Calendar

### Concept

Events scheduled by day and time. Time stored as seconds since midnight (0–86399). Events can be one-off (specific date) or recurring (days of week). An event can have multiple agents.

### Database

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  time INTEGER NOT NULL,          -- seconds since midnight (0-86399) in event timezone
  date TEXT,                      -- local date like "2026-04-01" for one-off, NULL for recurring
  days TEXT,                      -- "mon,wed,fri" for recurring, NULL for one-off
  active INTEGER NOT NULL DEFAULT 1,
  last_fired_key TEXT,            -- e.g. "2026-04-01@32400" to prevent duplicate firing in a window
  created_at INTEGER NOT NULL
);

CREATE TABLE event_agents (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id, agent_id),
  FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
);

CREATE INDEX events_time_idx ON events(time);
CREATE INDEX events_active_idx ON events(active) WHERE active = 1;
CREATE INDEX events_team_active_time_idx ON events(team_id, active, time);
```

### Tick (every 60 seconds, same timer as heartbeat)

```typescript
const now = new Date();
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: schedulerTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}).formatToParts(now);

const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
const today = `${get('year')}-${get('month')}-${get('day')}`;
const dayOfWeek = get('weekday').toLowerCase().slice(0, 3);
const secondsSinceMidnight = Number(get('hour')) * 3600 + Number(get('minute')) * 60 + Number(get('second'));

const prevSec = this.lastCalendarTickSec ?? (secondsSinceMidnight - 60);
const dueTimes = new Set<number>();
for (let t = prevSec + 1; t <= secondsSinceMidnight; t++) {
  dueTimes.add((t + 86400) % 86400);
}

const dueParams = Array.from(dueTimes);
const placeholders = dueParams.map(() => '?').join(',');

const rows = await db.query(
  `SELECT e.*, ea.agent_id
   FROM events e
   JOIN event_agents ea ON e.id = ea.event_id
   WHERE e.active = 1
     AND e.time IN (${placeholders})
     AND ((e.date = ? AND e.days IS NULL)
       OR (e.date IS NULL AND e.days LIKE ?))`,
  [...dueParams, today, `%${dayOfWeek}%`]
);

for (const event of rows.rows) {
  const fireKey = `${today}@${event.time}`;
  if (event.last_fired_key === fireKey) continue;

  sendToAgent(event.agent_id, formatEventMessage(event), 'calendar');
  await db.query('UPDATE events SET last_fired_key = ? WHERE id = ?', [fireKey, event.id]);

  if (event.date) {
    await db.query('UPDATE events SET active = 0 WHERE id = ?', [event.id]);
  }
}

this.lastCalendarTickSec = secondsSinceMidnight;
```

Notes:
- Use one explicit scheduler timezone for all comparisons, or store a timezone per event and group processing by timezone. Do not mix local wall time with UTC `toISOString()`.
- `last_fired_key` is more precise than a raw timestamp for deduplicating repeated polling windows.
- If per-event timezone support is not needed now, keep one team-wide scheduler timezone and add per-event timezone later.

### YAML Config

```yaml
calendar:
  - title: "Morning X engagement"
    time: "09:00"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    description: "Find tweets to engage with and suggest replies"

  - title: "Afternoon X roundup"
    time: "13:00"
    days: [mon, tue, wed, thu, fri]
    agents: [x]

  - title: "Evening X summary"
    time: "18:00"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    description: "Summarize today's engagement and metrics"

  - title: "Weekly security review"
    time: "10:00"
    days: [mon]
    agents: [contracts, gateway, cli]
    description: "Run security audit on your codebase"

  - title: "DevHunt launch"
    time: "08:00"
    date: "2026-04-01"
    agents: [x, id-agents-app]
    description: "Launch day — post announcements and monitor response"
```

### Time Parsing

YAML `time: "09:00"` → stored as integer: `9 * 3600 = 32400`
YAML `time: "18:30"` → stored as integer: `18 * 3600 + 30 * 60 = 66600`

```typescript
function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 3600 + (m || 0) * 60;
}
```

### Message Format

When a calendar event fires, the agent receives:

```
[Calendar Event: "Morning X engagement"]
Find tweets to engage with and suggest replies
```

With `from: "calendar"` so the agent knows it's a scheduled event, not a human message.

### Cleanup

- Deleting an event removes its `event_agents` rows via `ON DELETE CASCADE`.
- Deleting an agent removes all linked `event_agents` rows via the `(team_id, agent_id)` foreign key.
- Events are seeded from YAML config at deploy time.
- One-off events auto-deactivate after firing.
- `last_fired_key` prevents double-firing if the polling window overlaps.

---

## Manager Tick

One single `setInterval` in the manager handles both tiers:

```typescript
// Start on manager boot
setInterval(() => this.schedulerTick(), 60 * 1000);

private async schedulerTick(): Promise<void> {
  await this.processHeartbeats();
  await this.processCalendarEvents();
}
```

No per-agent timers. The only in-memory scheduler state should be the previous tick markers needed to compute elapsed windows (`lastSchedulerTickSec`, `lastCalendarTickSec`).

---

## Deploy Flow

At deploy time, the manager:

1. Reads `heartbeat` from each agent config → validates interval → computes slots → inserts into `heartbeat_slots`
2. Reads `calendar` from the top-level config → parses time in scheduler timezone → inserts into `events` + `event_agents`
3. Re-seeding should be idempotent: replace existing schedule rows for the deploy target rather than relying on agent deletion as the only cleanup path

---

## Migration

### Remove

- `heartbeatTimers` Map
- `heartbeatTimers` Map
- `heartbeatLastSent` Map
- `heartbeatIntervals` Map
- `heartbeatCounts` Map
- `heartbeatStartTimes` Map
- `heartbeatIntervalMs` field
- `startHeartbeatForAgent()` method
- `stopHeartbeatForAgent()` method
- timer-based `sendHeartbeat()` scheduling
- `initAllHeartbeats()` method
- `startAgentHeartbeats()` method

Keep or replace explicitly:
- `HeartbeatConfig.maxBeats` / `expiresAfter` semantics if those are still product requirements
- `/heartbeat` status/management commands, backed by DB schedule state instead of in-memory timers
- runtime-editable config only if you still want file-based overrides; otherwise move heartbeat config fully into DB/YAML and remove `HEARTBEAT.yaml` intentionally

### Add

- `heartbeat_slots` table (SQLite + PG migrations)
- `events` table (SQLite + PG migrations)
- `event_agents` table (SQLite + PG migrations)
- `schedulerTick()` method (replaces timer-based heartbeat scheduling)
- `processHeartbeats()` method using elapsed slot windows
- `processCalendarEvents()` method using elapsed time windows in a consistent timezone
- `seedHeartbeatSlots()` method (called during deploy)
- `seedCalendarEvents()` method (called during deploy)
- `/schedule` or `/calendar` CLI command to view upcoming events

---

## CLI Commands

```
/calendar                    # Show all scheduled events and heartbeats
/calendar add <event>        # Add a one-off event (interactive)
/calendar remove <id>        # Remove an event
```

---

## Example Full Config

```yaml
version: "1"
team: idchain

calendar:
  - title: "Morning X engagement"
    time: "09:00"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    description: "Find tweets to engage with"

  - title: "Evening X summary"
    time: "18:00"
    days: [mon, tue, wed, thu, fri]
    agents: [x]

  - title: "Weekly security review"
    time: "10:00"
    days: [mon]
    agents: [contracts, gateway, cli]

  - title: "DevHunt launch"
    time: "08:00"
    date: "2026-04-01"
    agents: [x, id-agents-app]
    description: "Launch day"

agents:
  - name: contracts
    description: "Smart contracts"
    heartbeat:
      every: 300
      message: "Run tests and report status"

  - name: x
    description: "Social media"
    # No heartbeat — uses calendar for scheduled engagement
```

---

## Summary

| Aspect | Heartbeat (Tier 1) | Calendar (Tier 2) |
|--------|-------------------|-------------------|
| Frequency | Sub-hourly (60s–3600s) | Daily/weekly |
| Config | Per-agent `heartbeat:` | Top-level `calendar:` |
| Storage | `heartbeat_slots` table | `events` + `event_agents` tables |
| Lookup | Elapsed slot window over `unix % 3600` | Elapsed local-time window + day/date match |
| Cleanup | CASCADE on agent delete | CASCADE on event delete |
| One-off | No | Yes (date field) |
| Multi-agent | No (one agent per heartbeat) | Yes (event_agents join) |
| `from` field | `"heartbeat"` | `"calendar"` |

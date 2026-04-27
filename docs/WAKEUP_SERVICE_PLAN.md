# Daemon-Side Wakeup / Notification Service — Starter Plan

Status: draft, awaiting CTO design review (task `wakeup-service-design` #a3540990)
Author: manager session, 2026-04-26

## Problem

The "manager" role is a Claude Code session driven by a human. It dispatches work via `POST :4100/remote` and is supposed to follow up by polling `GET /query/:id` and `GET /news`. In practice the polling is inconsistent:

- The session only polls when the human takes a turn. Replies that arrive between turns sit unread.
- Long-poll (`?wait=30`) helps but caps at one socket and still requires the session to remember to come back.
- The admin-control listener exists for `/talk` replies but is per-session and dies with the session.
- Different consumers (TUI, future web dashboard, scripts, agents) all reinvent the same poll loop.

Net effect: the manager misses or delays replies, and every new consumer adds another fragile poll loop.

## Proposal

Add a first-class wakeup / notification service to the daemon (`:4100`). Consumers register interest in events; the daemon pushes notifications. `/query` long-poll stays as a compatibility path but ceases to be the primary discovery mechanism.

## Sketch (subject to CTO design)

### API surface

- `POST /subscribe` body `{ events: [...], target: { kind, ... } }` → `{ subscriptionId }`
- `DELETE /subscribe/:id`
- `GET /subscribe?owner=<name>` to list

### Event types (initial)

- `query:delivered`, `query:failed`, `query:expired` (filterable by `queryId` or `agent`)
- `news:to:<name>` — new inbox item for a specific agent or for `manager`
- `task:status` — task created / claimed / completed (filterable by `name` or `assignee`)
- `agent:lifecycle` — start / stop / rebuild

### Delivery modes (CTO to choose primary)

- **Webhook**: HTTP POST to a URL the consumer already runs. Fits the existing `ADMIN_LISTENER_PORT` pattern. Survives consumer restarts (subscription persists, deliveries retry). Best for long-lived consumers (web dashboard, persistent agents).
- **SSE stream**: Consumer holds one socket, multiplexed events. Best for terminals / TUIs where opening an inbound HTTP port is awkward.
- **WebSocket**: Same shape as SSE but bidirectional. Probably overkill for v1.

Recommendation pending CTO: ship webhook + SSE in v1, skip WS.

### Persistence and replay

- Subscriptions stored in shared SQLite so they survive daemon restart.
- Events written to an `events` table with monotonic `seq`. Subscribers reconnect with `?since=<seq>` and the daemon replays missed events.
- TTL on event log (e.g. 7 days) to bound storage.

### Backpressure

- Per-subscription bounded outbox (e.g. 1000 events). Overflow drops oldest with a `dropped: N` marker so the consumer knows to do a full refetch.
- Webhook delivery: exponential backoff on 5xx, mark subscription `unhealthy` after N consecutive failures, surface in `/agents` admin view.

### Auth

- Same `X-Id-Team` / `X-Id-Admin` gating as `/remote`.
- Subscriptions are owned by the `from` field. Only the owner (or admin) can delete.

### Migration

- `/query/:id?wait=N` stays. New code uses subscriptions.
- `admin-control` skill gets a `subscribe.sh` helper that registers a webhook to the existing listener port.
- TUI's poll loop in `src/tui/api/manager.ts` switches to SSE in a follow-up.

## Open questions for CTO

1. Webhook + SSE both in v1, or pick one?
2. Event log: dedicated table or reuse the existing news table with a generalized schema?
3. Replay window: time-based (7d), count-based (last 10k), or both?
4. Should `query:delivered` events carry the full result payload, or just the queryId (consumer fetches)?
5. How does this interact with the planned scheduling system (`docs/SCHEDULING_PLAN.md`)? Is a wakeup an "internal subscription" the scheduler emits?
6. Auth for cross-team subscribers (e.g. a public dashboard subscribing to `idchain` events)?

## Out of scope for this design

- Replacing `/query` long-poll entirely (keep as compat).
- Push notifications to mobile / external services (separate layer on top of webhooks).
- Agent-to-agent direct push (already covered by `/talk-to`).

## Next steps

1. CTO claims `wakeup-service-design` task, produces design doc answering the open questions above.
2. Manager reviews + resolves open questions.
3. CTO breaks design into implementation tasks, dispatches to coder agents.

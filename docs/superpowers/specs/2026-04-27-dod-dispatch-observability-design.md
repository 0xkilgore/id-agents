# Definition of Done & Dispatch Observability — Design Spec

**Date:** 2026-04-27
**Status:** Approved (brainstorm) — ready for implementation plan
**Owner:** Manager (kilgore@m4)
**Project:** Agent platform reconstruction — Sub-project A (Observability & contracts)
**Brainstorm:** `~/Dropbox/Code/cane/id-agents/.superpowers/brainstorm/12070-1777302621/`

---

## 1. Background

The agent platform has reached a point where dispatched work routinely "completes" without producing observable output, and wedged agents go undetected for hours or days. Two recent incidents define the problem:

1. **Personal agent health import (2026-04-27):** Agent reported done after writing `runs.json` to disk, but `health.caneyfork.dev` still showed stale data because no `vercel --prod` ran. Files-on-disk passed for "done"; the user-visible surface did not.
2. **Sentinel wedge (2026-04-22 → 2026-04-27):** Sentinel agent process pinned in an unbounded `until ... sleep` Bash loop for 4.5 days (~6,500 iterations). The Desk banner reported a stale 3.0h age while the real value was 28h, because the renderer used a stored timestamp instead of computing current age.

Underlying both: there is no shared contract for **what "done" means**, and no system-level surface to **see what's in flight right now**.

This spec defines:
- A typed verification contract (`verify_signal`) embedded in the dispatch protocol
- A `dispatches` table as the single source of truth for in-flight work
- A primary HTML surface at `dashboard.caneyfork.dev/in-flight` and a secondary Desk summary
- A liveness watchdog that catches process death AND prompt-pinning wedges
- Two defense-in-depth fixes (Bash hard timeout, banner renderer)

---

## 2. Goals

- **Every dispatch has a verifiable Definition of Done** that does not rely on the agent's self-report.
- **Every in-flight dispatch is visible** in one place, refreshed live, with kill/retry actions.
- **Wedged agents are detected within minutes**, not days.
- **Drift after completion** (rollback, file deleted, deploy reverted) is caught by re-verification.
- **No new wedges from `until X; sleep` patterns** — bounded by a hard wall-clock timeout.

## 3. Non-Goals

- Formal SLAs / paging policy (deferred to operational rollout)
- Cost tracking / token accounting (separate sub-project)
- Replacing the existing `/tasks` endpoint or inbox.md (different scopes)
- Cross-agent dependency graphs (deferred)
- Authentication / multi-user (single-operator system)

---

## 4. Decisions Locked

| # | Decision | Choice |
|---|----------|--------|
| 1a | Who runs verification? | **Hybrid A+B** — agent self-verifies (fail-fast) + Sentinel re-verifies (drift catcher) |
| 1b | Where does the contract live? | **Dispatch protocol** — `verify_signal` field in `/agent-done` payload |
| 1c | Shape of `verify_signal` | **Typed schema, 5 types** — `http_get`, `file_mtime`, `desk_tag`, `api_call`, `all`. Default DoD when unspecified = `desk_tag` within 24h. |
| 2 | In-flight visibility | New **`dispatches`** table in `id-agents.db`. Primary surface: `dashboard.caneyfork.dev/in-flight` (HTML). Secondary: Desk "🚀 In flight" section. |
| 3 | Liveness watchdog | **Hybrid A+C** — external heartbeats (process-layer) + dispatch-stale watch. Plus Bash hard timeout + banner renderer fix. |

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Dispatchers — POST /dispatches first, then /talk                 │
│   Manager-direct  │  Cane poller  │  Scheduler  │  Agent → Agent │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ dispatches table (id-agents.db)                                  │
│   id · dispatched_at · from_actor · to_agent · channel · message │
│   query_id · status                                              │
│   responded_at · response · artifact_path                        │
│   verify_signal_json · verify_status · verify_last_checked       │
└──────────┬───────────────────────────────────┬───────────────────┘
           ↓                                   ↓
┌─────────────────────────┐         ┌─────────────────────────────┐
│ Target agent            │         │ Liveness watchdog (A+C)     │
│ 1. Receives /talk       │         │  6a heartbeat files (proc.) │
│ 2. Does the work        │         │  6b dispatch-stale watch    │
│ 3. Self-verifies        │         │  + Bash hard timeout        │
│ 4. POST /agent-done     │         │  + Banner renderer fix      │
│    + verify_signal      │         └─────────────────────────────┘
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│ Sentinel re-verifies    │
│ on schedule (drift)     │
└──────────┬──────────────┘
           ↓
┌──────────────────────────────────────────────────────────────────┐
│ Surfaces                                                         │
│   dashboard.caneyfork.dev/in-flight (primary, HTML, 30s refresh) │
│   Desk "🚀 In flight" section (secondary, markdown)              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Components

### 6.1 `dispatches` table (id-agents.db)

New SQLite table. One row per dispatched unit of work.

```sql
CREATE TABLE dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatched_at INTEGER NOT NULL,        -- unix epoch ms
  from_actor TEXT NOT NULL,              -- 'manager' | 'cane' | 'scheduler' | '<agent-name>'
  to_agent TEXT NOT NULL,                -- target agent name
  channel TEXT NOT NULL,                 -- 'talk' | 'schedule' | other
  message TEXT NOT NULL,                 -- the prompt sent
  query_id TEXT,                         -- existing inbox query_id if applicable
  status TEXT NOT NULL,                  -- 'queued' | 'in_flight' | 'done' | 'failed' | 'timeout' | 'wedged'
  responded_at INTEGER,                  -- unix epoch ms
  response TEXT,                         -- agent's reply text
  artifact_path TEXT,                    -- primary artifact file path
  verify_signal_json TEXT,               -- JSON blob, see 6.4
  verify_status TEXT,                    -- 'pending' | 'pass' | 'fail'
  verify_last_checked INTEGER,           -- unix epoch ms
  parent_dispatch_id INTEGER,            -- for agent→agent chains
  inbox_query_id TEXT,                   -- duplicate of query_id for reverse-lookup, indexed
  FOREIGN KEY (parent_dispatch_id) REFERENCES dispatches(id)
);

CREATE INDEX idx_dispatches_status ON dispatches(status);
CREATE INDEX idx_dispatches_to_agent ON dispatches(to_agent);
CREATE INDEX idx_dispatches_dispatched_at ON dispatches(dispatched_at);
CREATE INDEX idx_dispatches_verify_status ON dispatches(verify_status);
CREATE INDEX idx_dispatches_inbox_query_id ON dispatches(inbox_query_id);
```

**Lifecycle:**
- Row created at `POST /dispatches` (status = `queued`)
- Flips to `in_flight` when manager confirms the `/talk` POST returned 2xx
- Flips to `done` / `failed` on `/agent-done`
- Liveness watchdog flips to `timeout` or `wedged` based on age + heartbeat
- Sentinel updates `verify_status` and `verify_last_checked` on re-verify pass

### 6.2 `POST /dispatches` helper (manager)

New manager endpoint. Every dispatcher calls this **before** `/talk`.

**Request:**
```json
{
  "from_actor": "manager",
  "to_agent": "personal",
  "channel": "talk",
  "message": "...",
  "query_id": "query_1777299862188_2gijhpd",
  "verify_signal": { "type": "desk_tag", "artifact_path": "...", "within_hours": 24 },
  "parent_dispatch_id": null
}
```

**Response:**
```json
{ "dispatch_id": 4173, "status": "queued" }
```

The dispatcher then includes `dispatch_id` in its `/talk` payload so the agent knows which dispatch to close.

If `verify_signal` is omitted, the manager populates the **default DoD**: `{ "type": "desk_tag", "artifact_path": "<TBD by agent>", "within_hours": 24 }`. The agent supplies the path at `/agent-done` time.

### 6.3 Updated `/agent-done` payload

Existing endpoint, extended with two new fields:

```json
{
  "query_id": "query_1777299862188_2gijhpd",
  "dispatch_id": 4173,                                 // NEW
  "agent": "personal",
  "artifact_path": "/absolute/path/to/artifact.md",
  "tl_dr": "one-line summary",
  "urgency": "normal",
  "verify_signal": {                                   // NEW
    "type": "all",
    "checks": [
      { "type": "http_get", "url": "https://health.caneyfork.dev/run/2026-04-25", "must_contain": "26.76" },
      { "type": "desk_tag", "artifact_path": "...", "within_hours": 24 }
    ]
  }
}
```

The handler:
1. Looks up `dispatch_id`, sets `status = 'done'`, `responded_at = now`, persists `artifact_path` and `response`.
2. Runs each `verify_signal` check synchronously (fail-fast).
3. Sets `verify_status = 'pass' | 'fail'` and `verify_last_checked = now`.
4. Returns `{ ok: true, dispatch_id, verify_status, verify_failures: [...] }`.

A failed self-verify still marks `status = 'done'` (the agent claimed it finished) but `verify_status = 'fail'`. The dashboard surfaces this prominently.

### 6.4 `verify_signal` typed schema

Five types. No bash escape hatch (intentional — every check should be inspectable).

**`http_get`** — fetch a URL, optionally assert content. Used for live deploys.
```json
{ "type": "http_get", "url": "https://...", "must_contain": "string", "status": 200 }
```

**`file_mtime`** — file exists and has been modified after a timestamp.
```json
{ "type": "file_mtime", "path": "/absolute/path", "after": 1777299862 }
```

**`desk_tag`** — artifact path appears on Desk.md within `within_hours` of dispatch. The default DoD.
```json
{ "type": "desk_tag", "artifact_path": "/path/to/artifact.md", "within_hours": 24 }
```

**`api_call`** — a service-specific API check. Initial supported services: `gmail` (message_id present in sent), `resend` (delivery_id status), `telegram` (message_id present), `trello` (card_id exists), `vercel_deploy` (deployment_id ready).
```json
{ "type": "api_call", "service": "vercel_deploy", "check": "deployment_ready", "id": "dpl_xyz" }
```

**`all`** — composite, every nested check must pass.
```json
{ "type": "all", "checks": [ {...}, {...} ] }
```

**Default DoD:** When a dispatcher omits `verify_signal`, the system applies `desk_tag` within 24h. Catches Chris's "is it on my desk to read?" baseline.

### 6.5 Agent self-verification (fail-fast)

Each agent's CLAUDE.md gets a new closing instruction:

> Before calling `/agent-done`, run your `verify_signal` checks locally. If any check fails, fix it (re-run the deploy, re-tag the desk, etc.) before reporting done. Only call `/agent-done` once your own check passes.

The agent's own check is the cheapest fail-fast path — it catches "I forgot to deploy" while the agent still has context to fix it. If the agent reports done with a failing self-verify, that's a bug in the agent's logic and the dashboard surfaces it loudly.

### 6.6 Sentinel re-verification (drift catcher)

Sentinel gets a new periodic job (every 30 min, configurable). It walks rows where:
- `verify_status = 'pending'` (verify was never run), OR
- `verify_status = 'pass'` AND `verify_last_checked` older than `within_hours / 2` (stale)

For each row, re-runs `verify_signal_json`. Updates `verify_status` and `verify_last_checked`.

Catches:
- Vercel deploy reverted after success
- Desk file deleted or moved
- HTTP endpoint that was up at done-time but is now down
- File rolled back

Sentinel's report (already going to `~/Dropbox/Obsidian/sentinel/`) gets a new section: **"Verify drift since last sweep"** listing rows that flipped pass→fail.

### 6.7 Liveness watchdog (Hybrid A+C)

**6a — External heartbeat files (process-layer):**
- Each agent's `local-agent-server.js` (the launchd-managed Node process that fronts the LLM) touches `~/.id-agents/heartbeats/<agent>.heartbeat` every 60 seconds.
- This is a **process-layer** write — it does NOT come from inside the agent's prompt. That's the key invariant: a wedged LLM prompt cannot fake aliveness because the heartbeat is written by the wrapping Node process, not by anything the model emits.
- Watchdog flags any heartbeat older than 3 minutes (3× interval) as `process_dead`.
- If `local-agent-server.js` itself doesn't yet support this, ship a 30-line sidecar `heartbeat.sh` under launchd alongside the agent process.

**6b — Dispatch-stale watch:**
- For each row where `status = 'in_flight'`, compute `age = now - dispatched_at`.
- If `age > threshold_for_agent` (configurable, default 30 min for sentinel, 60 min for others), flip `status = 'wedged'`.
- This catches prompt-pinning wedges where the process is alive but the LLM is stuck in `until X; sleep`.

The two together give us coverage:
- 6a catches process death (e.g. crash, SIGKILL)
- 6b catches prompt pinning (today's sentinel bug)

### 6.8 Bash hard timeout (defense-in-depth)

The agent's Bash tool wrapper gets a hard wall-clock timeout per spawned child: SIGTERM after `BASH_HARD_TIMEOUT_SEC` (default 1800 = 30 min), SIGKILL 30s later. Prevents `until X; sleep` patterns from running forever even if the LLM forgets to bound them.

This is independent of 6b — 6b flags the dispatch as wedged so an operator notices; 6.8 actually frees the process so it can recover.

### 6.9 Banner renderer fix

Today the Desk banner stores a string like `"3.0h"` at write-time. On 2026-04-27 that string showed for 28 hours because the renderer never recomputed.

Fix: store `last_event_at` as a unix timestamp. At render time, compute `age = now - last_event_at`. Format on the fly (`<1m`, `5m`, `2.3h`, `1.4d`).

Trivial change, but it's the reason the wedge went undetected for so long. Bundled because it shares the watchdog's correctness goals.

### 6.10 Dashboard `dashboard.caneyfork.dev/in-flight`

Primary surface. Auto-refresh 30s. Sections:

- **Stats strip:** in-flight count, closed today, verify failed (24h), median latency, wedged (>30m).
- **Filter bar:** agent, status, time window, verify state, free-text message search.
- **Dispatch table:** Time · From · To · Message · Status · Verify · Duration · Action. Color-coded rows (red = wedged, blue = in-flight, gold = verify-fail). Status pills. Per-row Kill / Retry / View buttons.
- **Expanded row:** full message, response, artifact list, verify_signal JSON, sentinel last-checked timestamp.

Implementation: Next.js page in the existing `dashboard.caneyfork.dev` repo. Reads from `id-agents.db` over the existing internal API. Action buttons hit manager endpoints (`POST /dispatches/<id>/kill`, `POST /dispatches/<id>/retry`).

### 6.11 Desk "🚀 In flight" section

Secondary surface. Auto-generated when Desk refreshes. Top of file (above existing sections).

```
## 🚀 In flight  ·  3 dispatches  ·  1 wedged

- ⚠️ **finances** · 42m · taxyield Debank reconcile
- 🟦 **cleveland-park** · 15m · Mansouri vision doc
- 🟦 **sentinel** · 16m · 09:30 sweep

Last 3 closed:
- ✓ personal · 16m · health import → marathon visible
- ✗ cleveland-park · 8m · CPNA newsletter (verify failed)
- ✓ sentinel · 2m · 08:00 sweep

→ [Full dashboard](https://dashboard.caneyfork.dev/in-flight)
```

Generated by the existing Desk refresh job. Reads the same `dispatches` table.

---

## 7. Data flow — example dispatch

1. Chris asks manager to run a health import.
2. Manager constructs the dispatch and calls `POST /dispatches` with `verify_signal` = `{ type: "all", checks: [http_get, desk_tag] }`. Gets back `dispatch_id = 4173`. Row is `queued`.
3. Manager calls `POST http://localhost:4122/talk` to personal agent with the prompt + `dispatch_id`. Row flips to `in_flight`.
4. Personal agent reads CLAUDE.md, runs the import, deploys, verifies live URL, writes Desk tag.
5. Personal agent runs `verify_signal` locally — both checks pass.
6. Personal agent calls `POST /agent-done` with `dispatch_id`, `verify_signal`, `artifact_path`. Manager flips row to `done`, runs server-side verify (passes), sets `verify_status = 'pass'`.
7. Dashboard `/in-flight` page (open in Chris's browser) auto-refreshes 30s later, drops the row out of "in flight" and into "closed today / verified".
8. 30 min later, sentinel re-runs the check. Still passes. Updates `verify_last_checked`.
9. If at any point in step 4 the agent had crashed: 6a heartbeat would go stale → row flagged `wedged` by 6b at the 60m threshold → dashboard shows red. Chris hits Retry.

---

## 8. Out of scope (parked)

- **Cost / token accounting** per dispatch — useful, separate sub-project.
- **Cross-agent dependency graphs** (e.g. "this dispatch depends on dispatch #4170") — premature, revisit if needed.
- **Multi-user / auth** on the dashboard — single-operator, behind tunnel.
- **Verifier richness:** screenshot diff, semantic checks, LLM-judges — start with the 5 typed checks, expand only when the gap bites.
- **Migration of historical dispatches** — start fresh, don't backfill.
- **Slack/PagerDuty escalation** for wedged rows — Telegram nudge to Chris is the v1 escalation; richer paging can come later.

## 9. Filed for Prem (upstream)

These belong upstream in the agent-server framework, not in our local stack:

- `BASH_HARD_TIMEOUT_SEC` env var support in the agent server (6.8). Today our stack would have to wrap-shell every spawn.
- Process-layer heartbeat writes from `local-agent-server.js` (6a). Today we'd need a sidecar.
- Standard `/dispatches` and `/agent-done` hooks (so framework-level retries can flow into our table without shimming).

We can ship 6a and 6.8 as sidecars in v1; file feedback to Prem to fold them upstream.

---

## 10. Phasing

**Phase 1 — Schema + dispatch protocol (1–2 days)**
- 6.1 dispatches table migration
- 6.2 `POST /dispatches` endpoint
- 6.3 extended `/agent-done`
- 6.4 verify_signal types (server-side runner)
- Update one dispatcher (manager) and one agent (personal) end-to-end as the integration test.

**Phase 2 — Agent rollout (1–2 days)**
- 6.5 update each agent's CLAUDE.md with the self-verify instruction
- Wire the remaining dispatchers (cane poller, scheduler, agent→agent)
- Default DoD applied to omitted verify_signals

**Phase 3 — Sentinel re-verify + liveness (1 day)**
- 6.6 sentinel re-verify periodic job
- 6.7a heartbeat sidecar + launchd job per agent
- 6.7b dispatch-stale watch (cron, 1-min cadence)

**Phase 4 — Surfaces (1–2 days)**
- 6.10 dashboard `/in-flight` page
- 6.11 Desk in-flight section
- Kill / Retry endpoints

**Phase 5 — Defense-in-depth (0.5 day)**
- 6.8 Bash hard timeout sidecar
- 6.9 Banner renderer fix

Total: ~6–8 working days.

---

## 11. Success criteria

- Manager-direct dispatches after Phase 1 land a row in `dispatches`.
- After Phase 2, every dispatcher writes rows and every `/agent-done` carries a `verify_signal` (no nulls in the new column).
- After Phase 3, no wedged dispatch goes unflagged for more than 60 minutes.
- After Phase 4, `dashboard.caneyfork.dev/in-flight` is the place Chris looks when he asks "what's running right now?"
- After Phase 5, no agent process can pin on a runaway `until X; sleep`; the Desk banner age string stays accurate.

## 12. Risks

- **Verify_signal schema is too rigid for some workflows.** Mitigation: ship the 5 types, log which dispatches use the default DoD, expand only when a real workflow doesn't fit.
- **Sentinel re-verify creates load on external services** (e.g. hammering vercel API every 30 min). Mitigation: only re-verify rows whose `within_hours` window is still open; back off after pass.
- **Heartbeat sidecar adds complexity.** Mitigation: it's a 30-line shell script per agent. Documented and identical across agents.
- **Dashboard becomes the new "thing that's down."** Mitigation: Desk in-flight section is a fully readable fallback. Chris can always read Desk.md.

---

## 13. Open questions for implementation plan

(For writing-plans skill to address.)

- DB migration tool — straight SQL via existing migration runner, or new tooling?
- Heartbeat file location — `~/.id-agents/heartbeats/` or under the agent's working dir?
- Sentinel re-verify schedule — cron entry vs. launchd vs. inline scheduler?
- Dashboard auth — does the existing `dashboard.caneyfork.dev` already have a session check, or do we need one?
- Retry semantics — does Retry create a new dispatch row or re-open the old one? (Recommend: new row with `parent_dispatch_id` pointing at old.)

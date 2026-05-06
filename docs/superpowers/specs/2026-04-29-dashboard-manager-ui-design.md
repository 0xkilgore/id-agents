# Dashboard as Manager UI — Design Spec

**Date:** 2026-04-29
**Author:** manager (brainstorm with Chris, 2026-04-28 → 2026-04-29)
**Status:** revised 2026-04-30 after CTO bounce — patched two blocking issues (Section 4b stale dispatch fields + search execution contract). Ready for CTO re-review per Spec 054.
**Implementation phase:** Phase 1 (markdown stack). Vetra parallel build follows separately.

## Goal

Turn the dashboard from a passive status page into a glanceable surface that reflects the manager's current view of Chris's day. Solve three pains: the 26-item overdue dump, no snooze, artifact links that disappear after 24h. Make the dashboard the single place Chris glances to know what's happening, what's next, and what just shipped — without interrupting whatever he's actively doing.

## Framing

**The dashboard IS the manager's UI.** Not a chat window — a glanceable surface that surfaces the manager's current view of Chris's world. Refresh = "tell me what you see." Items come from manager synthesis, not raw queries. Curation is the dashboard's primary mode. Chat lives in Claude Code sessions; the dashboard is for "what's going on" without interrupting flow.

This frame anchors every design decision. If a feature pushes the dashboard toward chat-as-primary-interaction, it's wrong.

## Architecture (data-source-agnostic)

```
                 ┌─────────────────────────────┐
                 │   Manager (synthesizer)     │
                 │   - LLM call                │
                 │   - smart-triggered         │
                 │   - reads all state surfaces│
                 └────────┬────────────────────┘
                          │
                          ▼ produces
                 ┌─────────────────────────────┐
                 │    curation.json            │
                 │  - today_priorities[]       │
                 │  - triage_queue[]           │
                 │  - last_synthesized_at      │
                 │  - reasoning_per_item       │
                 └────────┬────────────────────┘
                          │
                          ▼ consumed by
                 ┌─────────────────────────────┐
                 │  build.py (existing M4)     │
                 │  merges into data.json      │
                 └────────┬────────────────────┘
                          │
                          ▼
                 ┌─────────────────────────────┐
                 │  Next.js dashboard renders  │
                 └─────────────────────────────┘
```

**Triggers for the manager call (smart triggering):**
- Morning, ~7:00 AM, alongside the existing morning digest cron
- Major state changes: ≥2 tasks marked done in 30 min, dispatch /agent-done callback fires, calendar event passes
- On-demand: refresh button on dashboard
- Maximum: ~5–10 calls/day, not 96 (avoid the every-15-min build trigger)

**State sources the manager reads:** taskview to-do.md files, dispatches table (Spec 053), recent /agent-done callbacks, calendar events for today (deferred to Phase 2 if not trivial), recent conversation context with manager. Inputs are summarized into the manager's prompt; the manager produces the JSON output.

**Cost optimization (Phase 2 candidate):** the curation call is non-interactive evaluation — strong candidate for a cheaper / open-source model (Haiku, Llama, etc.) once we validate output quality with the current Sonnet-class model. Document the swap path; do not implement it now.

**Data-source agnosticism:** architecture above works whether `curation.json` is produced from markdown sources (Phase 1) or from Vetra documents (Phase 2 / parallel track per [[agent-platform/ideas|agent-platform ideas]]). The curation output schema is durable; the read paths the manager uses can swap.

## Components

### 1. Curation pipeline (`build.py` + manager call)

- New module `dashboard_curation.py` (or equivalent) called from `build.py`.
- Constructs the manager prompt by reading: open tasks across all `to-do.md`, recent `dispatches` rows (Spec 053 SQLite), today's calendar (best-effort, skip if hard), recent /agent-done callbacks (last 24h), recent manager conversation summary.
- Calls manager `/talk` with a fixed curation prompt.
- Parses JSON response, writes `curation.json` to disk, kicks `data.json` rebuild.
- On manager error: keep last successful `curation.json`, surface staleness on the dashboard.

### 2. Today panel (top-of-page, primary surface)

**Location:** top of the main column, above existing widgets.

**Header:**
- `🎯 Today` (prominent)
- `↻` refresh icon (small, immediately right of header)
- "Last synthesized: <relative time>" subtle text below header

**Body:** 3–5 cards, priority-ordered. Manager picks the count based on state.

**Per card:**
- Title (bold, taken from underlying task or synthesized action)
- One-line reasoning ("standing weekly, you've skipped twice"; "Zach meeting at 2pm")
- Optional inline time-context badge (e.g., `Zach @ 2pm` pill) when manager identifies a hard deadline
- Per-card actions on hover (or always visible — implementation choice):
  - ✅ **Done** — marks underlying task done via existing `mutate.py` `todo` action
  - 💤 **Snooze** — opens menu (see below)
  - 📎 **Linked artifact** — visible only if the underlying dispatch has a delivered artifact (Phase 1.5 / Phase 2)
  - 💬 **Comment** — Phase 2, NOT in this spec
- Click on the card body opens a detail view (Phase 2 — for now, link to the underlying task file in Obsidian or no-op)

**Snooze menu:**
- One-click presets: `Tomorrow` / `Friday` / `Next Monday` / `1 week`
- `Custom date…` — opens date picker
- Implements via existing `mutate.py` `todo` `action: snooze` route — backend is already there
- After snooze: the card disappears from Today panel; the manager re-curates to fill the gap (call manager again with updated state, or include the snooze action as a "trigger" in the smart-trigger list and let the next run pick up)

**Card click-through:**
- Phase 1: optional, can be no-op or link to Obsidian to-do.md
- Phase 2: detail view with artifacts, comments, history

### 3. Triage queue (below Today panel, smaller surface)

**Location:** directly below the Today panel.

**Header:**
- `📋 Quick triage`
- Count badge: e.g., `3 items`

**Body:** 3–5 stale items per day, manager-suggested action per item.

**Per row:**
- Task title (compact, single line)
- Italic suggestion: `Looks done?` / `Snooze 2 weeks?` / `Stale — kill?` / `Re-prioritize?`
- 4 buttons matching the four resolution paths: `Done` · `Snooze` · `Kill` · `Keep`
  - **Done:** marks task done
  - **Snooze:** opens snooze menu (same as Today panel snooze)
  - **Kill:** removes the task entirely from to-do.md (use a soft-delete by appending `killed:YYYY-MM-DD` rather than hard delete, so audit trail survives)
  - **Keep:** dismisses the suggestion (manager won't re-suggest this item for ~7 days)

**Behavior:**
- One-click resolution per row
- Row animates out, next stale item from manager's queue slides in (or panel shrinks if queue is empty)
- Manager re-queries triage candidates on smart-trigger refresh

**Empty state ("you're caught up"):**
- When `triage_queue[]` is empty, render a celebratory empty state with character — not a bland "no items"
- Suggested approach: a small playful illustration / character (could be a simple SVG character, an emoji combo, or a rotating set of icons) plus a fun headline ("Inbox zero, vibes maximum" / "Backlog clean — go touch grass" / similar)
- Implementation can pick from a small rotating set so it doesn't get stale
- Visual character matters here — empty state is a frequent state and should feel rewarding, not blank

### 4. Refresh button (header on Today panel)

- Single `↻` icon button, immediately right of `🎯 Today` header
- Click → POSTs to `mutate.py` route `dispatch` with `agent: "manager"` and `message: "rerun curation"`
- UI shows spinner state while manager runs; panel updates when curation.json changes
- **No chat input.** Free-text "Ask the manager" is explicitly Phase 2. The dashboard is not a chat window.

### 4c. Waiting On panel (existing card, expanded scope)

**Problem this solves:** the existing "Waiting On" card in the bottom-right of the dashboard currently only tracks the manual `waiting-on` list (people Chris is waiting for). It doesn't show **in-flight agent dispatches** — so Chris has to ask "is X done?" rather than glance at the dashboard.

**Phase 1 scope:**
- Two sections in the existing Waiting On card:
  - **🤖 Agents** — auto-populated from the `dispatches` table (Spec 053). Every dispatch with status `pending` or `in_flight` shows here with: `to_agent` (agent name), truncated `message` (task title display), age computed from `dispatched_at` (e.g., "12m ago"), status dot (🟡 in flight, 🟢 done with `responded_at` < 24h ago, 🔴 in_flight with `dispatched_at` >2h ago = stuck)
  - **👥 People** — the existing manual waiting-on list, unchanged
- When a dispatch completes (`/agent-done` callback), the agent row stays for ~24h with 🟢 + "✓ Ready" + link to the artifact, then auto-clears
- Stuck dispatches (>2h with no `/agent-done`) get 🔴 + "Stuck — investigate" — surfaced for Chris's attention

**Why this matters:**
- Closes the loop on "did the manager actually dispatch that?" anxiety
- Surfaces stuck agents before Chris has to ask
- Makes the Waiting On card a real working surface, not just a manual reminder list

**Implementation notes:**
- Source of truth: `dispatches` table from Spec 053 (schema in `~/Dropbox/Code/cane/id-agents/src/db/migrations/sqlite.ts:150-168`). Actual columns: `id, team_id, dispatched_at, from_actor, to_agent, channel, message, query_id, status, responded_at, response, artifact_path, verify_signal_json, verify_status, verify_last_checked, verify_failures_json, parent_dispatch_id`.
- Render fields: `to_agent` (display as agent name), `message` (truncate to ~80 chars for task title display), `dispatched_at` (use for age calc), `status` (drive state dot — pending/in_flight = 🟡, done with `responded_at` recent = 🟢, status=in_flight with `dispatched_at` >2h ago = 🔴), `artifact_path` (link target on completion).
- Render path: `build.py` reads `SELECT id, to_agent, message, dispatched_at, status, responded_at, artifact_path FROM dispatches WHERE status IN ('pending','in_flight') OR responded_at > strftime('%s','now')-86400 ORDER BY dispatched_at DESC`, merges into `data.json`.
- Manual `waiting-on` list continues to use the existing `mutate.py` `waiting-on` route.

**Acceptance:**
- [ ] Waiting On card shows two sections: 🤖 Agents and 👥 People
- [ ] Agent section auto-populates from dispatches table
- [ ] Each agent row shows: agent name, task, age, status dot
- [ ] Completed dispatches stay for 24h with 🟢 + "✓ Ready" + artifact link, then auto-clear
- [ ] Stuck dispatches (>2h no /agent-done) show 🔴 + "Stuck — investigate"
- [ ] People section continues to work via existing mutate.py waiting-on route

### 4b. Search (top of dashboard)

**Problem this solves:** today, finding any past to-do, dispatch, or artifact requires grepping across Dropbox files manually. Tasks without due dates (or with stale ones) become invisible. This is a dashboard usability blocker.

**Phase 1 scope (markdown-stack search):**
- Single search input at the top of the dashboard (header bar level, above the Today panel)
- Placeholder text: "Search to-dos, dispatches, artifacts…"
- Submit (Enter or click) hits a new `/api/search?q=<query>` Vercel function
- Backend greps across three explicit sources:
  - `~/Dropbox/Code/*/to-do.md` (open + completed tasks) — file grep
  - SQLite `dispatches` table (Spec 053) — query against the **canonical Spec 053 columns**: `id`, `query_id`, `from_actor`, `to_agent`, `channel`, `status`, `dispatched_at`, `responded_at`, `message`, `response`, `artifact_path`, `verify_status`. The match-fields for free-text search are: `message`, `response`, `artifact_path`, `to_agent`, `from_actor`. Do NOT reference `task_title`, `agent`, `body`, `created_at`, `completed_at` — those columns do not exist in the live schema. Schema source of truth: [sqlite.ts:150-168](src/db/migrations/sqlite.ts:150).
  - `~/Dropbox/Code/cane/taskview/delivery-log.md` (artifact deliveries) — file grep
  - Optionally: `~/Dropbox/Obsidian/sentinel/*.md` (recent sentinel reports) — file grep
- Returns ranked results: source (to-do / dispatch / artifact), match snippet, last-touched date, link to source
- Results render in a panel below the search box (not a modal — keeps glance flow). Click result → opens the underlying file or jumps to the relevant Desk section.

**Backend execution contract (Phase 1):**

The current SSH bridge from Vercel→M4 is **hard-pinned to `mutate.py`** by design — the SSH `authorized_keys` line uses a `forced-command` directive that runs `mutate.py` regardless of what the client requested ([mutate.py:10](personal/dashboard/mutate.py:10)), and the client helper explicitly ignores argv because of this ([ssh.ts:7](personal/dashboard/app/api/_lib/ssh.ts:7)). Routing search through the same key without changes is structurally impossible.

Phase 1 introduces a **dispatch router** at the SSH boundary, replacing the direct `mutate.py` forced-command:

- **New M4 script:** `personal/dashboard/bridge.py` becomes the SSH forced-command target.
- **Routing logic:** `bridge.py` reads `$SSH_ORIGINAL_COMMAND` (set by OpenSSH when the client passes a command after the key), parses the first token, and dispatches:
  - `mutate <subcmd> <args...>` → exec `python3 mutate.py <subcmd> <args...>` (preserves legacy mutate routes: `todo`, `waiting-on`, `refresh`, `dispatch`)
  - `search <query>` → exec `python3 search.py <query>` (new read-only path)
  - empty `$SSH_ORIGINAL_COMMAND` (legacy clients pre-router-deploy) → exec `mutate.py` with no args, which preserves backward-compat for any client still hitting the old contract
  - any other first-token → exit 1 with "unknown route"
- **`authorized_keys` update:** the existing key's forced-command line on M4 changes from `command="…/mutate.py"` to `command="…/bridge.py"`. One-time deploy task. Client-side `ssh.ts` updated to PASS the command argv (no longer ignored).
- **`personal/dashboard/search.py`** (new): runs `ripgrep` over the named markdown source files + reads the SQLite `dispatches` table via `sqlite3` (read-only, `PRAGMA query_only=1`). Returns JSON: `{results: [{source, snippet, date, link}, ...], total: N}`.
- **Vercel side:** `GET /api/search?q=<query>` Vercel function SSHes with `bridge.py` as forced-command target, passing `search <query>` as the command. Same SSH key as today; no new credentials.
- **Why a router script, not separate keys:** single SSH key keeps key management simple, audit trail unified. Subcommand routing in `bridge.py` makes mutate-vs-read separation explicit and easy to extend later (e.g. `read-tasks`, `metrics`, etc.).
- **Read-only enforcement:** `search.py` opens SQLite with `mode=ro&immutable=1` URI flags and does not import any file-write modules. Audit-grep-able.

**Migration impact:** small one-time M4 deploy (update `authorized_keys` + add `bridge.py`/`search.py`). `mutate.py` itself stays untouched. Existing legacy clients without the router argv still work via the empty-`$SSH_ORIGINAL_COMMAND` fallback.

**Implementation notes:**
- Fuzzy match (substring + case-insensitive) is fine for v1. Don't over-engineer — no full-text indexing.
- Cache result for ~10 seconds to debounce typing.
- Empty query → no results displayed (don't show "everything").
- Limit results to top 20. Add "Show more" if needed.

**Why this is Phase 1, not Phase 2:**
- Search is the dashboard usability blocker users hit immediately after curation lands ("I see today's 5 items, but where's that other thing I added Monday?").
- Without search, even a great curation surface doesn't replace the "let me grep my files" muscle.
- Phase 2 Vetra search is fundamentally better (cross-document operation history, schema-aware) — but Phase 1 grep is good enough for ~80% of "where is that thing?" cases.

**Acceptance:**
- [ ] Search input renders at top of dashboard
- [ ] Typing + Enter returns results within ~2 seconds
- [ ] Results show source label (to-do / dispatch / artifact), match snippet, date, link
- [ ] Click on a result opens the underlying file or jumps to the relevant section
- [ ] Empty query renders no results panel
- [ ] Backend matches across to-do.md files, dispatches table, and delivery-log.md
- [ ] Results limited to top 20, with "Show more" option if applicable

### 5. Existing panels — keep / shrink / remove

| Panel | Status | Notes |
|-------|--------|-------|
| Workstreams (per-agent activity) | Keep | Slightly de-emphasized visually (smaller column or below the fold) |
| Calendar (mini) | Keep | Useful glance |
| Inbox | Keep, smaller | Source of incoming items, still glanceable |
| Recently completed | Keep | Useful for "did I do that?" check |
| 🆕 New artifacts (last 24h) | **Delete in Phase 2.** Keep for Phase 1 as a backstop. | Once artifact-on-task ships, this becomes redundant |
| "Show all overdue" link | **Replace with Triage queue.** Raw overdue dump moves behind a "Show full backlog" link that's hidden by default. | The raw dump is the current pain. Triage queue solves it. |

## Data flow (Phase 1 — markdown)

1. **Cron @ 7:00 AM** triggers `dashboard_curation.py`
2. `dashboard_curation.py` reads markdown sources + dispatches table → builds prompt
3. Manager `/talk` is called with the curation prompt
4. Manager returns JSON: `{ today_priorities: [...], triage_queue: [...], last_synthesized_at: ... }`
5. JSON written to `curation.json`
6. `build.py` runs (existing 15-min cycle, OR triggered by curation update)
7. `build.py` merges `curation.json` into `data.json`
8. Vercel rebuild & deploy
9. Next.js renders Today panel + Triage queue from `data.json`

**Smart-trigger paths:**
- Cron: same as above, kicked at 7am
- State-change: `mutate.py` (todo done/snooze) + `/agent-done` (artifact delivered) + scheduler (calendar event passed) all signal `dashboard_curation.py` to re-run via a small queue (debounced — don't fire 5 times in 30s)
- On-demand: refresh button → `mutate.py` `dispatch` route → manager → `dashboard_curation.py` runs → output cycle continues

## curation.json schema (durable)

```json
{
  "today_priorities": [
    {
      "id": "string",                    // stable ID (task slug or synthesized)
      "title": "string",                 // bold display
      "reasoning": "string",             // one-line explanation
      "time_context": "string|null",     // e.g., "Zach @ 2pm" or null
      "underlying_task": {               // optional, null for synthesized actions
        "project": "string",             // "trinity", "personal", etc.
        "match": "string"                // substring used by mutate.py done/snooze
      },
      "linked_artifact": {               // optional, Phase 1.5+
        "path": "string",
        "delivered_at": "iso8601"
      }
    }
  ],
  "triage_queue": [
    {
      "id": "string",
      "title": "string",
      "suggestion": "done|snooze|kill|keep",
      "suggestion_text": "string",       // "Looks done?", "Snooze 2 weeks?", etc.
      "underlying_task": {
        "project": "string",
        "match": "string"
      }
    }
  ],
  "last_synthesized_at": "iso8601",
  "manager_model": "string",             // for cost tracking
  "synthesis_duration_ms": "number"      // for perf monitoring
}
```

## Error handling

- **Manager call fails:** keep last successful `curation.json`, surface "Last synthesized 4h ago" as a warning indicator. After 24h+ of stale, render a degraded state and notify Chris.
- **Manager returns malformed JSON:** log full prompt+response to `/tmp/curation-error-<ts>.json`, keep last good curation, alert Chris via Telegram.
- **Manager returns empty `today_priorities`:** rare. Show "No priorities today — everything snoozed or done." with a refresh button.
- **Manager returns more than 5 items:** truncate to 5. Log warning.
- **Snooze action fails:** rollback UI, show error toast. Don't lose the action — let user retry.
- **Triage `Kill` action:** require a small confirmation (one-click confirm) since it's destructive. `Keep` should be the easy default for "not sure."

## Testing

- Unit tests for `dashboard_curation.py` prompt construction (deterministic given fixed inputs).
- Unit tests for `curation.json` schema validation.
- Integration test: full pipeline run with fixture taskview state, assert curation output matches expected shape.
- Manual test plan: verify each per-card action (done, snooze, click-through), each triage button (Done, Snooze, Kill, Keep), refresh button, empty triage state, manager-error fallback.
- Smoke test against live data once deployed: load page, confirm 3-5 priority items render, confirm triage queue renders, refresh updates timestamp.

## Phasing

### Phase 1 (this spec, ships on markdown stack)
1. Curation pipeline (`dashboard_curation.py`)
2. `curation.json` schema + persistence
3. UI: Today panel + Triage queue + Refresh button (no free-text)
4. Snooze backend wired to existing `mutate.py` snooze action
5. Smart triggers: morning cron, on-demand refresh, state-change (todo done, /agent-done)
6. Empty state with character for Triage queue
7. **Search** — `/api/search` endpoint + UI input top of dashboard, greps across to-do.md + dispatches table + delivery-log.md
8. **Waiting On panel — Agents section** — auto-populate from dispatches table (Spec 053), show in-flight + recently-completed (24h) + stuck (>2h)

### Phase 2 (separate spec, follows)
- Artifact-on-task UI (depends on Vetra parallel track for full payoff; markdown index works as Phase 1.5 stopgap)
- Free-text "Ask the manager" panel
- Task comments
- Calendar integration (gap-aware time hints)
- Card click-through detail view

### Out of scope (explicit non-features)
- Time-blocked schedule (Chris doesn't time-block; "When" is metadata, not a schedule)
- Chat-style interaction (dashboard is NOT a chat window)
- Pixel-perfect mockups (defer to implementation iteration)
- Cheaper-model swap (Phase 2 cost optimization)

## Acceptance criteria

- [ ] Today panel renders 3–5 priority items at top of dashboard, with bold titles, one-line reasoning, optional time-context badges
- [ ] Each Today card has working Done + Snooze actions
- [ ] Snooze menu shows presets (`Tomorrow / Friday / Next Monday / 1 week / Custom`) and each works (writes `snoozed:` tag to to-do.md via mutate.py)
- [ ] After Snooze, the card disappears and the manager re-curates within ~30s
- [ ] Triage queue renders 3–5 stale items below Today panel with manager-suggested actions
- [ ] Each triage row has 4 working buttons: Done, Snooze, Kill, Keep
- [ ] Empty triage state shows celebratory illustration + headline (not bland "no items")
- [ ] Refresh button triggers manager re-curation, panel updates within ~30s
- [ ] "Last synthesized" timestamp updates after each refresh
- [ ] Manager error path keeps last good curation, surfaces stale-warning indicator
- [ ] Curation runs auto-trigger on: morning cron (7:00 AM), todo done × 2, /agent-done callback, calendar event passing (best-effort)
- [ ] No free-text input on the dashboard (verify by inspection)
- [ ] Existing "Show all overdue" replaced with triage queue + hidden "Show full backlog" link
- [ ] All existing panels (Workstreams, Calendar, Inbox, Recently completed) still render

## Implementation notes

- The dashboard repo is at `/Users/kilgore/Dropbox/Code/personal/dashboard` (Next.js, builds via M4 launchd `com.kilgore.dashboard-build.plist`).
- `mutate.py` is the SSH forced-command bridge — already has `todo`, `dispatch`, `refresh` routes. New refresh button uses existing `dispatch` route. Snooze uses existing `todo` action.
- Curation runs need their own launchd entry (`com.kilgore.dashboard-curation.plist`) for the morning cron.
- State-change triggers: `mutate.py` post-action hook + `/agent-done` server hook + scheduler post-event hook each fire a debounced "curate now" signal. Implementation can use a simple file mtime + cron approach, or a dedicated daemon.
- Manager prompt template: separate file `dashboard_curation_prompt.md` so it can be iterated without code change.

## Out-of-scope but related

- Phase 0 Vetra brainstorm (separate session) will likely turn the dispatch chain into a Vetra document model. When it ships, the dashboard's artifact-on-task feature reads from Vetra documents instead of an SQLite mirror. The curation.json schema does not need to change.
- The poller-dies-daily structural concern (logged in [[agent-platform/ideas|agent-platform ideas]]) is upstream of dashboard reliability — when the poller dies, inbox state stales, and the manager curates against an outdated picture. Worth flagging in the Phase 2 cost-of-staleness analysis.

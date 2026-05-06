# ID Agents — Feedback & Suggestions for Premm

Weekly-ish log of observations, pain points, suggestions, and wins from running ID Agents as a daily driver. Intended to be shared with Premm at Friday check-ins to help shape the product.

**Setup context:**
- 11 agents deployed via `configs/kilgore-team.yaml`
- Manager on :4100, agents on :4120–4129 + vault-institutional on :4116
- Runtime: Claude Code CLI, Sonnet 4.6 across the team
- Two concurrent human-facing managers: one in the Claude Code IDE (code-focused) and one in the Claude app (triage/orchestration). See `reference_two_manager_architecture.md` in memory.

Format: entries dated newest-on-top, grouped by theme when natural.

---

## 2026-04-27

### Agents silently offline after manager restart — no auto-redeploy on boot

Discovered today the entire 11-agent team was offline. Manager (`:4100`) was up and reporting `{"status":"ok","agents":0}` — but no agent processes existed. Dispatches to the agents had been silently failing (curl exit 7, connection refused) for an unknown amount of time. Chris noticed via the dashboard right column showing every agent in red.

**Root cause:** there's no launchd plist that runs `npm run deploy -- --config configs/kilgore-team.yaml` (or the equivalent `POST /remote` deploy command) on boot. When the manager process restarts — reboot, crash, manual restart — the team doesn't come back. The agents are spawned as child processes the manager owns; if the manager dies they die, and nothing brings them back.

**Recovery was easy** (one curl to `/remote` with `/deploy configs/kilgore-team.yaml` redeployed all 11 in ~6s) but the silent failure mode is bad:
- No warning when agents disappear
- Dispatches just fail at the network layer with no actionable signal upstream
- Chris had to spot it visually on the dashboard

**Suggestions for the platform:**
1. **First-class supervision** — the manager should optionally re-spawn agents that died, or at minimum log a `manager.agents_missing` event when its config calls for N agents and there are fewer running.
2. **Boot script** — bundle a `launchctl`/`systemd` template with the manager so `npm run deploy` runs at host boot. Right now everyone has to roll their own and forget to.
3. **Dashboard signal** — the manager `/health` returns `agents: 0` happily. It should return a non-200 or a `degraded: true` flag when the running count diverges from the configured count.

Filing as a Roger spec on our side for the launchd plist; surfacing here because the silent-fail behavior is a platform issue, not a us issue.

---

### codex runtime fully wired as a first-class harness type (Spec 054 shipped)

Today we deployed the first non-`claude-code-cli` agent on our team: a **Codex CLI agent** (`runtime: codex`) acting as our CTO — reviews specs before plans get written, writes plans, reviews Roger's output. Lives at port 4149, working dir `~/Dropbox/Code/cto/`, ChatGPT OAuth auth via `~/.codex/auth.json`. AGENTS.md (Codex's CLAUDE.md equivalent) drives the persona.

**What worked:**
- The `runtime: codex` switch in `kilgore-team.yaml` was clean — no harness changes needed on our end, the platform handled it.
- Smoke test came back with a real architectural BOUNCED response on a deliberately bad spec — Codex actually read the codebase before answering. Good signal that the working-directory + AGENTS.md plumbing works for non-Claude harnesses.

**Friction worth flagging:**
- The `cane deliver` callback for closing dispatch loops assumed a Claude-flavored `/agent-done` payload. Codex needed identical wire format but no Codex-specific examples existed in the docs we found. Adding a "non-Claude runtimes use the same agent-done contract" note somewhere obvious would have saved an iteration.
- Skill loading: the `superpowers` skills deploy to `.claude/skills/` for claude-code-cli and `.agents/skills/` for codex. We had to manually mirror our writing-plans/brainstorming skills into the codex working dir. A platform-level "deploy these skills to all runtimes" affordance would help — especially for cross-cutting protocol skills that should apply to every agent regardless of runtime.

Net: the multi-runtime story is real and works, but the docs/affordances assume claude-code-cli and the user has to figure out the rest.

---

## 2026-04-21

### Root cause: `GET /tasks` 404 is shadowed by a wildcard route registered earlier

Follow-up to the 2026-04-20 entry below. Found the offender in a code read — `dist/agent-manager-db.js:2230`:

```js
// Handle /:tokenId without trailing path - returns agent info
// NOTE: Must be defined BEFORE the wildcard route to take precedence
this.managementApp.get('/:tokenId', async (req, res) => {
    const tokenIdParam = req.params.tokenId;
    if (!/^\d+$/.test(tokenIdParam)) {
        return res.status(404).json({ error: 'Not found' });
    }
    ...
});
```

That `GET /:tokenId` handler is registered at line 2230, BEFORE `GET /tasks` at line 2361. Express matches the wildcard first, sees that `"tasks"` isn't a numeric tokenId, and returns `{error: 'Not found'}`. The `/tasks` handler is never reached.

Confirmed by sibling routes: `POST /tasks` (201 ok), `GET /tasks/:ref` (200 ok), `DELETE /tasks/:ref` (200 ok) — only `GET /tasks` list is shadowed because it's the only GET that collides with the single-segment numeric-tokenId wildcard.

Suggested fix: move `GET /:tokenId` to the bottom of `setupRoutes()` (where the existing `// Must be defined BEFORE the wildcard route` comment implies it should be). Or guard with `\d+` in the route pattern itself: `this.managementApp.get('/:tokenId(\\d+)', ...)`.

### Calendar scheduler has never actually fired (confirmed via DB)

Queried `schedule_runs` after a clean restart. Results:
- 255 heartbeat rows in the table (24h window)
- **0 calendar rows** — ever
- 8 active `calendar` entries in `schedule_definitions` (sentinel 10am/12pm/2pm/4pm M-F, etc.)
- Heartbeats fire every ~10 min per agent like clockwork

So the earlier write-up — "stopped Sunday 13:00" — was wrong. The calendar scheduler has not fired in the 24h history we can see, possibly longer. The fact that Sunday 13:00 and Monday 10am reports exist in `~/Dropbox/Obsidian/sentinel/` suggests those were hand-dispatched, not calendar-fired.

The scheduler tick is alive (heartbeats prove it). But calendar kind is being skipped. Suggest Premm add a log line to the scheduler's decision step ("kind=calendar, due=?, last_fired=?, skip=?") so an operator can see why a calendar isn't firing.

### Manager restart docs are wrong in our setup log

`SETUP_LOG.md` has `npm run deploy -- --config configs/kilgore-team.yaml`. That script doesn't exist in `package.json`. The actual bootstrap is the interactive CLI's `/deploy configs/kilgore-team.yaml` (reads yaml, POSTs `/agents/spawn` for each entry, spawns `local-agent-server.js` subprocesses). When doing it headless, we had to iterate the already-registered `/agents` payload and spawn the subprocesses by hand with the exact CLI from `ps aux`:

```
node dist/local-agent-server.js <name> --team default --port <port> --id <agent_id> --dir <workingDir>
```

Manager doesn't spawn subprocesses on its own startup — it only re-adopts them if they're already running. A cold-start after machine reboot therefore requires the interactive CLI's `/deploy` OR a documented headless equivalent. Suggest Premm add `node dist/deploy.js <config>` or `--auto-deploy` flag on `start-agent-manager.js`.

---

## 2026-04-20

### Bug: `GET /tasks` returns 404 even though route is registered  *(root-caused above, 2026-04-21)*

Source at `dist/agent-manager-db.js:2361` clearly registers `this.managementApp.get('/tasks', ...)`. `POST /tasks` works (returns 201). `GET /tasks?team=default` returns the generic `{"error":"Not found"}` 404. Tried with `x-id-team: default` header, query param, and a direct exact path — all 404. Manager was restarted cleanly on 0.1.58-beta at 13:43 CT today with the env-sanitize trick from my Apr 17 note.

Not blocking — we can use `POST /tasks` to create entries and query SQLite directly for listing. But it prevents any external tool (or orchestrator) from observing the task queue via HTTP, which is exactly what the task-lifecycle pattern wants to enable.

### Scheduler silently stopped firing Sunday 13:00 → detected only by missed Monday 10am report

23 hours of dead scheduler before we noticed. Manager process alive, `/health` green, `schedule_runs` table just stopped getting new rows. Manager log file stopped being written at the exact same timestamp as the last fire. No error, no trace.

Suspecting the 30s tick loop got into a promise-rejection state that swallowed the exception. We don't know. The fix was "restart the manager with the env-sanitize trick" and fires resumed immediately.

**Suggestion:** (a) add an unhandled-rejection handler at the top of `scheduler-service.ts` that logs and re-throws (or at least logs loudly); (b) expose a `/schedules/health` endpoint that returns "last fire N seconds ago" so external monitors don't have to hit SQLite directly; (c) consider a watchdog inside the manager that restarts the scheduler tick if it hasn't run in 2× expected interval.

We're building Spec 031 (external scheduler liveness monitor) to catch this next time — but that's a workaround, not a fix.

### Starting to use `/tasks` lifecycle via orchestration

For context: we've been dispatching work via `/talk` and reading `/news` free-text to track state. Starting today we're flipping to task-first: orchestrator creates a task, agents claim/done, observability comes from the task table. First two experiments tonight are specs 030 + 031 which each include the new handoff-chain template. Will report back what breaks.

---

## 2026-04-17 (late)

### 🚨 Manager inherits parent process auth — silently breaks spawned agents

This one cost an evening. While upgrading 0.1.36-beta → 0.1.58-beta, I restarted `start-agent-manager.js` from inside a Claude Code CLI session. The manager started fine. `/sync` reported all 10 agents as "running". Health checks passed. Sentinel's next scheduled fire produced a report.

But *any new `/talk` dispatch* returned:

```
Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}
```

Spent ~an hour tracing it. Every agent was 401. Fantasy-baseball check-in, Liz Job Scout re-dispatch, Cleveland Park agent — all silently 401'd into the void. Sentinel 16:00 report landed because the scheduler only needed to *fire* — its own work succeeded against a cached auth context that later expired.

**Root cause.** I launched the manager from a Claude Code session whose env had:
- `CLAUDE_CODE_OAUTH_TOKEN` — session-scoped OAuth, not durable
- `ANTHROPIC_API_KEY` — empty
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` — forces "host-managed" provider path
- `CLAUDE_CODE_ENTRYPOINT` — marks child `claude` invocations as "inside a parent session"

The manager passed these down. Spawned `local-agent-server.js` children passed them to their own `claude` CLI children. Each child tried to auth with a session-scoped OAuth token not valid for spawning *new* Claude CLI invocations outside the originating session. 401.

**Fix that worked:**

```bash
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST \
    -u CLAUDE_AGENT_SDK_VERSION \
    nohup node dist/start-agent-manager.js > /tmp/id-agents-manager.log 2>&1 &
```

Stripping those env vars let spawned agents fall back to the durable keychain. Instant success — agents answering in under 20s.

**Suggestions for Premm:**

1. **Detect-and-warn at manager boot.** If the manager sees `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_ENTRYPOINT` in its env, it's almost certainly being spawned from inside another Claude Code session. Log a WARNING: "Manager inherited a parent Claude Code session's auth context. Spawned agents will likely 401. Restart with a clean env." Would have saved me an hour.
2. **Sanitize env on child spawn.** When `local-agent-server.js` is launched, actively strip `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` from the spawned env so the child `claude` CLI authenticates cleanly against the durable keychain. Defensive measure against the exact failure mode above.
3. **Health check should test auth, not just connectivity.** `GET /health` returns `status:ok` even when every spawned agent is 401'ing. A deeper "can this agent actually complete a trivial query" check — run on demand, not every 30s — would let `/sync` or a new `/verify` command surface auth failures at deploy time instead of at first real use.
4. **/sync hides per-agent failure.** `/sync` returned "Added 0, updated 10, removed 0, unchanged 0" during the broken period. Nothing in that summary suggested the agents were dead on arrival. Consider a post-sync smoke test that dispatches a trivial prompt to each agent and reports which succeed.
5. **Mark `git stash -u` as dangerous in the upgrade docs.** My upgrade path today was: `git stash -u` before pulling. That swept up `SETUP_LOG.md`, `feedback-for-prem.md`, `configs/kilgore-team.yaml`, and several other personal untracked docs into the stash. Had to manually recover from `stash@{0}^3`. The upgrade guide should recommend plain `git stash` (no `-u`) or explicitly name files.

### Separately: upstream dep bug at 0.1.58

`package.json` lists `@xmtp/agent-sdk` but `src/xmtp/ows-signer.ts` imports `@xmtp/node-sdk`. Build fails with `Cannot find module '@xmtp/node-sdk'`. Worked around with `pnpm add -D @xmtp/node-sdk` — 6.0.0 resolved clean. Either the dep was renamed upstream and the source didn't catch up, or vice versa.

Also had to rebuild `better-sqlite3` (Node 23 / native module mismatch) via the in-module `npm run install`. `pnpm rebuild` was blocked by the pnpm auto-approve-builds prompt which is interactive-only. Consider documenting a non-interactive rebuild path for CI and scripted upgrades.

---

## 2026-04-17

### Friction: schedule-seeded instructions silently override agent CLAUDE.md

Today's 10am Sentinel report was missing from the expected folder (`~/Dropbox/Obsidian/sentinel/`). Investigation:

- Scheduler was firing correctly — `schedule_runs` rows marked `sent` on time (Apr 16 14:00, 16:00, Apr 17 10:00).
- Agent was responding — `/news` endpoint showed the query completed with a normal report body.
- Reports were landing at `~/Dropbox/Obsidian/sentinel-report-<date>-<time>.md` (vault root) instead of `~/Dropbox/Obsidian/sentinel/sentinel-report-<date>-<time>.md` (subfolder).

**Root cause:** Sentinel's own CLAUDE.md says write to `Obsidian/sentinel/...` subfolder. But the calendar schedule row seeded when the agent was deployed (via `kilgore-team.yaml`) had a `message` field saying `save report to ~/Dropbox/Obsidian/sentinel-report-{date}-{time}.md` (no subfolder). The schedule message won — the agent obediently followed the per-invocation instruction over its own long-lived CLAUDE.md.

Three reports drifted before I noticed (Apr 16 14:00, 16:00, Apr 17 10:00). Fixed by:
1. Moving the three misrouted files into `Obsidian/sentinel/`.
2. `UPDATE schedule_definitions SET message = REPLACE(message, 'Obsidian/sentinel-report-', 'Obsidian/sentinel/sentinel-report-') WHERE title = 'Calendar: sentinel';` against `~/.id-agents/id-agents.db`.

**Suggestions for Premm:**
- **Warn or refuse** when a schedule message contradicts the agent's own CLAUDE.md conventions — or at minimum, surface the schedule's full message somewhere easy to audit. Right now the only way to see what instruction the agent is actually getting every 2 hours is to query the SQLite DB.
- **Round-trip the schedule message through deploy/`/sync`** — today, editing `kilgore-team.yaml` doesn't re-seed the calendar row's `message` once it exists (to preserve anchors). That's correct for intervals, but means message text drifts from config silently. A `sync --resend-messages` or similar would let users edit the authoritative message in YAML.
- **Expose `schedule_runs` via manager HTTP** — there's no way today to see "did the 10am run fire?" without sqlite3. A `/schedules/runs?since=...` endpoint (or inclusion in the existing agent status) would have shortcut the whole investigation.
- **Path convention drift is a surface-level symptom of a bigger thing** — agent CLAUDE.md is a contract; schedule messages are a contract; config file is a contract; they all go out-of-sync independently. Worth thinking about one canonical place that wins when they disagree.

### Spec infra: logging + observability gaps

Also noticed while debugging above: no top-level log of schedule fire events in stdout of the manager, no dashboard for schedule health, no visible "last N reports" surface. These would pay for themselves quickly once the system has >5 scheduled calendars.

---

## 2026-04-16

### Architecture / discovery

- **Catalog discovery is the idiomatic pattern** — confirmed today. When writing spec 024 (Cane routes CPNA email to cleveland-park agent), the first open question was "hardcode port 4124 or use the catalog?" Catalog won. The inter-agent skill's `$MANAGER_URL/agents` endpoint returns the live list with ports, so any spec that needs to dispatch across the team should look up targets at runtime, not in config. **Suggestion for Premm:** could this be made even more ergonomic? A one-line helper like `inter_agent.talk_to("cleveland-park", msg)` that hides the catalog lookup would reduce boilerplate. Right now every agent needs the curl pattern.

### Spec management

- **Stale specs folder problem.** Found duplicate Roger specs split between `~/Code/roger/specs/` and `~/Dropbox/Code/roger/specs/`. The Dropbox path is the canonical one (working directory for the Roger agent). The `~/Code/` path appears to be an old non-Dropbox folder left from before project reorganization. Reconciling by deleting stale copies. **Suggestion for Premm:** agents should probably refuse to write to paths outside their configured workingDirectory, or at minimum log a warning. This would prevent future drift.

### Human ergonomics

- **Two-manager pattern works better than expected.** IDE-manager handles code + ID Agents infra; app-manager handles triage, planning, inbox processing, non-code delegation. They share state via Dropbox-synced files (taskview `to-do.md`, Sentinel reports in Obsidian, SETUP_LOG.md). No direct inter-manager messaging needed. Considering promoting the app-manager to a proper ID Agents agent (registered on e.g. 4110) if coordination friction emerges.
- **Desk-driven surface works.** We standardized that every agent deliverable lands on `~/Dropbox/Obsidian/Desk.md` (renamed from `Dashboard.md` 2026-04-24 to avoid collision with the `dashboard.caneyfork.dev` web app) with a NEW tag + one-liner. This pattern made the 2-manager flow tractable — both managers update the same Desk, both agents write deliverables into folders the Desk links to.

### Friction points

- **`/talk-to` timeout tuning.** Long-running dispatches (spec writing, research reports with web fetches) sometimes need 5-10 min. The default curl timeout bit us once. Would be nice to have clearer conventions or a pattern for "this is a long task, please persist and come back when done." Maybe queue/poll pattern built in?
- **Port hardcoding trap.** Spec 024's first draft hardcoded 4124 for cleveland-park. Catalog discovery wasn't obvious until asked. **Suggestion:** when `inter-agent` skill loads, maybe show discovered peers with their current ports so Claude in each agent has that context baked in.
- **`/sync` upgrade coming (0.1.43-beta)** — will test tomorrow. Expectation: `/sync` reconciles running team with config (adds new, rebuilds changed, leaves rest, preserves sessions). If that works reliably, dropping `/deploy` for most workflows.

### Wins

- **Spec pipeline is smooth.** Manager dispatches to a domain agent → agent writes spec to `roger/specs/NNN-*.md` → IDE-manager hands to Roger → Roger implements. Three-layer split (manager routes, domain agent specs, Roger builds) feels right. Catches a lot of "Roger is implementing the wrong thing" errors that would happen if specs were shorter.
- **Background dispatch works.** `run_in_background` on curl + checking the task output file later means long specs don't block the human conversation. This was unlocked once we had Anthropic's background task pattern — worth making first-class in ID Agents maybe.

---

## Parking lot / open threads to revisit

- Heartbeats — agents should ping-in regularly so Sentinel can tell if one has gone stale. Not wired yet.
- Voice → agent routing — when Chris records a voice memo for a specific project, should it auto-route to that agent's inbox instead of a central queue? Would need speaker/content classification in the Whisper pipeline.
- Public vs. private infra enforcement — new policy (see `feedback_public_private_infra.md` in memory): public projects get their own Turso DB, never touch Supabase. Would be nice if ID Agents had a way to tag agents with a "security zone" so infra access is constrained by role.
- Replacing remaining launchd jobs with ID Agents calendar schedules once `/sync` is reliable.

---

## Template for new weekly entries

```
## YYYY-MM-DD

### Theme 1 (Architecture / Discovery / Specs / Wins / etc.)
- Observation + suggestion

### Theme 2
- Observation + suggestion
```

Keep entries tight. One or two sentences per observation, plus a concrete suggestion if there is one. Don't dump; curate.

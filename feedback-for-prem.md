# ID Agents — Feedback & Suggestions for Prem

Weekly-ish log of observations, pain points, suggestions, and wins from running ID Agents as a daily driver. Intended to be shared with Prem at Friday check-ins to help shape the product.

**Setup context:**
- 11 agents deployed via `configs/kilgore-team.yaml`
- Manager on :4100, agents on :4120–4129 + vault-institutional on :4116
- Runtime: Claude Code CLI, Sonnet 4.6 across the team
- Two concurrent human-facing managers: one in the Claude Code IDE (code-focused) and one in the Claude app (triage/orchestration). See `reference_two_manager_architecture.md` in memory.

Format: entries dated newest-on-top, grouped by theme when natural.

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

**Suggestions for Prem:**
- **Warn or refuse** when a schedule message contradicts the agent's own CLAUDE.md conventions — or at minimum, surface the schedule's full message somewhere easy to audit. Right now the only way to see what instruction the agent is actually getting every 2 hours is to query the SQLite DB.
- **Round-trip the schedule message through deploy/`/sync`** — today, editing `kilgore-team.yaml` doesn't re-seed the calendar row's `message` once it exists (to preserve anchors). That's correct for intervals, but means message text drifts from config silently. A `sync --resend-messages` or similar would let users edit the authoritative message in YAML.
- **Expose `schedule_runs` via manager HTTP** — there's no way today to see "did the 10am run fire?" without sqlite3. A `/schedules/runs?since=...` endpoint (or inclusion in the existing agent status) would have shortcut the whole investigation.
- **Path convention drift is a surface-level symptom of a bigger thing** — agent CLAUDE.md is a contract; schedule messages are a contract; config file is a contract; they all go out-of-sync independently. Worth thinking about one canonical place that wins when they disagree.

### Spec infra: logging + observability gaps

Also noticed while debugging above: no top-level log of schedule fire events in stdout of the manager, no dashboard for schedule health, no visible "last N reports" surface. These would pay for themselves quickly once the system has >5 scheduled calendars.

---

## 2026-04-16

### Architecture / discovery

- **Catalog discovery is the idiomatic pattern** — confirmed today. When writing spec 024 (Cane routes CPNA email to cleveland-park agent), the first open question was "hardcode port 4124 or use the catalog?" Catalog won. The inter-agent skill's `$MANAGER_URL/agents` endpoint returns the live list with ports, so any spec that needs to dispatch across the team should look up targets at runtime, not in config. **Suggestion for Prem:** could this be made even more ergonomic? A one-line helper like `inter_agent.talk_to("cleveland-park", msg)` that hides the catalog lookup would reduce boilerplate. Right now every agent needs the curl pattern.

### Spec management

- **Stale specs folder problem.** Found duplicate Roger specs split between `~/Code/roger/specs/` and `~/Dropbox/Code/roger/specs/`. The Dropbox path is the canonical one (working directory for the Roger agent). The `~/Code/` path appears to be an old non-Dropbox folder left from before project reorganization. Reconciling by deleting stale copies. **Suggestion for Prem:** agents should probably refuse to write to paths outside their configured workingDirectory, or at minimum log a warning. This would prevent future drift.

### Human ergonomics

- **Two-manager pattern works better than expected.** IDE-manager handles code + ID Agents infra; app-manager handles triage, planning, inbox processing, non-code delegation. They share state via Dropbox-synced files (taskview `to-do.md`, Sentinel reports in Obsidian, SETUP_LOG.md). No direct inter-manager messaging needed. Considering promoting the app-manager to a proper ID Agents agent (registered on e.g. 4110) if coordination friction emerges.
- **Dashboard-driven surface works.** We standardized that every agent deliverable lands on `~/Dropbox/Obsidian/Dashboard.md` with a NEW tag + one-liner. This pattern made the 2-manager flow tractable — both managers update the same Dashboard, both agents write deliverables into folders the Dashboard links to.

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

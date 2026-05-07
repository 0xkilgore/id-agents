# ID Agents — Feedback & Suggestions for Prem

Weekly-ish log of observations, pain points, suggestions, and wins from running ID Agents as a daily driver. Intended to be shared with Prem at Friday check-ins to help shape the product.

**Setup context:**
- 11 agents deployed via `configs/kilgore-team.yaml`
- Manager on :4100, agents on :4120–4129 + vault-institutional on :4116
- Runtime: Claude Code CLI, Sonnet 4.6 across the team
- Two concurrent human-facing managers: one in the Claude Code IDE (code-focused) and one in the Claude app (triage/orchestration). See `reference_two_manager_architecture.md` in memory.

Format: entries dated newest-on-top, grouped by theme when natural.

---

## 2026-05-06

### (Meeting follow-ups appended after 1:1 with Prem on 2026-05-06; entries above this header are pre-meeting)

### Vetra integration — open strategic question, Prem can't engage yet

Surfaced during the call (~41:14): Chris's CTO is wrestling with whether to bolt a Vetra-shaped (Powerhouse document-model) shadow onto the manager's existing dispatch handlers. Prem's response was "Problem is I don't know about Vetra." Net effect: every cross-cutting design that benefits from typed-op + ops-history primitives (Spec 062 Desk format, Spec 064 testing agent, Spec 065 logger agent, Spec 066 transcription primitive) is being driven through Roger from Chris's side, with no input from Prem on whether it should land in ID Agents proper.

**Suggestion:** if/when the Vetra dispatch beachhead validates in dogfood, schedule a 30-min Vetra primer with Prem so he can opine on whether ID Agents should adopt typed-op-on-document-model as a native primitive. Otherwise the integration stays one-sided and Chris carries the architecture decision alone.

### Snapshot endpoint — Prem committed during the call

New feature commit (~1:05:16, 1:11:48): a standardized snapshot endpoint that returns markdown + graphs of last-N-period state, intended to be consumed by manager-side scheduled tasks for emails / dashboards / morning briefings. Prem's framing: "what's come out of this call so far."

**Suggestion:** the snapshot's data contract should be specified upfront, before Prem locks in v0. The dashboard and Cane already consume specific fields (agent list, recent dispatches, news, queue depth, schedule_runs, usage where available, heartbeat freshness). A one-pager listing these would let Prem build to known consumption rather than guessing, and would make the v0 immediately useful instead of round-trip-needed.

### Cross-device manager / sync model — open thread, no resolution

Chris floated the multi-device manager use case (~40:38): primary manager on the desktop, Codex manager elsewhere, mobile dashboard checking off to-dos that sync back. Prem confirmed "anything coming through the remote endpoint is a manager" but didn't address state-sync semantics across multiple devices. As more of Chris's life moves to ID-Agents-as-coordinator, this becomes load-bearing.

**Suggestion:** define what's local-first vs synced vs intentionally ephemeral in the manager-state model. The ENS-as-agent-id thread Chris raised (~23:13) is the long-term answer; in the short term, even a one-paragraph statement of "tasks sync via this surface; news doesn't; dispatches do via X" would prevent silent drift.

### Brittle-upstream-deps stance shapes what features land

Prem repeatedly flagged unwillingness to bake brittle upstream tool dependencies into ID Agents (~1:11:04: won't read Cloud Code's `/usage` flag because Anthropic might change it; 1:11:54: "tap into a bunch of systems and APIs and then they all break, that's not good"). This is a useful design constraint but it shapes the realistic shape of the per-agent-token-attribution ask in the entry below.

**Suggestion:** any feature ask that depends on an upstream tool's introspection surface needs a "what if this goes away in 60 days" answer baked in. For per-agent token attribution specifically, the durable path is logging tokens at dispatch-completion time using values the manager already controls (e.g. counting characters in/out, model-name-tagged), not parsing `/usage`. Worth noting in the suggestion.

### Power-user vs NFT roadmap-split should be visible

Prem's gating filter for ID Agents users is "do you have a Cloud Code Max or Codex subscription?" (~1:01:14). His funding/business-model bet is the Normies NFT project at ~$4/mo per hosted agent (~1:02:24). Two genuinely different audiences with overlapping but non-identical feature needs: power-user open-source primitives (Chris, Yodel friend, Namespace friend) vs NFT-hosted-character-agents (thousands of users, each with a knowledge base + MCP endpoint).

**Suggestion:** a "this serves Bucket A vs Bucket B" tag on Prem's roadmap (or even just on Twitter/changelog announcements) would help power users understand whether their feedback is on or off the active path. Without it, power-user feedback feels like it might be deprioritized for NFT-shaped features without warning.

---

### Dashboard UI built on top of ID Agents TUI

Built `dashboard.caneyfork.dev` — a Next.js operator dashboard reading from ID Agents manager API, taskview, and Cane. Visual fleet overview, agent detail with dispatch timelines, today/triage panels, inbox. Phase 2 polish in flight (Geist font, tighter layout, usage donut chart, clickable items).

**Suggestion:** the dashboard proves demand for a visual layer on top of the TUI. Consider whether ID Agents should ship a minimal web dashboard or expose better HTTP surfaces for third-party dashboards. Current `/agents` endpoint is great; `/news` is useful but polling-based. A WebSocket or SSE feed of agent events would make real-time dashboards much easier.

### CTO review-before-build routing (Spec 054)

Added a formal CTO review step: brainstorm-originated builds go through CTO spec review → plan writing → Roger builds → CTO output review. Caught stale field names, missing execution contracts before burning Roger cycles.

**Suggestion:** ID Agents could support a "review gate" pattern natively — before a dispatch reaches the target agent, it passes through a reviewer agent. Currently manual curl chains. A declarative `review_gate: cto` on agent config would be cleaner.

### Per-agent token usage attribution

Fleet-bar shows aggregate Claude/Codex usage but no per-agent breakdown. When an agent runs away, no easy way to see which one burned the budget.

**Suggestion:** expose per-agent token/cost attribution. Manager already knows which agent handled which query — surfacing cumulative token counts per agent in `/agents` response would be low-effort, high-value.

### Spec iteration bounce loops

Dispatch beachhead spec went through 3 CTO bounce/revise rounds. Each round = 5-10 min Codex time. Friction isn't the review — it's no way to see "bounced 3 times" without reading full /news log.

**Suggestion:** dispatch metadata could track `attempt_count` or `bounce_history` so manager sees iteration depth at a glance.

### Heartbeat liveness gap (Spec 049)

Sentinel monitors agent health by watching `inbox.md` mtime — proxy goes stale when poller processes only newsletters. Switched to `.poller-heartbeat` file touched every cycle.

**Suggestion:** agents should expose a `/health` endpoint or touch a heartbeat file natively. Standard heartbeat pattern in agent runtime would save everyone the same debugging session.


---

## 2026-05-05

### Win: Vetra dispatch beachhead — Tasks 1-6 of 7 complete in one session

Biggest build since deploying the team. Roger (coding agent) was dispatched with a 53KB plan for bolting a Powerhouse-native document model onto the dispatch lifecycle. In one session he produced:

- **agent-platform repo** (new, private GitHub): typed dispatch document model with GraphQL schema, reducers, vitest tests, and a projection processor that renders dispatch docs to markdown.
- **id-agents vetra-beachhead-v0 branch**: dispatch writer + retry queue, lifecycle hook into the manager, retry worker, parity checker.

All 5 typed ops (CREATE_DISPATCH, START_PROCESSING, REGISTER_ARTIFACT, MARK_DONE, VERIFY_SIGNAL) are modeled. Task 7 (integration verification gate) is next.

**Why this matters for ID Agents:** The dispatch lifecycle today is prose-shaped — agents claim completion via `/agent-done` but there's no replayable history of what actually happened. Vetra adds an operation log per dispatch that IS the audit trail. If VERIFY_SIGNAL never emits, the dispatch isn't done regardless of what the agent claimed.

### Discovery: FK constraint bug — direct-to-port dispatches lose replies silently

Investigated why CTO's plan-writing dispatches appeared to fail (plans were actually on disk, 53KB each). Root cause: dispatching direct to an agent's port (`curl localhost:4139/talk`) bypasses the manager's `queries` table. When the agent calls `/agent-done`, the FK constraint on `query_id` fails silently — the reply is lost and the manager never learns the work completed.

**Suggestion for Prem:**
- Either enforce that all dispatches route through the manager (even programmatic ones), or
- Make `/agent-done` gracefully handle missing `query_id` FK (log + deliver anyway), or
- Expose a `/dispatch` endpoint on each agent that registers with the manager automatically before forwarding to `/talk`.

This is the same shape as the "Cane said it saved but didn't" bug — protocol gaps where success depends on every link in a chain firing. Vetra's typed-op model is designed to catch exactly this class.

### Architecture: Codex as backup manager during rate limits

When Anthropic usage hit 80%, used OpenAI Codex as a secondary manager instance. It produced a comprehensive agent team ops manual (system map, daily loop, dispatch templates) and queued 4 dispatches for post-reset. Worked well enough to demonstrate:

**Suggestion for Prem:** Model-pluggable agents would make the system resilient to single-provider rate limits. If agent configs supported a fallback model (e.g. `model: claude-sonnet-4-6, fallback: gpt-4o`), the team wouldn't go dark when one provider throttles. The manager especially needs this — losing the coordinator kills everything.

### Friction: No visibility into plan-wide token consumption

Usage meter shows a percentage but not absolute tokens. After dispatching two agents (Roger for Vetra, Finance for Amazon cleanup), usage jumped 30% in 3.5 hours with no way to attribute cost to specific agents or tasks. When running 11 agents, budget attribution matters.

**Suggestion for Prem:**
- Per-agent token counters (even approximate) so the manager can see "Roger used 400K tokens on the Vetra build, Finance used 80K on categorization."
- Budget gates: if an agent exceeds X tokens on a single dispatch, pause and notify the manager before continuing.

### Win: Three-layer role model validated

The pattern Manager → Domain Agent (specs) → Roger (builds) continues to prove out. Today's Vetra build followed: CTO wrote the plan (Apr 30) → Manager unblocked prerequisites (May 5) → Roger built Tasks 1-6 autonomously. No wasted Roger cycles on wrong-direction work because the spec was pre-validated.

### Operational: Dashboard Phase 1 merged + deployed

Agent management UI (grid layout, sizing, typography, Today/Triage panels) merged to main and pushed to Vercel. This is the "how to manage a team of agents" surface — dispatch status, task stream, agent health at a glance.

### Parking lot addition

- **Dispatch verification as first-class REST-AP surface**: agents call `/agent-done` today but there's no replay surface. Vetra's typed-op-as-verification-primitive pattern could be something the REST-AP exposes directly — "show me the op history for dispatch X" as a standard endpoint rather than requiring a separate Powerhouse instance.
- **Amazon pipeline bug** (sender-routing `continue` skips expense parser) — same verification-gap shape. Agent claimed success, side-effect never fired. Exactly what VERIFY_SIGNAL is designed to catch.

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

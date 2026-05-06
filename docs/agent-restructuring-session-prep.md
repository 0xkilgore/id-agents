# Agent Infrastructure Restructuring Session — Prep Notes

**For Chris's 90-min block, due 2026-05-01.**

This file consolidates ALL the cane / agent-infra to-do items that got rolled up into the single "Agent infrastructure restructuring session" task. Loading this before the session = full context.

---

## Session goals

Per `cane/to-do.md` (the original task description before rollup):

> Logger agent, testing agent, Codex-as-CTO integration. Design session Chris wants to carve out this week. Likely a 60-90 min block with Claude; produces a design doc + 2-3 follow-up specs for Cane/Roger.

**Output target:** design doc + 2-3 follow-up specs.

---

## This week's architectural commitments — apply to every session topic

These are no longer optional background ideas. The session should treat them as current architectural commitments:

- **Three-surface model is now the frame:** Inbox is unprocessed incoming; To-do and Pipeline are claimed-work surfaces with different cadences. Only Chris-actionable items belong on Chris's to-do. Agent-owned work should live in dispatch / agent systems, not on Chris's personal list.
- **Vetra beachhead is real enough to shape design now:** the dispatch beachhead commits to typed operations, read-only markdown projections, forward-only shadow mirroring, parity checking, and operation history as the verification primitive. Session topics should prefer shapes that can later fit this pattern cleanly.
- **Dashboard + operator-tray matter as surfaces, not just UI polish:** the approved dashboard direction and the new operator-tray idea mean we now have to think in terms of multiple operator surfaces: Inbox, To-do/operator-tray, and dispatched-work / waiting-on.
- **Powerhouse bias applies, but for dev ergonomics first:** when a topic has a credible "use Powerhouse/Vetra doc model" path versus inventing another bespoke ledger, default toward the Powerhouse-shaped path unless it adds immediate shipping risk. The reason is local-first unified state and lower backend ceremony, not product theater.
- **Inbox-as-Vetra-document is the second beachhead candidate:** if a topic touches intake, routing, verification of delivery, or "did the system actually process this item?", explicitly ask whether the inbox doc model is the cleaner substrate.
- **Recurring prep should become `/schedule` routines:** anything that is a standing cadence rather than an ad hoc task should be designed with scheduled dispatch/prep in mind, not left as a remembered TODO.

Practical consequence for the session: every topic should be judged against the same five questions:
- Does the Vetra / dashboard / operator-tray / three-surface decision materially change the design?
- Does the Powerhouse-bias calibration shift the recommendation?
- Could a Vetra document model replace the proposed homegrown design?
- Does this connect to the inbox-as-Vetra-doc second beachhead?
- Does the cross-team observations doc already name a platform or integration gap that would simplify this?

---

## Topics to cover (rolled up from individual to-dos)

### 0. ⚠️ CRITICAL BUG SURFACED 2026-05-01 — Cane poller "saved task" lies

**Discovered during this morning's triage.** Chris sends a task via Telegram. Cane poller responds **"✅ Saved task: ..."** but in fact only writes to `cane/taskview/inbox.md` as `[ ]` unprocessed — **never writes the task to the appropriate `<project>/to-do.md` file.** Two examples surfaced 2026-05-01:

- 2026-04-30 20:46 Telegram: "Add as a to-do to create an email template for Susanna for the Cleveland Park Neighborhood Association email..." → Cane said ✅ Saved → inbox.md `[ ]` only → NOT in cleveland-park/to-do.md → Chris doesn't see it in his daily view.
- 2026-05-01 07:26 Telegram: "Add to do due day in Cleveland Park" → same pattern, same silent drop.

**Why this matters for the session:** this is the canonical example of every other failure mode in this prep doc. The Cane poller claims success but the side effect didn't happen. Without automated verification, **Chris loses tasks AND loses trust in the system.** Trust loss is structural — every "✅ Saved task" message is now suspect, including ones from past months.

**Session must produce:**
- **Concrete fix path** for the routing-to-project-to-do step in `cane_poller.py`. Where does the routing happen, why does it fail silently, what test gates this from regressing? Backfill audit: how many past tasks were silently dropped — can we recover them from inbox.md history?
- **Testing agent design** (next section) explicitly covers this exact scenario: agent claims X happened, automated verifier checks the side effect actually happened in the expected destination file.
- **Decision on whether to silence the "✅ Saved task" reply** until the actual to-do.md write succeeds. **Better to fail loudly than lie.**
- **Audit of the `[ ]` items in `cane/taskview/inbox.md`** — anything that was supposed to be a routed task and got stuck. Chris triaged ~13 of them this morning manually; older entries may have similar gaps.

This bug is the canonical example for everything else in this session. Treat it as the test case for any testing-agent design proposed below.

### 1. Testing agent — BLOCKER for Roger merges

**Why high priority:** the 2026-04-21 incident where Spec 033 (Telegram image handling) shipped as 'done', Chris had to test manually, bug uncovered, debugging loop incomplete because of TCC. Testing agent is no longer a nice-to-have.

**Spec needs to define:**
- What "test" means for an agent-shipped artifact (unit, integration, smoke, manual-verify proxy)
- How the testing agent receives a build artifact (Roger's `cane deliver` could include a test_signal payload?)
- What the testing agent returns (pass/fail/partial + evidence)
- How it integrates with `dispatch-protocol-v1` (verify_signal extension?)
- Sentinel-vs-testing-agent boundary (sentinel = ongoing audit; testing agent = pre-merge verification)

**This week's architecture note:** this topic got deeper, not simpler. The cleanest boundary is likely: manager emits dispatch lifecycle ops, testing agent emits typed verification ops, and sentinel consumes the resulting operation history rather than owning a separate ad hoc ledger. The hypothesis that the testing agent could emit typed `VERIFY`-style ops on a Vetra document model is directionally right and worth explicit design time; it would sharply clarify the sentinel/testing boundary. Cross-team observations already point at "operations as verification," "projected markdown as read-only," and parity/drift tooling as the missing simplifiers. Also test results should land on the dispatched-work surface, not on Chris's to-do.

**This unblocks:** any future Roger code merge that needs automated verification.

### 2. Logger agent

**Concept:** monitor agent state across the team, track errors, surface patterns. Currently no central observability.

**Spec needs to define:**
- What state the logger watches (agent /health, dispatch outcomes, error counts, queue depth)
- Where it writes (Obsidian sentinel/ folder? agent-performance-week1.md style?)
- Cadence (real-time stream vs periodic digest)
- Alerting threshold (when does logger escalate to manager / Chris?)

**This week's architecture note:** logger now overlaps three things that should not be blurred together: sentinel verification, cross-team integration observations, and operational telemetry. The useful split is likely: logger owns raw operational event/timeline capture and alert thresholds; sentinel owns "did the system do what it claimed?"; the cross-team doc remains a human-curated synthesis artifact for product/platform gaps. Powerhouse bias pushes against inventing a fresh markdown observability ledger if a typed event stream or Vetra projection can hold the machine-owned state. The three-surface model also matters here: logger output should probably surface into dispatched-work / waiting-on first, and only promote to Inbox or To-do when Chris action is actually required.

### 3. Codex-as-CTO integration

**Status:** Spec 054 already shipped. CTO is live on port 4139, doing spec reviews + plan-writing + output reviews.

**Open questions for the session:**
- Recurring lost-dispatch issues (Vetra plan dispatched 3x, two were silently lost) — root cause? CTO Codex CLI process management?
- CTO heartbeat cadence + timeout handling
- Should CTO also do output reviews on Cane/Roger artifacts (not just code)?

**This week's architecture note:** this now deserves its own operational-design subtopic, not a quick status check. The "3 hangs in last 24h on Vetra plan dispatches" pattern likely sits at the Codex CLI child-process / lifecycle layer, and it directly affects whether dispatch can be a trustworthy canonical surface. The Vetra beachhead does not solve lost dispatches by itself; if anything it makes the need for a reliable `START_PROCESSING` / `MARK_DONE` path more obvious. Cross-team observations on shadow mirrors, retry queues, and parity are relevant, but the first fix may simply be better process supervision and explicit stuck-dispatch instrumentation on the manager/CTO boundary.

### 4. Auto voice memo pipeline (BLOCKED on testing agent)

**Goal:** When voice memos sync from iPhone via iCloud to Mac, auto-detect new files, transcribe with Whisper, extract tasks/notes, save to project. Pipeline: detect → transcribe (diarize) → Claude extract → save to inbox/project.

**Why blocked on testing agent:** this is a Cane build, and the 2026-04-21 incident pattern means Chris doesn't want any new Cane builds without automated verification.

**Status:** Walker MVP /record button (Spec 063) is a UI-side parallel to this — they share the underlying transcription infrastructure question. The agent-infra session should reconcile these two threads.

**This week's architecture note:** the hypothesis is strong: transcription should be designed as one primitive, not four pipelines. A Vetra document model like `transcription_job` with typed ops such as `CREATE_JOB`, `ASSIGN_TRANSCRIBER`, `RECEIVE_CHUNK`, `COMPLETE`, and `EXTRACT_TASKS` is a cleaner architectural center than another Cane-only script chain. That would let Walker `/record`, Cane voice memos, and later podcast ingestion share one lifecycle while keeping diarization as typed metadata rather than bespoke code paths. It also connects directly to the inbox-as-Vetra-doc beachhead because many transcripts ultimately route into Inbox, To-do, or Pipeline.

### 5. Fireflies file upload fix (BLOCKED on testing agent)

**Goal:** Roger task. Fix `cane_transcribe.py` Fireflies upload — REST endpoint is wrong, returns 404. Research actual Fireflies upload API.

**Why blocked:** same as #4. Cane build → testing agent gates merge.

**This week's architecture note:** this has shifted from "patch the broken endpoint" to "decide whether Fireflies is even the right abstraction boundary." Powerhouse bias does not mean "use Vetra instead of an external transcription vendor," but it does mean avoid baking Fireflies-specific behavior into a homegrown long-term workflow if a typed transcription primitive can isolate vendors behind one document lifecycle. If Fireflies survives, it should probably just be one possible transcriber attached to `ASSIGN_TRANSCRIBER`, not the architecture.

### 6. Photo handling on Cane Telegram bot (BLOCKED on testing agent)

**Goal:** Verify after testing agent exists. First test was inconclusive: Cane received photo+caption, responded as text-only, photo_list was empty from Telegram API. Code shipped 2026-04-21 in roger/completed/033. Need: test harness that posts faked Telegram payload to poll_telegram + asserts photo inbox side effects.

**Why blocked:** literally needs the testing agent to verify.

**This week's architecture note:** yes, this could converge with the same transcription/intake document model discussion instead of staying a one-off Telegram test harness. The inbox-as-Vetra-doc idea is especially relevant here because the core question is not just "did Telegram send `photo_list`?" but "did the inbound rich-media item get classified, routed, and delivered correctly?" Typed inbox ops would give the testing agent and sentinel a much cleaner target than mutable markdown side effects. Cross-team observations on canonical machine-owned objects and read-only projections are directly applicable.

### 7. Trello inbox integration (independent)

**Goal:** Auto-sweep Trello cards on a schedule, process like Telegram messages. Currently manual via taskview sweep. Could: (1) Schedule sweep on M1 like fangraphs sync, (2) Have Trello cards show up in inbox.md for processing, (3) Use Chrome Trello extension as quick-capture alternative to Telegram.

**Status:** Cane has full Trello API access already (`trello.py`).

**This week's architecture note:** the design changed meaningfully because the three-surface model makes it clearer that Trello is an Inbox feeder or a KM catch-all, not necessarily a Chris to-do source. If this survives as a capture path, it should likely flow into the inbox document model and then into To-do or Pipeline based on classification. The new KM catch-all idea also weakens the case for treating Trello as a durable homegrown system; it may be better as temporary capture only. Because this is recurring intake, `/schedule` should be part of the design from the start.

### 8. SETUP_LOG.md durable-memory fold

**Goal:** Review `~/Dropbox/Code/cane/id-agents/SETUP_LOG.md` and fold anything durable into memory files. Currently mixes ephemeral session notes with durable system facts.

**Why session topic:** good time to clean up the historical log + decide what stays as setup-log notes vs what graduates to a memory file.

**This week's architecture note:** this topic now sits inside the broader "canonical machine-owned state versus prose notes" cleanup. Cross-team observations explicitly call out that too much operational truth is still trapped in mutable markdown. The recommendation shifts toward a stricter rule: keep `SETUP_LOG.md` as human narrative / ephemeral notes only; durable operational facts should move either into memory files, scheduled routines, or typed state surfaces when they become machine-owned. The recurring-prep memory is relevant here too: if a setup fact implies a standing routine, it should become `/schedule`, not a note.

### 9. Mac Whisper Pro integration (added 2026-04-30)

**Goal:** Investigate integrating Mac Whisper Pro into the audio transcription flow. Build into the pipeline rather than dropping files in manually. Mac Whisper Pro has speaker diarization — the local pipeline currently lacks that (per the 2026-04-30 Defiant podcast transcription where Eigenmann's speaker windows had to be host-prompt-inferred).

**Trigger:** Chris inbox 2026-04-30 12:18. Speaker detection is the differentiator.

**This week's architecture note:** this should now be treated as a field on the shared transcription primitive, not as a standalone integration question. The explicit hypothesis is likely correct: speaker diarization becomes typed data on the transcription job/document, and Mac Whisper Pro is one transcriber implementation that can populate it. That makes the Walker `/record` path, Cane voice memos, and podcast workflow naturally share the same substrate. The dev-ergonomic Powerhouse motivation also points toward one local-first transcription lifecycle rather than another separate backend chain.

### 10. Dashboard redesign brainstorm — DONE (out of session scope)

The Dashboard UI design spec is APPROVED (Spec 054 round 5) and the implementation plan is WRITTEN. Roger building Phase 1 today on `dashboard-phase-1` branch. NOT a session topic — just listed for context.

**This week's architecture note:** keep this out of implementation debate, but do use it as settled context. The dashboard is now explicitly one manager surface, not the whole manager system, and the operator-tray idea means the session should stop assuming there is only one "home screen." This topic is also the concrete reason to add a new topic on the three-surface model: testing-agent, logger, inbox-routing, and waiting-on all now need to know which surface they project into.

### 11. Podcast transcript system for Cane (taskview)

**Goal:** User sends screenshot from Pocketcasts → Cane OCRs podcast name + timestamp → finds RSS feed → downloads audio → transcribes with Whisper on M1 → extracts context around timestamp.

**Why session topic:** overlaps with #4 (auto voice memo pipeline) and #9 (Mac Whisper Pro). All three are transcription-pipeline questions that should be designed together.

**This week's architecture note:** this should not be specified as a bespoke podcast pipeline anymore. It is the fourth consumer of the same transcription primitive, and the same `transcription_job` document shape can absorb it with source-specific metadata for RSS feed, episode, and target timestamp. This also creates a clean bridge to the inbox-as-Vetra-doc beachhead: extracted tasks/notes are routed outputs from a completed transcription job, not ad hoc side effects.

### 12. Three-surface model — NEW topic

**Why add this now:** the approved dashboard direction, the operator-tray idea, the inbox-as-Vetra-doc beachhead, and the feedback memory on Inbox/To-do/Pipeline all change the frame. Without an explicit surface-model discussion, the testing agent and logger agent risk writing into conflicting places.

**Topic needs to define:**
- Which system events belong on Inbox vs To-do/operator-tray vs dispatched-work/waiting-on
- When agent-owned work is visible to Chris but should NOT become a Chris to-do item
- Where testing failures, logger alerts, and transcription-job states surface by default
- How the dashboard, operator tray, and future Vetra projections divide responsibilities
- Whether Inbox-as-Vetra-doc and dispatch-as-Vetra-doc should be designed together as the first two machine-owned surfaces

**This week's architecture note:** this is where several hypotheses converge cleanly. The three-surface model likely simplifies the logger/testing overlap, makes the dashboard/operator-tray split explicit, and reinforces the memory rule that only Chris-actionable items go onto Chris's to-do. It also gives the session a place to talk about the new KM catch-all and the bi-weekly Ideas Review without polluting the core agent-runtime topics.

---

## Cross-cutting architecture questions

These are the threads that emerge when you look at #1-12 together:

1. **Transcription pipeline as a primitive** — voice memos, podcasts, meeting recordings, Walker field uploads all want the same backend. Should there be ONE `transcription-service` (Cane-owned) that everything calls, vs multiple ad-hoc Whisper/Fireflies/MacWhisper integrations?

2. **Testing agent boundary** — does the testing agent ALSO test transcription pipelines? Or just code? Or both?

3. **Telegram / inbox classification** — currently Haiku classifier in cane_poller. Should the agent-infra session decide whether classifier becomes its own typed agent (so the testing agent can verify it)?

4. **Sentinel relationship to testing agent** — sentinel runs on 2-hour cadence to verify agents did what they claimed. Testing agent runs pre-merge. They're DIFFERENT verification layers — session should make this boundary explicit.

5. **Vetra integration angle** — most of these agent-infra concerns benefit from the Vetra dispatch beachhead. The session should not force immediate Vetra implementation everywhere, but it SHOULD explicitly prefer shapes that can become typed-op document models later without redesign.

6. **Three-surface model** — Inbox, To-do/operator-tray, and dispatched-work/waiting-on are now distinct surfaces with different ownership and cadence. Several topics above are really about where state should surface, not just how it is implemented.

---

## Recommended session flow (90 min)

1. (10 min) Read this prep doc, recap the rolled-up scope.
2. (20 min) Decide testing-agent spec shape — include whether verification becomes typed ops and where sentinel boundary lands. This is the critical-path unblocker and got architecturally heavier this week.
3. (10 min) Decide three-surface model — Inbox vs To-do/operator-tray vs dispatched-work/waiting-on. Get the surface model explicit before logger/inbox topics sprawl.
4. (10 min) Decide logger-agent shape in that surface model, OR explicitly defer with reasons.
5. (15 min) Codex/CTO operational issues (lost dispatches, heartbeat, child-process hangs, stuck-dispatch instrumentation).
6. (15 min) Transcription-pipeline-as-primitive — unify voice memos, Walker `/record`, Mac Whisper Pro, Telegram rich media, and podcast transcript flow.
7. (10 min) Quick decisions: Trello/KM catch-all, SETUP_LOG fold, recurring `/schedule` prep implications.
8. (10 min) Output: write 2-3 follow-up specs (testing-agent, transcription primitive, and either logger or three-surface/sentinel boundary). Save spec drafts to `roger/specs/` per Spec 054 routing.

**Output gates:**
- ✅ One concrete testing-agent spec drafted (highest priority — unblocks #5, #6, future Roger merges)
- ✅ One concrete logger-agent spec OR explicit deferral with why
- ✅ Decisions made on items #7-12 (Trello, MacWhisper Pro, SETUP_LOG, podcast system, three-surface model) — either inline action or explicit further-spec-needed flag

---

## Files Chris should have open during the session

- This prep doc
- `cane/CLAUDE.md` (Spec 054 routing)
- `cane/id-agents/SETUP_LOG.md`
- `cane/id-agents/feedback-for-prem.md` (Powerhouse + ID-Agents observations)
- `agent-platform/ideas.md` (recent product ideas including operator-tray)
- `agent-platform/specs/2026-04-30-vetra-dispatch-beachhead.md`
- `cto/output/cross-team-integration-observations.md`
- `pipeline/walker-dispatch/V0.1-FEEDBACK.md`

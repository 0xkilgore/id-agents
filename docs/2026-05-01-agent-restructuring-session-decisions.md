# Agent Infrastructure Restructuring Session — Decisions

**Date:** 2026-05-01
**Session length:** ~30 min (efficient — original prep estimated 90 min)
**Participants:** Chris + manager
**Prep doc:** `agent-restructuring-session-prep.md`

This doc captures the decisions reached. **Cane uses this as input for spec writing** (Specs 064, 065, 066). CTO uses it for the calibration message + 2-week output-review pilot.

---

## Topic 0 — The Cane "saved task" bug

**The bug:** Cane poller responds "✅ Saved task" via Telegram but doesn't actually write to `<project>/to-do.md`. Tasks sit as `[ ]` in `cane/taskview/inbox.md` forever, silently dropped.

### Decisions

- **0.1 (trust-recovery):** Option A — **Stop sending "✅ Saved" entirely until the to-do.md write is verified.** Don't send two messages. One message, only after verified. Better silent than lying.
- **0.2 (backfill audit):** Option A — **Full audit of all `[ ]` items in inbox.md, generate a report of probably-dropped tasks for Chris to triage.** Chris said: "I probably used some of the things that I thought I added but did not."

### Action

This goes into **Spec 064 (Testing agent)** as the canonical first test case. The fix has two parts: (1) the routing-to-to-do.md path in `cane_poller.py` itself, (2) the testing agent's verification of side-effect claims.

---

## Topic 1 — Testing agent

**Why high priority:** Topic 0 bug + the 2026-04-21 Spec 033 incident (Telegram image handling shipped 'done' but broken). Trust loss is structural — every agent claim is now suspect until an automated verifier validates it.

### Decisions

- **1.1 (test scope):** Option C — **Code AND agent-claimed side effects.** Both. Side-effect verification is the urgent priority (Topic 0 bug = canonical case), but code tests matter too. Chris's framing: "we have so many different things that are like code but not code, and it's kind of hard to know the difference."
- **1.2 (integration mode):** Option C — **Both pre-merge gate (for code) AND async verifier (for side effects).** Code can wait for tests; side-effect verification needs to run continuously across all agents.
- **1.3 (where results live):** Option B — **Typed `VERIFY` ops on the dispatch document model.** Leverages Spec 053 dispatches table now (extends `verify_signal`/`verify_status` semantics that already exist), graduates cleanly to Vetra when beachhead lands.

### Action

**Spec 064 (Testing agent + Cane bug fix).** Highest priority — unblocks future Roger merges + restores trust.

---

## Topic 2 — Logger agent

**Boundary clarified by CTO enrichment:** Logger = raw operational telemetry (different from sentinel verification, cross-team observations doc, testing agent verification).

**Chris's reframe (load-bearing):** Logger isn't pure SRE telemetry — it's **agent quality / instruction-following / progress** measurement. Less "is the system slow?" more "are my agents actually doing what I asked?" Quality/audit dimension.

### Decisions

- **2.1 (scope):** Option B — **Health + dispatch counts + error logs + slow-query/long-running detection.** With the quality/instruction-following framing applied throughout.
- **2.2 (substrate):** Option C — **Same dispatch document model substrate as testing agent.** Typed ops (HEALTH_CHECK, ERROR_LOGGED, SLOW_QUERY, etc.). Vetra-ready.
- **2.3 (sequencing):** Option C — **Spec now, build after testing-agent ships.** Testing-agent is the urgent unblocker.

### Action

**Spec 065 (Logger agent).** Spec written now, queued for Roger after Spec 064 ships. Includes:
- Quality/instruction-following framing (not pure SRE)
- **TCC permission-attribution daemon as a sub-scope** — when macOS prompts "Node was prevented...", logger surfaces "🛂 cane is asking for Documents access" via Telegram with the agent name attached.

---

## Topic 3 — Codex/CTO operational issues

3 lost/hung Vetra plan dispatches in last 24h. Reliability is shaky; output quality when CTO does respond is high.

### Decisions

- **3.1 (root-cause investigation):** Option B + C together — **Spec the investigation as a Roger task** (Roger digs into Codex CLI child-process lifecycle) AND **add stuck-dispatch instrumentation now** (Cane writes a detector). Both achievable, complementary.
- **3.2 (interim trust posture):** Option B — **Manager auto-retries CTO dispatches after 5 min if no items appear in news.** Hide the issue from Chris with retry logic. Chris: "I don't want to know about the CTO hangs when they happen. I just like maybe at the end of the month or when I'm looking on my dashboard of the agent performance, I want to be able to see that."
- **3.3 (output review scope expansion):** Option C — **Pilot CTO review on pipeline + cane outputs for 2 weeks**, then evaluate. Tidcomb miss is the example case — would have been caught.

**Aside captured for future ideas log:** Chris floated the idea of a separate "strategy/leadership-y reviewer agent" distinct from the technical CTO. Different muscle. Worth its own future spec.

### Actions

- **NOT a new spec.** These get baked into existing systems:
  - 3.1 Roger investigation task → queue after 064/065 ship
  - 3.1 stuck-dispatch detector → small Cane task (~50 lines)
  - 3.2 manager auto-retry → Roger task in id-agents codebase (~30 lines)
  - 3.3 CTO calibration message → manager sends now, 2-week reminder added to Pipeline Review (Monday May 18)
- **Strategy reviewer agent idea** → log in `agent-platform/ideas.md`

---

## Topic 4 — Transcription as a primitive

Ties together: auto voice memo pipeline (Cane), Walker MVP /record button (Spec 063), photo+voice handling on Cane Telegram, Mac Whisper Pro integration, podcast transcript system.

### Decisions

- **4.1 (one or many):** Option C — **Vetra-native `transcription_job` document model.** Doc-model with typed ops (CREATE_JOB, ASSIGN_TRANSCRIBER, RECEIVE_CHUNK, COMPLETE, EXTRACT_TASKS). Powerhouse-bias-aligned.
- **4.2 (speaker diarization):** Option A — **Per-job feature flag.** Walker /record (single speaker) doesn't need it. Defiant podcast (panel of 4) absolutely does.
- **4.3 (sequence):** Option B — **Build primitive in parallel with Walker /record.** Walker is the first new consumer. Refactor existing surfaces (Cane voice memo, podcast system) AFTER primitive proves out.

**Catch:** Vetra-native means this needs the dispatch beachhead validated first. Spec now, build after.

### Action

**Spec 066 (Transcription primitive).** Spec written now, queued for build after both:
1. Walker /record (Spec 063 v0.1 build)
2. Vetra dispatch beachhead validated

---

## Topic 5 — Trello inbox + SETUP_LOG cleanup

### Decisions

- **5.1 (Trello inbox):** Option C — **Both: scheduled M1 launchd sweep populates inbox.md, then normal Cane routing handles classification.** Aligns with inbox-as-Vetra-doc idea — Trello cards become typed `RECEIVE_ITEM` ops with `source=trello`. One inbox, three sources.
- **5.2 (SETUP_LOG fold):** Option A — **Do it in this session.** 15-min cleanup pass. Manager extracts durable facts → memory files.

### Action

- **5.1 Trello sweep** → folded into the future inbox-as-Vetra-doc spec when we write it (separate brainstorm needed; not Spec 064/065/066 scope)
- **5.2 SETUP_LOG fold** → **manager does this inline now**, after spec dispatches

---

## Output summary — what's getting dispatched from this session

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | **Spec 064: Testing agent + Cane bug fix** | Cane writes | dispatching now |
| 2 | **Spec 065: Logger agent (quality framing + TCC attribution)** | Cane writes | dispatching now |
| 3 | **Spec 066: Vetra-native transcription primitive** | Cane writes | dispatching now |
| 4 | **CTO calibration: 2-week output-review pilot on cane+pipeline outputs** | Manager → CTO | dispatching now |
| 5 | **Roger: manager auto-retry CTO dispatches** | Roger | small task, queue after dashboard build |
| 6 | **Roger: stuck-dispatch detector** | Roger | small task, queue after dashboard build |
| 7 | **Roger: investigation of Codex CLI lost-dispatch root cause** | Roger | larger task, queue after Specs 064-066 ship |
| 8 | **Manager: SETUP_LOG.md durable-fact fold → memory files** | Manager | doing inline now |
| 9 | **Strategy/leadership reviewer agent idea** | Manager | logging in agent-platform/ideas.md |
| 10 | **Pipeline Review Monday May 18: evaluate CTO output-review pilot** | Manager calendar | adding to Pipeline Review notes |

After Specs 064-066 are written by Cane → CTO reviews per Spec 054 → Roger ships in build sequence:

**Build sequence:**
1. **Walker v0.1 (Spec 063 plan-writing in flight)** — first
2. **Spec 064 (testing agent)** — second, unblocks all Cane builds
3. **Vetra dispatch beachhead** — third (CTO Vetra plan also in flight, hopefully landing today)
4. **Spec 066 (transcription primitive)** — fourth, builds on Vetra beachhead + becomes Walker /record's backend
5. **Spec 065 (logger agent)** — fifth, builds on testing-agent substrate
6. **Inbox-as-Vetra-doc** — separate future brainstorm; Trello sweep folds in there

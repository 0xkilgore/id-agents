# Codex CTO Agent Design

**Brainstorm date:** 2026-04-27
**Status:** Approved — ready for implementation plan

---

## 1. Background

The manager (Claude) currently writes both design specs AND implementation plans, then dispatches directly to Roger. There is no second architectural opinion before Roger touches code. This means:
- Implementation plans can have design flaws the manager didn't catch
- Roger implements what he's told even if the approach is wrong
- Output is only reviewed by the manager (same model that wrote the spec)

The Codex CTO agent introduces a second perspective at three critical points in the build pipeline, using OpenAI Codex CLI as a genuinely different model with its own architectural judgment.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Runtime | OpenAI Codex CLI (`runtime: codex`), not a Claude agent |
| 2 | Triggers | All three: spec review + plan writing + output review |
| 3 | Flow model | Approach A — strict sequential gate with `codex_skip` escape hatch |
| 4 | Auth | Existing `~/.codex/auth.json` (ChatGPT OAuth, tokens refreshed 2026-04-27) |
| 5 | Plan writing | Codex writes plans for now; dedicated planner agent is a future option |

---

## 3. Architecture

```
Chris ←→ Manager
           │
           ├─[new spec]──→ Codex: spec review
           │                  ├─ BOUNCED → Manager revises with Chris
           │                  └─ APPROVED
           │                        │
           │               Codex: plan writing → saves plan to docs/superpowers/plans/
           │                        │
           │               Manager reviews plan → dispatches to Roger
           │                        │
           │               Roger: implements → calls /agent-done
           │                        │
           └─[after /agent-done]──→ Codex: output review
                              ├─ FLAGGED → Manager holds, surfaces issue to Chris
                              └─ APPROVED → surfaces to Chris normally
```

`codex_skip: true` on any dispatch bypasses all three triggers. Manager sets this for trivial/urgent ops (diagnostics, quick maintenance). All brainstorm-originated builds go through Codex by default.

---

## 4. Agent identity

| Field | Value |
|-------|-------|
| Name | `cto` |
| Port | 4149 |
| Working dir | `~/Dropbox/Code/cto/` |
| Runtime | `codex` |
| Model | Codex default (ChatGPT Plus/Pro via OAuth) |
| Skills | `identity`, `inter-agent`, `catalog`, `writing-plans` (superpowers) |
| Persona file | `~/Dropbox/Code/cto/AGENTS.md` |

---

## 5. Components

### 5.1 kilgore-team.yaml entry

```yaml
- name: cto
  description: >
    Architectural reviewer and planner. Reviews specs before plans are written,
    writes implementation plans, reviews Roger's output before it surfaces to Chris.
    Uses OpenAI Codex CLI — a genuinely different model perspective.
  runtime: codex
  workingDirectory: /Users/kilgore/Dropbox/Code/cto
  capabilities: |
    - Review specs for architectural soundness (YAGNI, complexity, integration risk)
    - Write implementation plans following the writing-plans skill format (TDD, exact paths, complete code)
    - Review Roger's shipped output against the original spec
    - Approve or bounce with specific, actionable reasons
```

### 5.2 AGENTS.md (CTO persona)

`~/Dropbox/Code/cto/AGENTS.md`:

```markdown
# CTO Agent

You are the CTO of a small AI agent team. You are an architectural reviewer and planner.
Your job is to prevent bad ideas from reaching the codebase.

## Your three roles

**Role 1 — Spec review:** When the manager sends you a spec to review:
- Read the spec AND the relevant existing code before forming an opinion
- Check for: YAGNI violations, overly complex approaches, missing error handling,
  type inconsistencies, integration risks with existing code, missing test strategy
- Respond with exactly one of:
  - `APPROVED` (with optional brief notes)
  - `BOUNCED: <specific reason referencing file paths and line numbers where relevant>`
- Be specific. "BOUNCED: the dispatches table migration should go in
  src/db/migrations/sqlite.ts (existing pattern) not a new file" — not "this could be improved."

**Role 2 — Plan writing:** When the manager asks you to write an implementation plan:
- Follow the writing-plans skill format exactly (in .agents/skills/writing-plans/)
- TDD throughout: write failing test → run it → implement → run it → commit
- Exact file paths always. Complete code in every step. No placeholders.
- Save the plan to the path the manager specifies, then call back via `cane deliver`.

**Role 3 — Output review:** When the manager asks you to review Roger's shipped work:
- Read the artifact AND the spec it was built against
- Check: does implementation match spec, do tests actually test what they claim,
  any scope creep, any regressions to existing tests?
- Respond with `APPROVED` or `FLAGGED: <specific issue>`.

## What you are not

- Not a rubber-stamper. If a spec is wrong, say so.
- Not a blocker without cause. If a spec is sound, approve it quickly.
- Not a style critic. Substance only.

## System context

All project files, specs, plans, and to-dos are in ~/Dropbox/Code/ and ~/Dropbox/Obsidian/.
The codebase you're most often reviewing is ~/Dropbox/Code/cane/id-agents/ (TypeScript,
Node, SQLite). Read existing code before forming opinions about architecture.
```

### 5.3 Three trigger flows (manager-side)

**Trigger 1 — Spec review**
```
POST http://localhost:4149/talk
{
  "from": "manager",
  "message": "Spec review requested.\n\nSpec at: <path>\n\nRead the spec and any related existing code. Approve or bounce with specific reasons."
}
```

**Trigger 2 — Plan writing**
```
POST http://localhost:4149/talk
{
  "from": "manager",
  "message": "Spec approved. Write the implementation plan.\n\nSpec at: <path>\nSave plan to: <path>\nFollow the writing-plans skill format exactly."
}
```

**Trigger 3 — Output review**
```
POST http://localhost:4149/talk
{
  "from": "manager",
  "message": "Roger shipped. Review output against spec.\n\nArtifact at: <path>\nSpec at: <path>\n\nApprove or flag specific issues."
}
```

### 5.4 codex_skip flag

This is a manager-side routing flag — the manager reads it before deciding whether to dispatch to Codex at all. Codex never sees it. When `codex_skip: true` is present on a dispatch, the manager routes directly to Roger, skipping all three Codex triggers.

Carried in the manager's internal dispatch record (not in the `/talk` payload to Codex). Manager sets this for:
- Diagnostic/investigative dispatches (no implementation)
- Quick maintenance where the approach is unambiguous (e.g. "update this config value")
- Emergency ops where speed matters more than review
- Explicitly user-overridden dispatches

Default for all brainstorm-originated builds: `codex_skip` absent (goes through Codex).

---

## 6. Error handling

| Scenario | Behavior |
|----------|----------|
| Codex unreachable / crashes | Fall through to manager-writes-plan (today's behavior). Log the failure. Don't stall. |
| Codex bounces spec twice on same issue | Manager escalates to Chris rather than looping. Chris revises spec or sets `codex_skip: true`. |
| Codex output review flags issue after `/agent-done` | File as follow-up dispatch to Roger. Don't block the surface — the artifact already shipped. |
| Codex takes >30 min on plan writing | Manager times out, writes plan itself, logs the timeout. (Spec 053 Phase 5 bash timeout covers this.) |

---

## 7. Pre-steps (before wiring)

1. `npm install -g @openai/codex` — puts `codex` on PATH. Auth already present at `~/.codex/auth.json`.
2. `mkdir -p ~/Dropbox/Code/cto` — create working dir.
3. Verify: `codex --version` prints `0.2.3` or later.

---

## 8. Acceptance criteria

1. `cto` agent appears in `launchctl list | grep kilgore` (if run via launchd) or in manager's agent list.
2. `POST http://localhost:4149/talk` with a spec path returns a response with `APPROVED` or `BOUNCED`.
3. Codex writes a complete, non-placeholder implementation plan to the specified path when asked.
4. Manager routes a test spec through all three triggers end-to-end without manual intervention.
5. `codex_skip: true` dispatch reaches Roger without touching Codex.

---

## 9. Out of scope

- **Dedicated planner agent** — future option. Codex does plan writing for now.
- **Codex reviewing its own plans** — circular. Manager reviews Codex's plans, not Codex.
- **XMTP / wallet skills** — not needed for this role.
- **Session continuity for Codex** — each invocation is fresh by design. Long-running plan sessions should be broken into smaller dispatches if context is an issue.
- **Codex triggering other agents directly** — Codex communicates back to manager only. Manager handles all onward routing.

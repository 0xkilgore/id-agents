# Codex CTO Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire OpenAI Codex CLI as a CTO agent (port 4149) that reviews specs, writes implementation plans, and reviews Roger's output — with Dispatch 0 as its first act.

**Architecture:** Add a `runtime: codex` agent to kilgore-team.yaml (same pattern as existing agents), create its working directory and AGENTS.md persona, then update the manager's routing instructions so all substantive builds route through CTO before Roger. After setup, run three sequential Dispatch 0 dispatches to orient Codex to the full system.

**Tech Stack:** OpenAI Codex CLI (v0.2.3, already installed via npx, ChatGPT OAuth auth at `~/.codex/auth.json`), Node.js id-agents platform, YAML config, Bash smoke tests.

**Spec:** `~/Dropbox/Code/cane/id-agents/docs/superpowers/specs/2026-04-27-codex-cto-agent-design.md`

**Roger spec wrapper:** `~/Dropbox/Code/roger/specs/054-codex-cto-agent.md` (write this after the plan ships — 1-page summary pointing here)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `configs/kilgore-team.yaml` | Modify | Add `cto` agent entry after sentinel |
| `~/Dropbox/Code/cto/AGENTS.md` | Create | Full CTO persona (roles, format, delivery) |
| `~/Dropbox/Code/cto/audit/` | Create dir | Output dir for Dispatch 0 |
| `~/Dropbox/Code/cane/CLAUDE.md` | Modify | Add CTO routing protocol section |
| `~/Dropbox/Code/roger/specs/054-codex-cto-agent.md` | Create | Roger spec wrapper (Task 7) |

---

### Task 1: Install codex CLI globally

**Files:**
- No file changes — pre-requisite step

- [ ] **Step 1: Verify codex is NOT on PATH (confirm the pre-condition)**

```bash
which codex
```

Expected: `codex not found` (confirms global install is needed)

- [ ] **Step 2: Install globally**

```bash
npm install -g @openai/codex
```

Expected: output ending with `added N packages` — no errors.

- [ ] **Step 3: Verify install**

```bash
codex --version
```

Expected: `0.2.3` or later. If `command not found`, check that npm global bin is on PATH:

```bash
npm config get prefix
# Add <prefix>/bin to PATH in ~/.zshrc if missing, then `source ~/.zshrc`
```

- [ ] **Step 4: Verify auth is present**

```bash
python3 -c "
import json
d = json.load(open('/Users/kilgore/.codex/auth.json'))
t = d.get('tokens', {})
print('access_token:', bool(t.get('access_token')))
print('refresh_token:', bool(t.get('refresh_token')))
print('auth_mode:', d.get('auth_mode'))
"
```

Expected:
```
access_token: True
refresh_token: True
auth_mode: chatgpt
```

If access_token is False, run `codex login` and sign in via browser before proceeding.

---

### Task 2: Create CTO working directory and AGENTS.md

**Files:**
- Create: `~/Dropbox/Code/cto/AGENTS.md`
- Create dir: `~/Dropbox/Code/cto/audit/`

- [ ] **Step 1: Confirm directory does not exist yet**

```bash
ls ~/Dropbox/Code/cto/ 2>&1
```

Expected: `No such file or directory`

- [ ] **Step 2: Create directories**

```bash
mkdir -p ~/Dropbox/Code/cto/audit
```

- [ ] **Step 3: Write AGENTS.md**

Write the following to `~/Dropbox/Code/cto/AGENTS.md` (full content — no placeholders):

```markdown
# CTO Agent — Kilgore Team

You are the Chief Technology Officer of a small AI agent team. Your job is to prevent
bad ideas from reaching the codebase and ensure implementations are correct.

## Your three roles

### Role 1 — Spec review

When the manager sends you a spec to review with "Spec review requested":

1. Read the spec file at the specified path.
2. Read the relevant existing code in the project (the spec will tell you which project).
3. Check for: YAGNI violations, overly complex approaches, missing error handling,
   type inconsistencies, integration risks with existing code, missing test strategy.
4. Respond with EXACTLY one of:
   - `APPROVED` optionally followed by brief notes (max 3 bullet points)
   - `BOUNCED: <specific reason>` — reference file paths and line numbers.
     Example: "BOUNCED: the dispatches table migration should go in
     src/db/migrations/sqlite.ts (line 45, existing CREATE TABLE IF NOT EXISTS pattern)
     not a new file — breaks the single-migration-file pattern."
5. Vague feedback is not acceptable. Be specific. "This could be improved" is a failure.

### Role 2 — Plan writing

When the manager asks you to write an implementation plan:

1. Read the spec at the specified path.
2. Read the writing-plans skill format:
   `/Users/kilgore/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/writing-plans/SKILL.md`
3. Write the plan following that format exactly:
   - TDD throughout: write failing test → run → implement → run → commit
   - Exact file paths always. Complete code in every step. No placeholders.
   - "TBD", "TODO", "implement later" anywhere in the plan = plan failure.
4. Save the plan to the path the manager specifies.
5. Call back via `cane deliver` (see "Closing the loop" below).

### Role 3 — Output review

When the manager asks you to review Roger's shipped work:

1. Read the artifact at the specified path.
2. Read the spec it was built against.
3. Check: does implementation match spec, do tests actually test what they claim,
   any scope creep introduced, any regressions to existing tests.
4. Respond with `APPROVED` or `FLAGGED: <specific issue with file path and line number>`.

## Dispatch 0 — System orientation audit (one-time)

When you receive a message containing "Dispatch 0 — Part N":

**Part 1 (System map):** Read these files and produce a system map:
- `~/Dropbox/Code/cane/id-agents/docs/README.md`
- `~/Dropbox/Code/cane/id-agents/docs/reference/architecture.md`
- `~/Dropbox/Code/cane/CLAUDE.md`
- `~/Dropbox/Code/cane/id-agents/SETUP_LOG.md`
- `~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml`
- CLAUDE.md for every agent in kilgore-team.yaml (check workingDirectory for each)
- `~/Dropbox/Obsidian/Desk.md`
- The two most recent files in `~/Dropbox/Obsidian/sentinel/`

Describe: who does what, how things connect, what's running vs. broken vs. in-flight.
No opinions yet — just describe what you see.
Save to: `~/Dropbox/Code/cto/audit/system-map.md`
Then call back via `cane deliver`.

**Part 2 (Friction analysis):** Read `~/Dropbox/Code/cto/audit/system-map.md`.
Identify the top friction points — loops that don't close, information that gets lost,
architecture that is fragile or redundant, things that break repeatedly.
Be specific: reference agent names, file paths, and observed patterns.
Save to: `~/Dropbox/Code/cto/audit/friction-analysis.md`
Then call back via `cane deliver`.

**Part 3 (Build backlog):** Read system-map.md and friction-analysis.md.
Produce a prioritized backlog: improvements to existing things + net-new ideas.
Sort by: leverage × feasibility. Include your reasoning for each item.
Save to: `~/Dropbox/Code/cto/audit/build-backlog.md`
Then call back via `cane deliver`.

## What you are not

- Not a rubber-stamper. If a spec is wrong, say so clearly.
- Not a blocker without cause. If a spec is sound, approve it quickly.
- Not a style critic. Substance only — architecture, correctness, testability.

## System context

The id-agents system is a multi-agent platform running locally on M4 Mac.
- Manager: port 4100, Roger: port 4147, Sentinel: port 4148, you (CTO): port 4149
- Main codebase: `~/Dropbox/Code/cane/id-agents/` (TypeScript, Node, SQLite, Vitest)
- Agent configs: `~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml`
- Architecture doc: `~/Dropbox/Code/cane/id-agents/docs/reference/architecture.md`
- Your working dir: `~/Dropbox/Code/cto/`
- Your audit output: `~/Dropbox/Code/cto/audit/`
- All project files live under `~/Dropbox/Code/` and `~/Dropbox/Obsidian/`

Explore relevant code BEFORE forming any opinion about architecture.

## Closing the loop

When you finish any task that produces an artifact, call:

```bash
cane deliver \
  --path   "/absolute/path/to/artifact.md" \
  --tl-dr  "one-line summary of what you produced" \
  --tag    cane
```

Every artifact. No exceptions. If `cane` is not on PATH, use:
```bash
python3 ~/Dropbox/Code/cane/taskview/cane.py deliver \
  --path   "/absolute/path/to/artifact.md" \
  --tl-dr  "one-line summary" \
  --tag    cane
```
```

- [ ] **Step 4: Verify file written**

```bash
wc -l ~/Dropbox/Code/cto/AGENTS.md
ls -la ~/Dropbox/Code/cto/audit/
```

Expected: AGENTS.md with 80+ lines, audit/ directory empty.

---

### Task 3: Add CTO agent to kilgore-team.yaml

**Files:**
- Modify: `~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml`

- [ ] **Step 1: Confirm cto is not already in the config**

```bash
grep "name: cto" ~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml
```

Expected: no output.

- [ ] **Step 2: Add cto entry after the sentinel block**

Open `~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml`. Find the sentinel entry (the last agent in the file). Add the following block immediately after sentinel's closing line:

```yaml
  # CTO — Architectural reviewer, planner, output reviewer
  # OpenAI Codex CLI runtime — fresh-per-invocation, ChatGPT OAuth auth.
  # First task: Dispatch 0 system orientation audit.
  # Then: spec review → plan writing → output review for all substantive builds.
  - name: cto
    description: >
      Chief Technology Officer. Architectural reviewer and planner using OpenAI
      Codex CLI — a genuinely different model perspective. Reviews specs before
      plans are written, writes implementation plans, and reviews Roger's shipped
      output before it surfaces to Chris. First act: Dispatch 0 system audit.
    runtime: codex
    workingDirectory: /Users/kilgore/Dropbox/Code/cto
    capabilities: |
      - Review specs for architectural soundness (YAGNI, complexity, integration risk, types)
      - Write implementation plans following the writing-plans skill format (TDD, exact paths, complete code)
      - Review Roger's shipped output against the original spec
      - Approve or bounce with specific reasons referencing file paths and line numbers
      - Run Dispatch 0 system orientation audit on first setup
```

- [ ] **Step 3: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('/Users/kilgore/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml'))" && echo "YAML valid"
```

Expected: `YAML valid` — no exception.

- [ ] **Step 4: Dry-run deploy to validate agent config**

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/sync configs/kilgore-team.yaml --dry-run"}' | head -20
```

Expected: output shows `cto` in the agent list, no validation errors. If `--dry-run` is not supported, skip this step and proceed to Task 4.

- [ ] **Step 5: Commit yaml change**

```bash
cd ~/Dropbox/Code/cane/id-agents
git add configs/kilgore-team.yaml
git commit -m "config: add cto agent (codex runtime, port 4149)"
```

---

### Task 4: Sync the team config and verify CTO is live

**Files:**
- No file changes — deployment step

- [ ] **Step 1: Confirm port 4149 is not already listening**

```bash
lsof -i :4149 2>/dev/null | head -5
```

Expected: no output.

- [ ] **Step 2: Sync the config (adds cto without restarting existing agents)**

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/sync configs/kilgore-team.yaml"}' | head -20
```

Expected: response indicating sync in progress or completed. If `/sync` is not supported, use `/deploy`:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy configs/kilgore-team.yaml"}' | head -20
```

- [ ] **Step 3: Wait 15 seconds, then verify CTO process is running**

```bash
sleep 15
ps aux | grep "local-agent-server.js cto" | grep -v grep
```

Expected: a line containing `local-agent-server.js cto --team default --port 4149`.

- [ ] **Step 4: Verify health endpoint**

```bash
curl -s --max-time 10 http://localhost:4149/health
```

Expected: `{"ok":true}` or similar JSON health response.

If no response after 30 seconds:
1. Check manager logs: `tail -20 /tmp/id-agents-manager.log 2>/dev/null || launchctl list | grep kilgore`
2. Verify `codex` is on PATH: `which codex`
3. Check if port conflict: `lsof -i :4149`

---

### Task 5: Smoke test — CTO reviews a sample spec

**Files:**
- No file changes — integration test

- [ ] **Step 1: Send a minimal spec review request to CTO**

```bash
curl -s -X POST http://localhost:4149/talk \
  -H "Content-Type: application/json" \
  -d '{
    "from": "manager",
    "message": "Spec review requested.\n\nSpec at: /Users/kilgore/Dropbox/Code/cane/id-agents/docs/superpowers/specs/2026-04-27-codex-cto-agent-design.md\n\nRead the spec. This is a config-and-wiring spec, not a code spec. Check for completeness and any integration risks with the existing kilgore-team.yaml agent setup. Approve or bounce with specific reasons."
  }' | head -5
```

Expected: `{"query_id":"...","status":"processing",...}` — Codex accepted the request.

- [ ] **Step 2: Poll for completion**

```bash
# Poll /news or check delivery log for Codex response
sleep 60
tail -5 /Users/kilgore/Dropbox/Code/cane/taskview/delivery-log.md 2>/dev/null
```

Expected: a delivery-log entry from `cto` with `APPROVED` or `BOUNCED: ...` in the tl_dr. If no entry after 5 minutes, check:

```bash
ps aux | grep "local-agent-server.js cto" | grep -v grep
curl -s http://localhost:4149/health
```

- [ ] **Step 3: Verify response format**

Codex's response should contain exactly one of:
- `APPROVED` (with optional notes)
- `BOUNCED: <specific reason with file path>`

If the response is vague or unstructured, the AGENTS.md needs to be strengthened. Edit `~/Dropbox/Code/cto/AGENTS.md` to add more explicit format examples, then re-send the request.

---

### Task 6: Update cane CLAUDE.md with CTO routing protocol

**Files:**
- Modify: `~/Dropbox/Code/cane/CLAUDE.md` (append new section at end)

- [ ] **Step 1: Confirm routing section not already present**

```bash
grep "CTO routing" ~/Dropbox/Code/cane/CLAUDE.md
```

Expected: no output.

- [ ] **Step 2: Append the CTO routing section**

Append the following to the END of `~/Dropbox/Code/cane/CLAUDE.md`:

```markdown

---

## Build dispatch protocol — CTO routing (Spec 054, 2026-04-27)

All brainstorm-originated build dispatches MUST route through the CTO agent (port 4149)
before Roger. **Do not dispatch directly to Roger for substantive builds.**

### Standard flow for any new feature build

**Step 1 — Spec review** (after spec is written and committed):

```bash
curl -s -X POST http://localhost:4149/talk \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "manager",
    "message": "Spec review requested.\n\nSpec at: <absolute-path-to-spec.md>\n\nRead the spec and the relevant existing code. Approve or bounce with specific reasons."
  }'
```

Wait for APPROVED or BOUNCED. If BOUNCED, revise the spec with Chris and re-submit.
Do NOT proceed to plan writing until you have APPROVED.

**Step 2 — Plan writing** (after spec approved):

```bash
curl -s -X POST http://localhost:4149/talk \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "manager",
    "message": "Spec approved. Write the implementation plan.\n\nSpec at: <absolute-path-to-spec.md>\nSave plan to: /Users/kilgore/Dropbox/Code/cane/id-agents/docs/superpowers/plans/<YYYY-MM-DD-feature-name>.md\n\nFollow the writing-plans skill format exactly. TDD throughout. No placeholders."
  }'
```

Codex saves the plan and calls back via `cane deliver`. Review the plan, then dispatch to Roger.

**Step 3 — Dispatch to Roger** (after plan written and manager-reviewed).

**Step 4 — Output review** (after Roger calls /agent-done):

```bash
curl -s -X POST http://localhost:4149/talk \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "manager",
    "message": "Roger shipped. Review output against spec.\n\nArtifact at: <path>\nSpec at: <path>\n\nApprove or flag specific issues."
  }'
```

### codex_skip — bypassing CTO for trivial ops

For diagnostic/investigative dispatches, quick config changes, or emergency ops,
note `codex_skip: true` in your reasoning and dispatch directly to Roger. Document
the skip reason in your dispatch message. The default for ALL brainstorm-originated
builds is: no skip.

### Error handling

- CTO unreachable: dispatch directly to Roger, note the bypass.
- CTO bounces same issue twice: escalate to Chris rather than looping.
- Output review flags issue after Roger has shipped: file as follow-up dispatch to Roger.
```

- [ ] **Step 3: Verify the section was added**

```bash
grep -c "CTO routing" ~/Dropbox/Code/cane/CLAUDE.md
```

Expected: `1`

---

### Task 7: Commit all changes and write Roger spec wrapper

**Files:**
- Commit: `~/Dropbox/Code/cane/CLAUDE.md`
- Commit: `~/Dropbox/Code/cto/AGENTS.md`
- Create: `~/Dropbox/Code/roger/specs/054-codex-cto-agent.md`

- [ ] **Step 1: Commit CLAUDE.md**

```bash
cd ~/Dropbox/Code/cane
git add CLAUDE.md
git commit -m "routing: add CTO dispatch protocol (spec 054)"
```

- [ ] **Step 2: Commit AGENTS.md (cto dir is not a git repo — note this is a plain file)**

The `~/Dropbox/Code/cto/` directory doesn't need to be a git repo — it's a working dir like other agent dirs. No commit needed here.

- [ ] **Step 3: Write the Roger spec wrapper**

Write `~/Dropbox/Code/roger/specs/054-codex-cto-agent.md`:

```markdown
# Spec 054 — Codex CTO agent

**Source:** manager dispatch, 2026-04-27.
**Spec:** `~/Dropbox/Code/cane/id-agents/docs/superpowers/specs/2026-04-27-codex-cto-agent-design.md`
**Plan:** `~/Dropbox/Code/cane/id-agents/docs/superpowers/plans/2026-04-27-codex-cto-agent.md`

This spec is a wrapper. The detail lives in the plan. Read both before starting.

## What

Wire OpenAI Codex CLI as a CTO agent (port 4149) in the kilgore id-agents team.
Five steps:

1. `npm install -g @openai/codex` (auth already present at `~/.codex/auth.json`)
2. Create `~/Dropbox/Code/cto/AGENTS.md` with CTO persona (full content in plan Task 2)
3. Add `cto` entry to `kilgore-team.yaml` (full YAML in plan Task 3)
4. Sync the config: `POST http://localhost:4100/remote {"command":"/sync configs/kilgore-team.yaml"}`
5. Append CTO routing section to `~/Dropbox/Code/cane/CLAUDE.md` (full content in plan Task 6)

Then run the smoke test (plan Task 5), then Dispatch 0 (plan Task 8).

## Acceptance

1. `curl http://localhost:4149/health` → 200
2. Smoke test spec review → APPROVED or BOUNCED (not silence, not crash)
3. Dispatch 0 Part 1 produces `~/Dropbox/Code/cto/audit/system-map.md`
4. `grep "CTO routing" ~/Dropbox/Code/cane/CLAUDE.md` → 1 match

## Non-goals

- No code changes to agent-manager-db.ts — routing is instruction-based (CLAUDE.md), not hardcoded
- No XMTP/wallet skills for CTO
- No session continuity — fresh invocation per request by design
```

- [ ] **Step 4: Verify spec file written**

```bash
ls -la ~/Dropbox/Code/roger/specs/054-codex-cto-agent.md
```

Expected: file exists, non-zero size.

---

### Task 8: Dispatch 0 — System orientation audit

**Files:**
- Create: `~/Dropbox/Code/cto/audit/system-map.md` (Codex writes this)
- Create: `~/Dropbox/Code/cto/audit/friction-analysis.md` (Codex writes this)
- Create: `~/Dropbox/Code/cto/audit/build-backlog.md` (Codex writes this)

These three dispatches run sequentially — wait for each part's `cane deliver` callback before sending the next.

- [ ] **Step 1: Dispatch 0 Part 1 — System map**

```bash
curl -s -X POST http://localhost:4149/talk \
  -H "Content-Type: application/json" \
  -d '{
    "from": "manager",
    "message": "Dispatch 0 — Part 1: System map.\n\nRead the following files and produce a comprehensive system map — who does what, how things connect, what is running vs. broken vs. in-flight. No opinions yet, just describe what you see.\n\nFiles to read:\n- ~/Dropbox/Code/cane/id-agents/docs/README.md\n- ~/Dropbox/Code/cane/id-agents/docs/reference/architecture.md\n- ~/Dropbox/Code/cane/CLAUDE.md\n- ~/Dropbox/Code/cane/id-agents/SETUP_LOG.md\n- ~/Dropbox/Code/cane/id-agents/configs/kilgore-team.yaml\n- CLAUDE.md for every agent listed in kilgore-team.yaml (check workingDirectory)\n- ~/Dropbox/Obsidian/Desk.md\n- The two most recent files in ~/Dropbox/Obsidian/sentinel/\n\nSave to: ~/Dropbox/Code/cto/audit/system-map.md\nThen call back via cane deliver."
  }'
```

Wait for the `cane deliver` callback (check delivery log: `tail -5 ~/Dropbox/Code/cane/taskview/delivery-log.md`). Estimated: 30–90 min.

- [ ] **Step 2: Dispatch 0 Part 2 — Friction analysis**

After Part 1 delivery confirmed:

```bash
curl -s -X POST http://localhost:4149/talk \
  -H "Content-Type: application/json" \
  -d '{
    "from": "manager",
    "message": "Dispatch 0 — Part 2: Friction analysis.\n\nRead ~/Dropbox/Code/cto/audit/system-map.md.\n\nIdentify the top friction points in this system — loops that do not close, information that gets lost, architecture that is fragile or redundant, things that break repeatedly. Be specific: reference agent names, file paths, and observed patterns.\n\nSave to: ~/Dropbox/Code/cto/audit/friction-analysis.md\nThen call back via cane deliver."
  }'
```

Wait for `cane deliver` callback.

- [ ] **Step 3: Dispatch 0 Part 3 — Build backlog**

After Part 2 delivery confirmed:

```bash
curl -s -X POST http://localhost:4149/talk \
  -H "Content-Type: application/json" \
  -d '{
    "from": "manager",
    "message": "Dispatch 0 — Part 3: Build backlog.\n\nRead ~/Dropbox/Code/cto/audit/system-map.md and ~/Dropbox/Code/cto/audit/friction-analysis.md.\n\nProduce a prioritized backlog of improvements and new ideas. Sort by leverage × feasibility. Include both improvements to existing systems (finances dashboard, Desk, inbox flow, agent routing) and net-new builds. Include your reasoning for each item.\n\nSave to: ~/Dropbox/Code/cto/audit/build-backlog.md\nThen call back via cane deliver."
  }'
```

Wait for `cane deliver` callback.

- [ ] **Step 4: Verify all three outputs exist**

```bash
ls -la ~/Dropbox/Code/cto/audit/
wc -l ~/Dropbox/Code/cto/audit/*.md
```

Expected: three `.md` files, each 50+ lines.

- [ ] **Step 5: Symlink audit outputs to Obsidian**

```bash
mkdir -p ~/Dropbox/Obsidian/cto/audit
ln -sf ~/Dropbox/Code/cto/audit/system-map.md ~/Dropbox/Obsidian/cto/audit/system-map.md
ln -sf ~/Dropbox/Code/cto/audit/friction-analysis.md ~/Dropbox/Obsidian/cto/audit/friction-analysis.md
ln -sf ~/Dropbox/Code/cto/audit/build-backlog.md ~/Dropbox/Obsidian/cto/audit/build-backlog.md
```

---

## Full acceptance checklist

- [ ] `codex --version` prints a version number
- [ ] `curl -s http://localhost:4149/health` → 200
- [ ] Smoke test (Task 5) returns APPROVED or BOUNCED — not silence
- [ ] `grep "CTO routing" ~/Dropbox/Code/cane/CLAUDE.md` → 1 match
- [ ] Three Dispatch 0 files exist in `~/Dropbox/Code/cto/audit/`

---

## Out of scope (parking lot)

- Hardcoded routing logic in agent-manager-db.ts — routing is CLAUDE.md-based for now
- Dedicated plan-writing agent (separate from CTO) — future
- Codex reviewing its own plans (circular)
- XMTP/wallet skills for CTO
- Session continuity across invocations (fresh-per-invocation is by design)

---

## Self-review

**Spec coverage:**

| Spec section | Plan task |
|---|---|
| §2 Locked decisions (codex runtime, all 3 triggers, approach A, auth, plan writing) | Tasks 1–4, 6 |
| §4 Agent identity (name, port, workingDir, runtime, AGENTS.md) | Tasks 2–4 |
| §5.1 kilgore-team.yaml entry | Task 3 |
| §5.2 AGENTS.md persona | Task 2 |
| §5.3 Three trigger flows (curl commands) | Task 6 (CLAUDE.md routing section) |
| §5.4 codex_skip flag | Task 6 (CLAUDE.md routing section) |
| §6 Error handling | Task 6 (CLAUDE.md routing section) |
| §7 Pre-steps (npm install + verify auth) | Task 1 |
| §8 Acceptance criteria | Task 4 (health), Task 5 (smoke test), Task 6 (routing) |
| Dispatch 0 (from brainstorm) | Task 8 |

All spec sections covered. No gaps.

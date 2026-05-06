# Dispatch Patterns — using ID Agents task lifecycle + handoffs

Guidance for Claude sessions (and other agents) that orchestrate ID Agents work. The goal: every non-trivial unit of work has a visible lifecycle, and multi-step chains don't require the human to manually relay between agents.

Status: captured Apr 2026 after two incidents where ad-hoc `/talk` dispatches lost state. To be evolved as patterns shake out.

---

## 1. Task-first, talk-second

Old pattern:

```
POST /talk → agent works → poll /news → read free-text reply
```

Problem: no persistent record of what's in flight. To see what every agent is doing, you scan `/news` text on each port.

New pattern:

```
POST /tasks   → creates task row (status=todo, shortId, uuid)
POST /talk    → with a reference to the task name in the message
              → agent claims the task (POST /tasks/<name>/claim) and works
              → agent marks done (POST /tasks/<name>/done) with output pointer
GET  /tasks?status=doing   → visible queue (once the manager GET bug is fixed)
```

### Template for the orchestrator's `/talk` message

```
# Task: <task-name>
# Task title: <short description>

<actual work instructions>

# Lifecycle
- Claim this task: POST http://localhost:4100/tasks/<task-name>/claim
- When done, mark done: POST http://localhost:4100/tasks/<task-name>/done
  with body: {"agent_id": "<your-name>"}
- Include the task name in your reply
```

### When to create a task

- Multi-step work (implement, audit, report)
- Anything that produces an artifact (file written to `output/`, spec, report)
- Anything taking >1 round of tool use

### When to skip

- Simple look-ups, greetings, one-line answers
- Work already inside a parent task

---

## 2. Handoff chains

Old pattern: orchestrator dispatches A → waits → reads A's reply → dispatches B → waits → reads B's reply. The orchestrator is the serial glue. When the orchestrator is a human (or a Claude session that might disconnect), the chain breaks.

New pattern: orchestrator dispatches A with instructions that say "when done, dispatch B with the artifact path and a reference to the task you just completed." A uses the `inter-agent` skill to call B directly.

### Template for a handoff dispatch

```
# Task: <task-A-name>
# ... normal instructions for A ...

# Handoff
When this task is done, do ALL of:
1. POST http://localhost:4100/tasks/<task-A-name>/done
2. POST http://localhost:4100/tasks with:
   {
     "title": "<what B should do>",
     "name": "<task-B-name>",
     "from": "<your-name>"
   }
3. Use the inter-agent skill to POST to <B's /talk endpoint>
   with message: "Work task <task-B-name>. Input artifact: <path>. Prior task: <task-A-name>."
4. Reply to the orchestrator with both task names and artifact paths.
```

### Which agents can hand off to which

- **Any agent → Roger** for coding work (after writing a spec)
- **Any agent → any data/research agent** (finances, personal, defi, pipeline) for research that feeds into its own work
- **Roger → reviewer agent** (future: code-review agent) before merge
- **Do NOT hand off to Cane automatically** — Cane handles inbound triage and interacts with the human. Cane receives handoffs, does not initiate them without human direction.
- **Do NOT hand off to Sentinel** — Sentinel's role is observation, not action.

### Example chain (finances → Roger, as of spec 028)

```
Orchestrator → finances:
  "Write spec 028 for crypto-netting fix. When done, create task
   implement-spec-028, post to Roger, reply to me with both task
   names."

finances →
  (writes spec)
  POST /tasks name=write-spec-028, marks done
  POST /tasks name=implement-spec-028, status=todo
  POST http://localhost:4128/talk to Roger with task reference
  Replies: "Task write-spec-028 done. Task implement-spec-028
            dispatched to Roger. Spec at <path>."

Roger →
  POST /tasks/implement-spec-028/claim
  (builds)
  POST /tasks/implement-spec-028/done with output ref
  Replies in /news with completion summary
```

---

## 3. Failure modes we've hit + fixes

| Failure | Cause | Mitigation |
|---|---|---|
| Manager inherits parent Claude Code session's auth, all agents 401 | Started manager from inside a `claude` session | Always restart manager with `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -u CLAUDE_AGENT_SDK_VERSION nohup node dist/start-agent-manager.js &`. See SETUP_LOG.md for full command. |
| Scheduler silently stops firing | Unknown — manager alive, scheduler tick dead | Spec 031 (scheduler liveness monitor) — external check that alerts on >3h no-fire in work window |
| /health green but agent can't answer LLM prompts | /health is TCP-only, does not exercise auth | Spec 030 (deep-health heartbeats) — per-agent trivial prompt every 60 min |
| Roger deletes too much during a fix | No diff review before merge | Future: pre-merge review agent / Codex integration |
| Dispatches get forgotten, state only in `/news` text | `/talk` is looser than `/tasks` | This document — task-first pattern |

---

## 4. Open questions / things to firm up

- **Fan-out**: one orchestrator task dispatches to 4 parallel agents. Does the orchestrator task stay `doing` until all 4 return, or is it immediately `done` with 4 child tasks tracked separately?
- **Task cleanup**: who deletes completed tasks? Keep them forever (Sentinel can read history) or rotate after N days?
- **Task visibility in UI**: the skateboard dashboard (spec 029) should include a "tasks in flight" panel once the GET /tasks bug is fixed.
- **GET /tasks bug**: manager responds 404 even though route is registered. Logged to feedback-for-prem.md 2026-04-20.

---
name: inter-agent
description: Communicate with other agents in your team — send messages, delegate tasks, list agents, check news. Use when asked to contact another agent or coordinate work.
allowed-tools: Bash
---

# Inter-Agent Communication

You are part of a multi-agent team. You can communicate with other agents to delegate tasks, ask for help, or coordinate work.

**IMPORTANT:** Always use `curl` via the Bash tool for agent communication. Do NOT use SendMessage, Agent, or any built-in Claude Code messaging tools — those are a different system and will not reach your team agents.

## Two verbs, three patterns

There are exactly two verbs for reaching another agent — but `/news-to` has two modes, giving you three patterns in total:

- **`/talk-to`** — sync delegation. Blocks until the peer answers (or the timeout fires). Use when you need the answer to continue your work.
- **`/news-to`** (no `trigger`) — passive notification. Recipient files it in their news feed but does **NOT** wake their LLM. Use for one-way status pings.
- **`/news-to` with `{"trigger": true}`** — async delegation. Recipient's LLM processes the message, you do **not** wait for a reply. The recipient can `/news-to` back later with results. Use this for long-running handoffs (telephone chains, pipelines) where the caller must not hold an HTTP connection open.

Rule of thumb:
- Need the answer now to continue → `/talk-to`.
- Just telling somebody something → `/news-to` (no trigger).
- Handing off work that may take minutes/hours and will be returned later → `/news-to` with `trigger: true`.

Both verbs are exposed on your own local agent wrapper (`http://localhost:$ID_AGENT_PORT`). The wrapper looks up the target in the manager catalog and delivers the message.

## Pattern 1 — Sync delegation (`/talk-to`)

Blocks until the reply arrives. The reply comes back in the response body.

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "reviewer", "message": "Is PR #42 safe to merge?", "timeout": 120000}'
```

Use when the answer drives your next step and fits in the timeout budget (max 10 min).

## Pattern 2 — Passive notification (`/news-to`, no trigger)

Returns `202 Accepted` immediately. The message lands in the recipient's news feed but their LLM is **not** woken — they only see it next time they poll `/news` or are otherwise active.

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to": "pm", "message": "FYI: deploy to staging finished, all green"}'
```

Use for status pings, broadcasts, "I claimed this task", "heads up — restarting in 5".

## Pattern 3 — Async delegation (`/news-to` with `trigger: true`)

Returns `202 Accepted` immediately. The recipient's LLM **is** woken and processes the message as a new task. You do not get a reply on this HTTP call — the recipient can `/news-to` you back later when they have results.

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to": "indexer", "message": "Reindex blocks 19000000-19100000 and news-to me when done", "trigger": true}'
```

This is the right primitive for:
- **Telephone chains** (A → B → C → A) where each hop takes unbounded time
- **Long-running pipelines** (data ingests, backfills, large builds)
- Any handoff where holding a sync HTTP connection open would be wrong

Tell the recipient in the message body how to return results — usually "news-to me when done" or "news-to $OTHER_AGENT when done".

## Do not use /message

The old `/message` endpoint on the manager is **deprecated** — it responds with an `X-Deprecated` header and will be removed. Use `/talk-to` or `/news-to` on your local wrapper instead.

## List Available Agents

```bash
curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq
```

The `name` field is the agent's full identifier (ENS domain after registration, or local name). Always use this name as the `to` value when sending messages.

## How Replies Work (Automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to run any curl command to reply.

1. Another agent sends you a message via `/talk-to` (which reaches you as `/talk`)
2. You process the message and generate your response
3. Your response is automatically sent back to the sender

**DO NOT** run curl against `/news` or `/news-to` to reply — your text output IS the reply.

## When to use which pattern

- **`/talk-to`**: asking a question, delegating work you need the result of, requesting a review — anything where the answer unblocks your next step within minutes
- **`/news-to`** (no trigger): status updates, "I claimed this task", "heads up — I'm about to restart", broadcasts — passive notifications that don't need the recipient to act now
- **`/news-to`** with `{"trigger": true}`: handing off long-running work (pipelines, indexes, large builds) where the recipient must process but the caller must not block
- **Neither**: when replying to a message you received (the reply is automatic)

## Mandatory Rule: When Asked to "Ask Another Agent"

If the user or manager says "ask coder ...", "can you ask x ...", or requests you to contact another agent:

1. You MUST use `/talk-to` (via curl and Bash) to contact them and WAIT for their reply
2. Include the reply in your response so the person who asked gets the answer
3. Do NOT use SendMessage, Agent, or other built-in tools — use curl

Example:
```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "x", "message": "What do you know about the manager?", "timeout": 120000}'
```

## Check Your News Feed

Your news feed contains incoming messages, conversation history, and task results. Poll with the `since_id` cursor for incremental updates:

```bash
# First poll — pick up everything new and save the returned next_since_id
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=0&limit=100" | jq

# Subsequent polls — pass the last id you saw
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=$LAST_ID&limit=100" | jq
```

The response includes `items[]` (ascending by id) and `next_since_id` when there is more to fetch. Each item carries an `id`, `type`, `timestamp`, `message`, and optional `data` / `query_id` / `kind` (`talk` or `notify`) / `reply_expected`.

The older `?since=<ms-timestamp>` cursor still works for one release but is deprecated — the response will include an `X-Deprecated` header. Prefer `since_id`.

Check your news feed before starting new tasks to maintain context.

## Task Management

The manager has a dedicated `/tasks` API for coordinating work.

**Create a task** (when you discover work that needs doing):
```bash
curl -s -X POST $MANAGER_URL/tasks \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"title": "Fix the overflow bug", "name": "fix-overflow", "from": "'$ID_AGENT_ALIAS'"}'
```

**Claim an unassigned task** (take responsibility for it):
```bash
curl -s -X POST $MANAGER_URL/tasks/fix-overflow/claim \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"agent_id": "'$ID_AGENT_ALIAS'"}'
```

**Mark your task done** (when you finish):
```bash
curl -s -X POST $MANAGER_URL/tasks/fix-overflow/done \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"agent_id": "'$ID_AGENT_ALIAS'"}'
```

**List tasks** (see what needs doing):
```bash
curl -s "$MANAGER_URL/tasks?status=todo" -H "X-Id-Team: $ID_TEAM" | jq
```

**Get a single task:**
```bash
curl -s "$MANAGER_URL/tasks/fix-overflow" -H "X-Id-Team: $ID_TEAM" | jq
```

Tasks have three statuses: `todo` (unclaimed), `doing` (someone is working on it), `done` (completed). When you find work during a review or heartbeat, create a task so it gets tracked.

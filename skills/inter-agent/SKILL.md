---
name: inter-agent
description: Communicate with other agents in your team — send messages, delegate tasks, list agents, check news. Use when asked to contact another agent or coordinate work.
allowed-tools: Bash
---

# Inter-Agent Communication

You are part of a multi-agent team. Communicate with other agents via `curl` from the Bash tool. Do **NOT** use SendMessage, Agent, or any built-in Claude Code messaging tools — those are a different system and will not reach your team agents.

## The three patterns — copy these exactly

There are three ways to reach another agent. Copy the example for your case verbatim and change only `to` and `message`.

### 1. `/talk-to` — sync delegation (you need the reply)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"what is your name?"}'
```

Blocks until the recipient replies. The reply is in the response body.

### 2. `/news-to` without `trigger` — passive notification (LLM is NOT woken)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"I am ready for work"}'
```

Returns 202 immediately. The message lands in the recipient's news feed but their LLM is **not** woken. They see it the next time they poll `/news` or are otherwise active. Use for status pings, "I claimed this task", "heads up — restarting in 5".

### 3. `/news-to` with `"trigger":true` — async delegation (LLM IS woken)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"I have a message, please pass it to the manager","trigger":true}'
```

Returns 202 immediately. The recipient's LLM **is** woken and processes the message as a new task. You do not get a reply on this HTTP call — the recipient can `/news-to` you back later with results. Use for telephone chains, long-running pipelines, and any handoff where holding a sync HTTP connection open would be wrong.

> ⚠️ **Critical: `trigger` is a literal boolean — copy the example above exactly.**
>
> When you want the recipient's LLM to actually process the message, the JSON body **MUST** include `"trigger":true` as a literal boolean (not a string, not omitted). Omitting the `trigger` field is a silent delivery failure: the message is stored in the recipient's news feed but the recipient **never processes it**. No error is returned — the call looks successful but the work never happens.
>
> If your intent is async delegation (pattern 3), the string `"trigger":true` **must** appear inside the JSON body. Copy the pattern-3 example above verbatim; do not reconstruct it from memory.

## When in doubt, use `/talk-to`

When you are not sure whether to use `/news-to` with `trigger:true` or `/talk-to`, **use `/talk-to`**. It blocks until the recipient replies, which is simpler to reason about for most cases — you get the answer back in-line and can continue your work. Only use `/news-to` with `trigger:true` when you specifically want async delegation: you don't need the reply in-line, but you do want the recipient to actually process the work.

Decision shortcut:
- Need the answer now to continue → `/talk-to` (pattern 1).
- Just telling somebody something → `/news-to` without `trigger` (pattern 2).
- Handing off work that may take minutes/hours and will be returned later → `/news-to` with `trigger:true` (pattern 3).

## Mandatory rule: when asked to "ask another agent"

If the user or manager says "ask coder …", "can you ask x …", or requests you to contact another agent:

1. You MUST use `/talk-to` (pattern 1) via curl and WAIT for their reply.
2. Include the reply in your response so the person who asked gets the answer.
3. Do NOT use SendMessage, Agent, or other built-in tools — use curl.

## Do not use `/message`

The old `/message` endpoint on the manager is **deprecated** — it responds with an `X-Deprecated` header and will be removed. Use `/talk-to` or `/news-to` on your local wrapper instead.

## How replies work (automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to run any curl command to reply.

1. Another agent sends you a message via `/talk-to` (which reaches you as `/talk`).
2. You process the message and generate your response.
3. Your response is automatically sent back to the sender.

**DO NOT** run curl against `/news` or `/news-to` to reply — your text output IS the reply.

## List available agents

```bash
curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq
```

The `name` field is the agent's full identifier (ENS domain after registration, or local name). Always use this name as the `to` value when sending messages.

Both `/talk-to` and `/news-to` are exposed on your own local agent wrapper (`http://localhost:$ID_AGENT_PORT`). The wrapper looks up the target in the manager catalog and delivers the message.

## Check your news feed

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

## Task management

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

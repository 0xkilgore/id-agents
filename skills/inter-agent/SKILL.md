---
name: inter-agent
description: Communicate with other agents in your team — send messages, delegate tasks, list agents, check news. Use when asked to contact another agent or coordinate work.
allowed-tools: Bash
---

# Inter-Agent Communication

You are part of a multi-agent team. You can communicate with other agents to delegate tasks, ask for help, or coordinate work.

**IMPORTANT:** Always use `curl` via the Bash tool for agent communication. Do NOT use SendMessage, Agent, or any built-in Claude Code messaging tools — those are a different system and will not reach your team agents.

## Send a Message to Another Agent

Use `/message` to send a message without waiting (fire-and-forget):

```bash
curl -s -X POST $MANAGER_URL/message \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"to": "agent-name", "message": "Your message here"}'
```

This delivers the message and returns immediately. Use this for delegating tasks, relaying requests, and sending notifications.

### Waiting for a reply

If you need the agent's answer to complete your response, use your own `/talk-to` endpoint:

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "Your question?", "timeout": 120000}'
```

This blocks until the reply arrives (no polling). The reply comes back in the response.

**Use `/talk-to` when:** you need data from the agent to complete your own response.
**Use `/message` when:** relaying a request, delegating a task, or sending a notification.

## List Available Agents

```bash
curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq
```

The `name` field is the agent's full identifier (ENS domain after registration, or local name). Always use this name when sending messages.

## How Replies Work (Automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to use `/message` or any curl command to reply.

1. Another agent sends you a message via `/talk`
2. You process the message and generate your response
3. Your response is automatically sent back to the sender

**DO NOT** use `/message` to reply to incoming messages or to message the manager to report status.
**DO** simply respond to the message in your output — that IS your reply.

## When to use /message vs /talk-to

- **`/message`** (fire-and-forget): delegating tasks, relaying requests, sending notifications
- **`/talk-to`** (wait for reply): when you need the answer to continue your work
- Neither: when replying to messages you received (replies are automatic)

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

4. Do NOT use /message to message the manager — your response is automatically sent back

## Check Your News Feed

Your news feed contains incoming messages, conversation history, and task results:

```bash
curl -s "$MANAGER_URL/news?since=0" -H "X-Id-Team: $ID_TEAM" | jq
```

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

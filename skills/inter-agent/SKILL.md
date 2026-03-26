---
name: inter-agent
description: Communicate with other agents in your team — send messages, delegate tasks, list agents, check news. Use when asked to contact another agent or coordinate work.
allowed-tools: Bash
---

# Inter-Agent Communication

You are part of a multi-agent team. You can communicate with other agents to delegate tasks, ask for help, or coordinate work.

## Send a Message to Another Agent

Use the `/message` endpoint to contact other agents:

```bash
curl -s -X POST $MANAGER_URL/message \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \
  -d '{"to": "agent-name", "message": "Your message here"}'
```

This delivers the message and returns immediately.

### Waiting for a reply

If you need the agent's answer to complete your response, add `"wait": true`:

```bash
curl -s -X POST $MANAGER_URL/message \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \
  -d '{"to": "agent-name", "message": "Your question?", "wait": true, "timeout": 120000}'
```

**Use `"wait": true` when:** you need data from the agent to complete your own response.
**Do NOT use `"wait": true` when:** relaying a request, delegating a task, or sending a notification.

## List Available Agents

```bash
curl -s $MANAGER_URL/agents -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq
```

The `name` field is the agent's full identifier (ENS domain after registration, or local name). Always use this name when sending messages.

## How Replies Work (Automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to use `/message` or any curl command to reply.

1. Another agent sends you a message via `/talk`
2. You process the message and generate your response
3. Your response is automatically sent back to the sender

**DO NOT** use `/message` to reply to incoming messages or to message the manager to report status.
**DO** simply respond to the message in your output — that IS your reply.

## When TO use /message

- When YOU want to initiate a conversation with another agent
- When explicitly asked to "go ask agent-x about something"
- NOT for replying to messages you received (replies are automatic)

## Mandatory Rule: When Asked to "Ask Another Agent"

If the user says "ask coder1 ...", "go ask the manager ...", or requests you to relay information:

1. You MUST actually contact the target agent (do not guess)
2. Use `/message` to deliver the request
3. Do NOT use /message to message the manager — your response is automatically sent back
4. In your final response, confirm what you sent and that it was delivered

## Check Your News Feed

Your news feed contains incoming messages, conversation history, and task results:

```bash
curl -s "$MANAGER_URL/news?since=0" -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq
```

Check your news feed before starting new tasks to maintain context.

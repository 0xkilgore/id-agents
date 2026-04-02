# Inter-Agent Communication Skill

This skill enables you to discover and communicate with other agents in the ID agent team.

## Your Identity

You are an agent in the ID agent team. Your identity is stored in environment variables:

- `ID_AGENT_NAME` - Your full name including token ID (e.g., "max.71")
- `ID_AGENT_ALIAS` - Your base name (e.g., "max")
- `ID_AGENT_TOKEN_ID` - Your onchain token ID (e.g., "71")
- `ID_TEAM` - The team you belong to

**When introducing yourself or signing messages, always use your full name from `$ID_AGENT_NAME`.**

## Overview

You are running in a multi-agent environment where multiple Claude agents can work together. Each agent has its own specialization and can communicate with other agents.

## Talk to Another Agent (Recommended)

**Use the `/message` endpoint on your own server** - it sends a message and waits for the reply automatically:

```bash
curl -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "Your question or task here"}'
```

**Important:** Always use `localhost:4100` - this is YOUR agent's server. The `/message` endpoint handles routing to other agents automatically.

This will:
1. Look up the target agent via the manager
2. Send your message to the target agent
3. Wait for their reply (up to 2 minutes by default)
4. Return the reply directly

**Response:**
```json
{
  "success": true,
  "from": "agent-name",
  "reply": "Here's my response...",
  "query_id": "query_123"
}
```

### Timeout Configuration

For longer tasks, specify a longer timeout (max 10 minutes):

```bash
# 5 minute timeout for complex tasks
curl -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "Analyze this codebase", "timeout": 300000}'
```

**Important:** When using longer timeouts, set the Bash tool timeout to match:
- Default: 2 minutes (120000ms)
- For complex tasks: 5 minutes (300000ms)
- Maximum: 10 minutes (600000ms)

## List Available Agents

To see what other agents are available, use your MANAGER_URL:

```bash
curl "${MANAGER_URL}/agents"
```

Response:
```json
{
  "agents": [
    {
      "id": "agent_1234_abc",
      "name": "coding-agent",
      "model": "claude-haiku-4-5-20251001",
      "status": "running"
    }
  ]
}
```

## Usage Examples

### Example 1: Ask Another Agent a Question

```bash
# Simple question - uses default 2 min timeout
curl -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d '{"to": "researcher", "message": "What are React best practices?"}'
```

### Example 2: Delegate a Complex Task

```bash
# Complex task - use 5 min timeout (set Bash tool timeout to 300000)
curl -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d '{"to": "coder", "message": "Create a login form component", "timeout": 300000}'
```

### Example 3: Coordinate Multiple Agents

```bash
# Ask researcher first
RESEARCH=$(curl -s -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d '{"to": "researcher", "message": "What are the best button design patterns?"}')

# Use research to inform the coder
PATTERNS=$(echo $RESEARCH | jq -r '.reply')
curl -X POST "http://localhost:4100/message" \
  -H "Content-Type: application/json" \
  -d "{\"to\": \"coder\", \"message\": \"Create a button using these patterns: $PATTERNS\"}"
```

## When to Use Inter-Agent Communication

Use this skill when you need to:

1. **Delegate specialized tasks** - Another agent might be better suited
2. **Coordinate work** - Multiple agents working on related tasks
3. **Get second opinions** - Consult another agent for validation
4. **Combine expertise** - One agent researches, another implements
5. **Scale work** - Distribute tasks across multiple agents

## How It Works

The `/message` endpoint uses event-driven waiting (no polling):

```
Your Agent                    Manager                   Target Agent
    │                            │                           │
    ├─ POST /message ──────────► │                           │
    │  (localhost:4100)          │                           │
    │                            ├── Lookup target agent ──► │
    │                            │                           │
    │                            │ ◄── POST /talk ──────────►│
    │                            │                           │
    │   ◄───── waits ─────►      │                           │
    │                            │                           │
    │ ◄──── POST /news ──────────│ ◄── reply ───────────────┤
    │  (reply arrives)           │                           │
    │                            │                           │
    ├── Returns reply            │                           │
```

- No polling required
- Reply comes directly back via the same HTTP request
- Complete conversation history saved in both agents' `/news` feeds

## Advanced: Direct API Usage

If you need more control, you can use the lower-level endpoints:

### POST /talk (async)
Send a message without waiting (on YOUR server):
```bash
curl -X POST "http://localhost:4100/talk" \
  -H "Content-Type: application/json" \
  -d '{"message": "Your message", "from": "your-agent-name"}'
```

### GET /news (poll)
Check your news feed for replies (on YOUR server):
```bash
curl "http://localhost:4100/news?since=0"
```

### POST /news (receive)
Receive messages/replies (used internally):
```bash
curl -X POST "http://localhost:4100/news" \
  -H "Content-Type: application/json" \
  -d '{"type": "reply", "from": "sender", "message": "...", "in_reply_to": "query_123"}'
```

## Best Practices

1. **Use `/message` for most cases** - It handles waiting and replies automatically
2. **Set appropriate timeouts** - Match task complexity to timeout duration
3. **Be specific in messages** - Clearly state what you need from the other agent
4. **Check agent list first** - Verify the target agent exists before sending
5. **Use `localhost:4100` for your own endpoints** - Never use other ports for `/message`
6. **Use `$MANAGER_URL` for manager endpoints** - Like `/agents` listing

## Port Reference

- `localhost:4100` - YOUR agent's server (use for `/message`, `/talk`, `/news`)
- `$MANAGER_URL` - The manager server (use for `/agents` listing)

## Important Notes

- Each agent has its own workspace and cannot directly access your files
- Use your team's shared directory (`/workspace/teams/<team-name>/`) to exchange files between agents
- Agents can see each other's names but not internal state
- The `/message` endpoint automatically handles reply routing - no manual polling needed
- The `MANAGER_URL` environment variable is set automatically when agents are deployed

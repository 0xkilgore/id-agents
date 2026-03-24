# Inter-Agent Communication Skill

This skill enables you to discover and communicate with other agents in the ID agent cluster.

## Overview

You are running in a multi-agent environment where multiple Claude agents can work together. Each agent has its own specialization and can communicate with other agents.

## Talk to Another Agent (Recommended)

**Use the `/talk-to` endpoint** - it sends a message and waits for the reply automatically:

```bash
curl -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "Your question or task here"}'
```

This will:
1. Send your message to the target agent
2. Wait for their reply (up to 2 minutes by default)
3. Return the reply directly

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
curl -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "Analyze this codebase", "timeout": 300000}'
```

**Important:** When using longer timeouts, set the Bash tool timeout to match:
- Default: 2 minutes (120000ms)
- For complex tasks: 5 minutes (300000ms)
- Maximum: 10 minutes (600000ms)

## List Available Agents

To see what other agents are available:

```bash
curl http://localhost:4100/agents
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
curl -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "researcher", "message": "What are React best practices?"}'
```

### Example 2: Delegate a Complex Task

```bash
# Complex task - use 5 min timeout (set Bash tool timeout to 300000)
curl -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "coder", "message": "Create a login form component", "timeout": 300000}'
```

### Example 3: Coordinate Multiple Agents

```bash
# Ask researcher first
RESEARCH=$(curl -s -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "researcher", "message": "What are the best button design patterns?"}')

# Use research to inform the coder
PATTERNS=$(echo $RESEARCH | jq -r '.reply')
curl -X POST http://localhost:4100/talk-to \
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

The `/talk-to` endpoint uses event-driven waiting (no polling):

```
Your Agent                    Target Agent
    │                              │
    ├── POST /talk-to ────────────►│
    │   (sends message)            │
    │                              ├── Processes request
    │   ◄─── waits ───►            │
    │                              │
    │◄──────── POST /news ─────────┤
    │   (reply arrives)            │
    │                              │
    ├── Returns reply              │
```

- No polling required
- Reply comes directly back via the same HTTP request
- Complete conversation history saved in both agents' `/news` feeds

## Advanced: Direct API Usage

If you need more control, you can use the lower-level endpoints:

### POST /talk (async)
Send a message without waiting:
```bash
curl -X POST http://localhost:PORT/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "Your message", "from": "your-agent-name"}'
```

### GET /news (poll)
Check your news feed for replies:
```bash
curl http://localhost:4100/news?since=0
```

### POST /news (receive)
Receive messages/replies (used internally):
```bash
curl -X POST http://localhost:4100/news \
  -H "Content-Type: application/json" \
  -d '{"type": "reply", "from": "sender", "message": "...", "in_reply_to": "query_123"}'
```

## Best Practices

1. **Use `/talk-to` for most cases** - It handles waiting and replies automatically
2. **Set appropriate timeouts** - Match task complexity to timeout duration
3. **Be specific in messages** - Clearly state what you need from the other agent
4. **Check agent list first** - Verify the target agent exists before sending

## Important Notes

- Each agent has its own workspace and cannot directly access your files
- Use your team's shared directory (`/workspace/teams/<team-name>/`) to exchange files between agents
- Agents can see each other's names but not internal state
- The `/talk-to` endpoint automatically handles reply routing - no manual polling needed

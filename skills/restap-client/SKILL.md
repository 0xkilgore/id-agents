# REST-AP Client Skill

A generic REST-AP client for testing and interacting with agents via the REST-AP protocol.

## Overview

This skill provides tools to interact with any REST-AP compatible agent, including:
- Sending messages (`/talk`)
- Receiving news/replies (`/news`)
- Checking agent discovery (`/.well-known/restap.json`)

## Quick Start

```bash
# Set target agent URL
export AGENT_URL="http://localhost:4101"

# Send a message
./skills/restap-client/talk.sh "Hello, what is your name?"

# Check for news/replies
./skills/restap-client/news.sh

# Get agent discovery info
./skills/restap-client/discover.sh
```

## Scripts

### talk.sh - Send a message

```bash
./skills/restap-client/talk.sh <message> [from] [reply_endpoint]
```

Parameters:
- `message` - The message to send (required)
- `from` - Sender name (default: "test-client")
- `reply_endpoint` - Where to send replies (optional)

Example:
```bash
./skills/restap-client/talk.sh "What is your name?" tester
```

### news.sh - Get news feed

```bash
./skills/restap-client/news.sh [since]
```

Parameters:
- `since` - Only get news items after this ID (default: 0)

Example:
```bash
./skills/restap-client/news.sh 0
```

### discover.sh - Get discovery document

```bash
./skills/restap-client/discover.sh
```

Returns the `/.well-known/restap.json` document describing the agent's capabilities.

### listen.sh - Start a listener for replies

```bash
./skills/restap-client/listen.sh [port]
```

Starts a temporary HTTP server to receive replies. Default port: 4200.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_URL` | `http://localhost:4101` | Target agent URL |
| `LISTENER_PORT` | `4200` | Port for reply listener |

## Testing Workflows

### Basic Test - Ask Agent Name

```bash
export AGENT_URL="http://localhost:4101"

# Send a simple message
./skills/restap-client/talk.sh "What is your name?"

# Wait a moment for processing, then check news
sleep 2
./skills/restap-client/news.sh
```

### Interactive Test with Listener

```bash
# Terminal 1: Start listener
./skills/restap-client/listen.sh 4200

# Terminal 2: Send message with reply endpoint
export AGENT_URL="http://localhost:4101"
./skills/restap-client/talk.sh "Hello!" tester "http://localhost:4200/news"
```

### Test Multiple Agents

```bash
# Test agent on port 4101
AGENT_URL="http://localhost:4101" ./skills/restap-client/talk.sh "Name?"

# Test agent on port 4102
AGENT_URL="http://localhost:4102" ./skills/restap-client/talk.sh "Name?"
```

## REST-AP Protocol Reference

### POST /talk
Send a message to an agent.

```json
{
  "message": "Your message here",
  "from": "sender-name",
  "reply_endpoint": "http://your-url/news"
}
```

### GET /news
Get the agent's news feed.

Query params:
- `since` - Only return items with ID > since

Response:
```json
{
  "items": [
    {
      "id": 1,
      "type": "message",
      "from": "someone",
      "message": "Hello",
      "timestamp": "2024-01-15T..."
    }
  ]
}
```

### POST /news
Receive a message/reply (push notification).

```json
{
  "type": "reply",
  "from": "sender",
  "message": "Response here",
  "in_reply_to": "query_123"
}
```

### GET /.well-known/restap.json
Discovery document.

```json
{
  "name": "agent-name",
  "version": "1.0",
  "endpoints": {
    "talk": "/talk",
    "news": "/news"
  }
}
```

## Using with Test Manager

For external testing without the CLI, use the test-manager:

```bash
# Start test manager on port 5000
node tools/test-manager/index.js --port 5000

# Point client at an agent managed by test-manager
export AGENT_URL="http://localhost:5001"
./skills/restap-client/talk.sh "Hello from external test!"
```

See `tools/test-manager/README.md` for details.

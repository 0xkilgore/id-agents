# Test Manager

A standalone REST-AP manager for testing agent communication without the full CLI infrastructure.

## Features

- **No database required** - Uses in-memory storage
- **External agent registration** - Register any REST-AP compatible agent by URL
- **Synchronous messaging** - `/talk-to` endpoint for send-and-wait
- **Full REST-AP support** - `/talk`, `/news`, discovery document
- **Agent pinging** - Check if agents are reachable

## Quick Start

```bash
# Start test manager on default port (5000)
node tools/test-manager/index.js

# Or specify a port
node tools/test-manager/index.js --port=6000

# Or use environment variable
TEST_MANAGER_PORT=6000 node tools/test-manager/index.js
```

## Usage

### Register an External Agent

Register an agent that's running somewhere (could be managed by the real CLI):

```bash
curl -X POST http://localhost:5000/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "myagent", "url": "http://localhost:4101", "tokenId": "42"}'
```

### List Agents

```bash
curl http://localhost:5000/agents
```

### Send a Message (Synchronous)

Send a message and wait for the reply:

```bash
curl -X POST http://localhost:5000/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "myagent", "message": "What is your name?"}'
```

### Ping an Agent

Check if an agent is reachable:

```bash
curl http://localhost:5000/agents/myagent/ping
```

### Reset

Clear all registered agents:

```bash
curl -X POST http://localhost:5000/reset
```

## API Reference

### GET /health
Health check endpoint.

### GET /.well-known/restap.json
REST-AP discovery document.

### GET /agents
List all registered agents.

### POST /agents/register
Register an external agent.

Body:
```json
{
  "name": "agent-name",
  "url": "http://agent-host:port",
  "tokenId": "optional-token-id"
}
```

### GET /agents/resolve/:ref
Resolve an agent reference (by name, id, or tokenId).

### GET /agents/by-name/:name
Get agent by name.

### DELETE /agents/:id
Remove a registered agent.

### POST /talk-to
Send a message to an agent and wait for reply.

Body:
```json
{
  "to": "agent-name",
  "message": "Your message",
  "timeout": 120000
}
```

### POST /talk
Receive a message (REST-AP standard).

### GET /news
Get the news feed.

Query params:
- `since` - Only return items with id > since

### POST /news
Receive a reply (REST-AP standard).

### GET /agents/:id/ping
Ping an agent to check if it's reachable.

### POST /reset
Clear all agents and news.

## Testing Workflow

### Test agents deployed by the CLI

1. Start test manager:
   ```bash
   node tools/test-manager/index.js --port=5000
   ```

2. Deploy agents using the CLI:
   ```bash
   npm run id-agents
   /team start
   /deploy default agent1
   /deploy default agent2
   ```

3. Register the deployed agents with test manager:
   ```bash
   # Find agent ports from CLI output or /agents
   curl -X POST http://localhost:5000/agents/register \
     -d '{"name": "agent1", "url": "http://localhost:4100"}' \
     -H "Content-Type: application/json"
   ```

4. Test communication through test manager:
   ```bash
   curl -X POST http://localhost:5000/talk-to \
     -d '{"to": "agent1", "message": "Hello! What is your name?"}' \
     -H "Content-Type: application/json"
   ```

### Test with the REST-AP client skill

```bash
# Terminal 1: Start test manager
node tools/test-manager/index.js

# Terminal 2: Use REST-AP client to interact
export AGENT_URL="http://localhost:5000"
./skills/restap-client/talk.sh "Hello from test client" test-user
./skills/restap-client/news.sh
```

## Differences from Real Manager

| Feature | Real Manager | Test Manager |
|---------|--------------|--------------|
| Database | PostgreSQL | In-memory |
| Agent spawning | Creates containers | Register external only |
| Persistence | Survives restart | Lost on restart |
| Teams | Multi-tenant | Single namespace |
| Onchain registration | Supported | Not supported |

The test manager is designed for testing REST-AP communication, not for full agent lifecycle management.

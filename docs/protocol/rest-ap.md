# **REST‑AP: REST Agent Protocol**

**Author:** Prem Makeig @nxt3d
**Date:** 11/8/2025 (Updated 1/5/2026 - Added bidirectional POST /news)

**Note:** This document describes the REST-AP protocol specification. For a reference implementation using Claude agents, see the [ID Agents framework](../../README.md).

## **Abstract**

REST-AP is a protocol for building AI agents that can discover and communicate with each other over HTTP. It provides a minimal model that lets clients discover hosted agent capabilities, optionally install helper packages (skills, SDKs, tools), establish sessions, and perform operations using plain REST semantics. REST-AP is intentionally simple: it works with standard HTTP endpoints, optional package registries (npm, PyPI, etc.), and common payment systems. It is designed to interoperate with any agent framework.

## **Goals**

* Make any HTTP API into a minimal AI agent interface that can be discovered, understood, and used by LLMs with almost no protocol overhead.

* Support both free and paid calls. Payment may be required sometimes and not others.

* Provide predictable discovery so clients can compose many endpoints into one mini app.

* Enable session semantics for context, state, and rate limits.

* Allow package based client helpers, for JavaScript, Python, Rust, and others.

* Enable on‑chain verification of client helper integrity using a content hash and optional signature.

## **Non‑Goals**

* Defining a new transport. Use HTTP and HTTPS.

* Replacing OAuth or existing auth methods. Reuse them when helpful.

* Creating a new package registry. Reuse npm and language native registries.

## **Key Concepts and Terms**

**Host.** The service that runs agents and exposes them via HTTP. In ID Agents, this is the Agent Manager and individual Claude agent processes.

**Client.** An agent, application, or user that interacts with hosted agents. Clients can be other agents (agent-to-agent communication) or external applications.

**Catalog.** The discovery document at `/.well-known/restap.json` (required, JSON format) that describes what the host offers. This includes what the agent can do, what helper packages are available, and how to interact with it. The catalog can optionally point to `/restap.md` for detailed human-readable documentation.

**Capabilities.** What an agent can actually do when you talk to it. For example, "create web pages", "analyze data", "coordinate with other agents".

**Agent Discovery.** The process by which clients (including other agents) find available agents on a host. This is implementation-specific and not defined by REST-AP core. Hosts may provide discovery through various means:
- HTTP endpoints (e.g., `GET /agents` in ID Agents)
- On-chain registries (future: ENS, smart contracts)
- Static configuration files
- DNS records
- Any other mechanism

Whatever discovery mechanism the host uses should be advertised in the catalog.

**Helper Package.** Optional software that can be installed by clients or hosts to provide skills, tooling, and convenience wrappers. Examples include:
- **Skills** - Instructions teaching agents how to perform tasks (like inter-agent communication)
- **SDKs** - Language libraries wrapping REST-AP calls (like the ID Agents SDK)
- **Tools** - Executable scripts and utilities (like bash scripts for agent discovery)
- **Templates** - Reusable code patterns and examples

Helper packages make it easier to work with REST-AP but aren't required - you can always use raw HTTP calls.

## **High Level Architecture**

REST‑AP defines the smallest possible sequence of steps required for a client to understand, install, and interact with a hosted agent.

1. **Discovery**. The client fetches a host's catalog at `/.well-known/restap.json` (required, JSON). Optionally reads `/restap.md` for detailed human-readable documentation.

2. **Helper install** (optional). The client or host may install helper packages (e.g., npm packages, skills, scripts) referenced in the catalog.

3. **Package verification** (optional). If the catalog or documentation includes verification information (hashes, signatures, etc.), clients can verify package integrity before use.

4. **Talk**. The client communicates using `POST /talk`, a universal string → string API. Agents can use `/talk` for conversation, commands, or task delegation.

5. **News**. The client checks `GET /news` for asynchronous responses and updates. This includes completed tasks, errors, and progress updates. Polling this endpoint is free (no LLM inference) and can be done as frequently as needed.

### **Minimal Endpoint Set**

REST-AP requires only four endpoints:

* **GET /.well-known/restap.json** - Discovery (catalog of what the agent can do)
* **POST /talk** - Communication (send tasks/messages to the agent, triggers processing)
* **GET /news** - Updates (poll for asynchronous responses)
* **POST /news** - Receive messages/replies (passive storage, no processing)

These four endpoints are sufficient for full agent communication. However, hosts may add additional endpoints as needed for specialized use cases (e.g., file serving, streaming, webhooks, or manager-owned internal scheduling). Additional endpoints should be documented in the catalog.

### Optional Extensions

REST-AP allows hosts to advertise extra endpoints in the catalog beyond the required four. In ID Agents, one important optional extension is:

* **POST /schedule** - Accept manager-owned scheduled work and enqueue it internally without treating it like a normal external `/talk` request

This is not part of the minimum REST-AP contract. It is a host-specific extension that should be explicitly advertised in `/.well-known/restap.json`.

## **The Catalog Document**

The catalog describes what a hosted agent can do. REST-AP requires **two complementary documents**:

### **1. Machine-Readable Discovery (Required)**

**`/.well-known/restap.json`** - JSON endpoint for programmatic discovery

This follows the `.well-known` URI standard (RFC 8615) and must return JSON. Clients and agents use this for automated discovery.

```json
{
  "restap_version": "1.0",
  "agent": {
    "name": "My Agent",
    "description": "I can create web pages and analyze data",
    "contact": "support@example.com",
    "documentation": "/restap.md"
  },
  "endpoints": {
    "talk": "/talk",
    "news": "/news",
    "news_post": "/news"
  },
  "packages": {
    "skills": "/skills/",
    "sdk": "npm install id-agents"
  }
}
```

### **2. Human-Readable Documentation (Recommended)**

**`/restap.md`** - Markdown file for humans

This provides detailed, human-friendly documentation. The JSON catalog should link to it.

```markdown
# My Agent

I can create web pages and analyze data.

Contact: support@example.com

## Quick Start

Talk to me by sending a message:

\`\`\`bash
curl -X POST http://localhost:4101/talk \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Create a landing page"}'
\`\`\`

Check my progress:

\`\`\`bash
curl http://localhost:4101/news
\`\`\`

## What I Can Do

- Create web pages (HTML, CSS, JavaScript)
- Analyze data and generate reports
- Coordinate with other agents
- Execute bash commands

## Available Skills

- **Inter-Agent**: See `/skills/inter-agent/SKILL.md`
- **Web Development**: See `/skills/web-dev/SKILL.md`

## Examples

[Include detailed examples here...]
```

### **Why Both?**

- **JSON** (`/.well-known/restap.json`) - Fast automated discovery by agents/SDKs
- **Markdown** (`/restap.md`) - Rich documentation for humans and LLMs reading context

The `.well-known/restap.json` must be JSON (it's a standard), but it should point to the markdown documentation for details.

## **Payment Model**

REST‑AP does not define any payment mechanism. Hosts may optionally use external systems such as x402 or 402-style HTTP responses. Payment flows occur entirely outside the protocol.

## **Optional Package Verification**

Package verification in REST-AP is intentionally straightforward. Whatever integrity mechanism the package manager already uses—such as checksums, hashes, or signatures—can be anchored on-chain so that clients can confirm correctness before loading helper code.

### **How Package Managers Verify Integrity**

Package managers such as npm, PyPI, and Cargo already verify integrity automatically. When a client installs a package, the package manager computes a hash of the downloaded **tarball** (the actual archive that contains the code) and compares it against the hash stored in its own registry metadata. This ensures the file was not corrupted in transit.

However, this only verifies integrity **relative to the registry**. REST‑AP adds an optional on‑chain hash so clients can verify the package against an independent, trust‑minimized source of truth.

### **How Tarball Verification Works**

1. Your computer downloads the package tarball.  
2. The package manager computes a cryptographic hash of the tarball (e.g., SHA‑256).  
3. It compares that hash to the expected hash from the registry.  
4. If they match, installation continues; if not, it fails.

REST‑AP simply mirrors this same hash on‑chain so that the client can confirm it independently.

### **Host Responsibilities**

Publish the package's integrity hash to an on-chain registry. A common pattern is an ENS text record such as:

pkg:@acme/restap@1.2.0:sha256=0xabc...

This record may live under a name like acme.tools.eth. Any chain, contract, or registry can be used as long as clients can read it.

### **Client Verification Flow**

1. Resolve acme.tools.eth to fetch the text records. Security depends upon only dealing with well known domains.   
2. Extract the integrity key, for example pkg:@acme/restap@1.2.0:sha256.  
3. Compute the corresponding hash of the downloaded package.  
4. Compare the local hash with the on-chain hash.  
5. Refuse to load the helper package if they do not match.

### **Example Pseudocode**

import { readFile } from "node:fs/promises";  
import { createHash } from "node:crypto";  
import { resolveEnsText } from "@ensdomains/ensjs";

async function verifyPackage(pkgTarPath, ensName, key) {  
  const buf \= await readFile(pkgTarPath);  
  const local \= createHash("sha256").update(buf).digest("hex");  
  const onchain \= await resolveEnsText(ensName, key);  
  if (\!onchain) throw new Error("No on-chain record");  
  if (local.toLowerCase() \!== onchain.replace(/^0x/, "").toLowerCase()) {  
    throw new Error("Hash mismatch");  
  }  
  return true;  
}

## **End to End Example Flow**

**Scenario**. A fully free, no‑session REST‑AP provider. Sessions and payments can optionally be added later (see note below).

1. **Discovery**

GET https://api.acme.test/.well-known/restap.json

The client reads the catalog, learns the available REST endpoints, and sees the helper package reference.

2. **Install helper** (optional)

npm i @acme/restap

The helper package exposes simple methods like talk() and endpoint callers.

3. **Verify helper** Use the on‑chain hash verification mechanism described above.  

4. **Talk (Synchronous Pattern)**

For quick responses that complete immediately:

POST https://api.acme.test/talk

{"message": "What is 2+2?"}

Response (immediate):

{"result": "2+2 equals 4"}

5. **Talk + News (Asynchronous Pattern)**

For longer operations that require LLM processing:

**Step 1: Send Message**

POST https://api.acme.test/talk

{"message": "Create a complex web application"}

Response (immediate, ~1ms):

{
  "query_id": "query_123",
  "status": "processing",
  "message": "Task is being processed. Poll /news for completion."
}

**Step 2: Poll for Completion**

GET https://api.acme.test/news?since=0

Response:

{
  "items": [
    {
      "type": "query.completed",
      "timestamp": 1703012345000,
      "data": {
        "query_id": "query_123",
        "result": {
          "result": "Here's the web application code...",
          "sessionId": "session_456",
          "model": "claude-haiku-4-5-20251001"
        }
      }
    }
  ],
  "timestamp": 1703012350000
}

**The actual response is in:** `items[].data.result.result`

**Step 3: Extract the Response**

```bash
# Get news and filter by query_id
NEWS=$(curl -s "https://api.acme.test/news?since=0")
RESULT=$(echo $NEWS | jq -r ".items[] | select(.data.query_id==\"query_123\") | .data.result.result")
echo "$RESULT"
```

### **Why Two Endpoints?**

**POST /talk** - Active (requires LLM work)
- Sends a message that the agent must process
- The LLM reads it, thinks, uses tools, generates a response
- Returns immediately with `202 Accepted` and a `query_id`
- The work happens asynchronously in the background

**GET /news** - Passive (no LLM work)
- Just retrieves what's already happened
- No LLM inference required, no API costs
- Simple polling endpoint
- Can be called as often as needed

**POST /news** - Passive (no LLM work)
- Receives messages/replies from other agents
- No LLM inference required - just stores the message
- Used for sending replies back to the original sender
- Prevents infinite loops (unlike `/talk` which triggers processing)

### **Bidirectional News: Direct Replies**

Instead of requiring senders to poll for responses, agents can send replies directly to the sender's `/news` endpoint:

**Traditional Polling Flow:**
```
Agent A → POST /talk → Agent B (processes)
Agent A ← polls GET /news ← Agent B
```

**Direct Reply Flow:**
```
Agent A → POST /talk → Agent B (processes)
Agent A ← POST /news ← Agent B (sends reply directly)
```

**POST /news Payload:**
```json
{
  "type": "reply",
  "from": "agent-b",
  "in_reply_to": "query_123",
  "message": "Here's my response..."
}
```

**Optional Trigger Processing:**

By default, `POST /news` does NOT trigger LLM processing (it's passive storage). However, you can optionally request processing by adding `trigger: true`:

```json
{
  "type": "message",
  "from": "agent-a",
  "message": "Here's some important info for you",
  "trigger": true
}
```

When `trigger: true`:
- The agent WILL process the message with its LLM
- The prompt is crafted to **prevent infinite loops** - the agent is instructed NOT to reply back to the sender
- The agent can take action based on the message or communicate with OTHER agents
- Returns `202 Accepted` with a `query_id` for tracking

This is useful when you want to notify an agent and have it potentially act on the information, without creating a ping-pong loop.

**Why This Matters:**
- **No polling confusion** - Replies arrive directly instead of being mixed with other news
- **Immediate delivery** - No waiting for poll intervals
- **Clear attribution** - `in_reply_to` links response to original query
- **No infinite loops** - `POST /news` doesn't trigger LLM processing (unlike `/talk`)

**When to Use Each:**
| Endpoint | Use Case | Triggers LLM? |
|----------|----------|---------------|
| `POST /talk` | Send a task/question that needs processing | Yes |
| `GET /news` | Poll for updates and completed tasks | No |
| `POST /news` | Send a reply or notification | No (default) |
| `POST /news` + `trigger: true` | Send info and request optional processing | Yes (loop-safe) |

### **Benefits of This Design**

✅ **No Timeouts** - POST returns immediately, work continues in background
✅ **Cost-Effective** - Polling `/news` is free (no LLM calls)
✅ **Scalable** - One client can wait for many parallel tasks
✅ **Simple** - Just HTTP GET/POST, no WebSockets or streaming
✅ **Resilient** - If polling fails, just try again
✅ **Multiple Tasks** - Track many `query_id`s simultaneously

### **Complete Example: Agent-to-Agent Communication**

This example shows how agents communicate using REST-AP's `/talk` and `/news` endpoints. Discovery (how to find other agents) is implementation-specific and not shown here.

```bash
# Assuming we know Agent B's endpoint (discovery mechanism not shown)
AGENT_B_URL="http://localhost:4102"

# Step 1: Send message to Agent B (returns immediately)
RESPONSE=$(curl -s -X POST $AGENT_B_URL/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "What are the best practices for buttons?"}')

QUERY_ID=$(echo $RESPONSE | jq -r '.query_id')
echo "Query ID: $QUERY_ID"

# Step 2: Wait a bit for Agent B to process
sleep 3

# Step 3: Check for completion
NEWS=$(curl -s "$AGENT_B_URL/news?since=0")

# Step 4: Extract the actual answer
ANSWER=$(echo $NEWS | jq -r \
  ".items[] | select(.data.query_id==\"$QUERY_ID\") | .data.result.result")

echo "Agent B says: $ANSWER"

# Step 5: Use the answer
curl -X POST http://localhost:4101/talk \
  -d "{\"message\": \"Create a button using these best practices: $ANSWER\"}"
```

**Note on Discovery:** How agents find each other is implementation-specific. The host's catalog (at `/.well-known/restap.json`) should document its discovery mechanism. Common approaches:
- HTTP API endpoints
- On-chain registries (ENS, smart contracts)
- DNS TXT records
- Static configuration files

### **Polling Best Practices**

1. **Start with longer intervals** (2-5 seconds) for typical tasks
2. **Use `since` parameter** to only get new items: `/news?since=1703012345000`
3. **Implement exponential backoff** for very long tasks
4. **Check for both completion and failure**:
   - `type: "query.completed"` - Task succeeded
   - `type: "query.failed"` - Task failed with error
5. **Set reasonable timeouts** (30-120 seconds depending on task)

### **Note: Where Sessions and Payments Would Fit**

* A host may add **POST /sessions** to establish a session.  
* A host may return **402 Payment Required** responses if using x402 or any billing system.  
* REST‑AP itself does *not* define these features—they are optional extensions.

## **Security Model**

* **HTTPS required**. Use TLS everywhere.  
* **Idempotency keys**. Prevent double charge on retries.  
* **Replay protection**. Include nonces in tickets and bind to session\_id.  
* **Rate limits**. Enforced per IP and per session.  
* **Isolation**. Run each provider helper package in a restricted context when possible.

## **Comparison with Pure REST without REST‑AP**

* Plain REST lacks a uniform discovery document. REST‑AP adds one.  
* Plain REST lacks a standard for /talk and /news endpoints for LLM based chat and news.   
* Plain REST offers no standard for helper verification. REST‑AP binds helpers to on‑chain proofs.

## **News Polling Instead of Notifications**

REST‑AP avoids complex push systems. Hosts expose a **/news** endpoint that returns a chronological list of updates, such as job completions. The client implements a lightweight polling function to check for new events.

This preserves simplicity and avoids context‑window inflation. Agents don't need to load the entire news feed—only check if relevant events have appeared.

## **Code‑Aware Agents**

A coding‑aware agent only needs the URL to /.well‑known/restap.json.  From this single call, the agent learns:

* available capabilities  
* the helper package to install (npm restap-client, PyPI, Cargo, etc.)

From there, the agent can operate the full REST‑AP surface.

### **In‑Package Endpoints**

An optional pattern is to ship supplemental endpoints, schemas, or documentation inside the helper package itself, e.g., an internal docs/ directory. This enables offline introspection and full local capability awareness.

---

## **Reference Implementation: ID Agents**

[ID Agents](../../README.md) is a complete REST-AP implementation that demonstrates multi-agent coordination using Claude agents.

### **Key Features**

- **Multi-Agent Platform** - Run multiple agents as local processes
- **Full REST-AP Compliance** - Each agent exposes `/.well-known/restap.json`, `/talk`, and `/news`
- **Inter-Agent Communication** - Agents discover and talk to each other using REST-AP
- **Agent Skills** - Agents receive instructions on how to use REST-AP to coordinate work

### **How ID Agents Uses REST-AP**

**1. Agent Discovery**
```bash
# Agents can discover other agents
curl http://localhost:4100/agents

# Returns list of available agents with their REST-AP endpoints
{
  "agents": [
    {
      "name": "coding-agent",
      "port": 4101,
      "url": "http://localhost:4101"
    }
  ]
}
```

**2. Agent Communication**
```bash
# Agent A sends message to Agent B (include sender info)
curl -X POST http://localhost:4102/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "Help me debug this code", "from": "agent-a"}'

# Returns immediately with query_id
{"query_id": "query_123", "status": "processing"}

# Agent B processes the request and sends reply directly to Agent A's /news
# (This happens automatically - Agent A receives the reply without polling)

# Agent A can also poll for Agent B's response (traditional method)
curl http://localhost:4102/news?since=0

# Gets the actual response
{
  "items": [{
    "type": "query.completed",
    "data": {
      "query_id": "query_123",
      "result": {"result": "Here's how to fix it..."}
    }
  }]
}
```

**3. Direct Reply (Bidirectional News)**
```bash
# When Agent B completes processing, it sends the reply directly to Agent A
curl -X POST http://localhost:4101/news \
  -H "Content-Type: application/json" \
  -d '{
    "type": "reply",
    "from": "agent-b",
    "in_reply_to": "query_123",
    "message": "Here is how to fix it..."
  }'

# Agent A receives this in their news feed without needing to poll Agent B
```

**4. REST-AP Discovery**
```bash
# Each agent exposes REST-AP catalog
curl http://localhost:4101/.well-known/restap.json

{
  "restap_version": "1.0",
  "agent": {
    "name": "Claude Agent SDK"
  },
  "capabilities": [
    {
      "id": "talk",
      "method": "POST",
      "endpoint": "/talk",
      "description": "Ask Claude to perform tasks (triggers LLM processing)"
    },
    {
      "id": "news",
      "method": "GET",
      "endpoint": "/news",
      "description": "Poll for task completion and updates"
    },
    {
      "id": "news_receive",
      "method": "POST",
      "endpoint": "/news",
      "description": "Receive messages/replies from other agents (no LLM processing)"
    }
  ]
}
```

### **Architecture**

```
┌─────────────────────────────────────┐
│  Agent Manager (port 4100)         │
│  - Spawns agents on demand          │
│  - Assigns ports and workspaces     │
│  - Tracks agent status              │
└─────────────────────────────────────┘
         │
         ├─ Agent 1 (port 4101)
         │  └── REST-AP: /talk, /news, /.well-known/restap.json
         │
         ├─ Agent 2 (port 4102)
         │  └── REST-AP: /talk, /news, /.well-known/restap.json
         │
         └─ Agent 3 (port 4103)
            └── REST-AP: /talk, /news, /.well-known/restap.json
```

### **Example: Agent Coordination**

```typescript
// Spawn specialized agents
const coder = await spawnAgent('coder');
const researcher = await spawnAgent('researcher');

// Coder asks researcher for help (using REST-AP)
const task = `
  Before I create this component, check with the researcher agent 
  on port ${researcher.port} to get best practices.
  
  Use: curl -X POST http://localhost:${researcher.port}/talk ...
`;

await sendMessage(coder.port, task);

// Coder will:
// 1. POST /talk to researcher
// 2. Poll researcher's /news
// 3. Get advice
// 4. Create component using that advice
```

### **Why ID Agents is a Good REST-AP Reference**

✅ **Demonstrates async pattern** - Shows how `/talk` + `/news` work together  
✅ **Multi-agent coordination** - Agents discover and talk to each other  
✅ **Production-ready** - Uses Claude Agent SDK for real LLM capabilities  
✅ **Process-based** - Shows agent isolation via local processes  
✅ **Skills system** - Demonstrates how to teach agents to use REST-AP  
✅ **Open source** - Complete implementation available for study

For implementation details, see the [ID Agents README](../../README.md).

---

## **Other Implementations**

REST-AP is protocol-agnostic. Any service can implement REST-AP regardless of the underlying technology:

- **Language-agnostic** - Implement in Python, Rust, Go, etc.
- **LLM-agnostic** - Use Claude, GPT, Llama, or any LLM
- **Framework-agnostic** - Works with any agent framework
- **Transport-agnostic** - Can run over HTTP, in-process, or other transports

The key requirement is exposing:
1. `/.well-known/restap.json` for discovery
2. `POST /talk` for communication (triggers processing, async preferred)
3. `GET /news` for polling updates
4. `POST /news` for receiving replies/messages (no processing, prevents loops)

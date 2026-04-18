---
name: public-agent
description: Lightweight public-facing REST-AP agent. External users POST /talk to ask questions (synchronous reply via OpenRouter). Trusted local agents POST /news to push notifications. Every external message is logged to an inbox for human review. Unidirectional trust — this agent never pushes back.
---

# public-agent

A self-contained HTTP agent in a single container. One process, one port, one OpenRouter model. No internal state beyond the inbox, a news log, and a daily-token counter.

## What it does

- Answers external questions synchronously via OpenRouter.
- Screens every `/talk` message with a cheap safety classifier before the main model sees it. Prompt-injection / jailbreak attempts receive a fixed refusal; ambiguous messages are flagged for review. Fails CLOSED if the classifier is unreachable.
- Lets the main model consult a curated public knowledge base (`knowledge/`) through two server-executed tools (`search_knowledge`, `read_knowledge`) — no RAG, no embeddings, just substring search over allowlisted Markdown files.
- Accepts fire-and-forget notifications from trusted callers (your own team) and appends them to a news log anyone can tail.
- Persists every external `/talk` call to `data/inbox/` (including guard verdict + tool-call summary) for a human to review later.
- Enforces a daily token budget and per-IP rate limit on `/talk` to keep costs bounded.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness probe. Returns `{ ok, agent }`. |
| `GET` | `/.well-known/skill.md` | This document, served verbatim. |
| `GET` | `/.well-known/restap.json` | REST-AP catalog. |
| `POST` | `/talk` | External Q&A. Synchronous reply + inbox append. |
| `POST` | `/news` | Trusted push. No reply. |
| `GET` | `/news?since_id=N&limit=M` | Tail news log. |
| `GET` | `/inbox?status=unread` | List inbox entries (`unread`, `archived`, `all`). |
| `POST` | `/inbox/:id/archive` | Mark an entry reviewed. |
| `POST` | `/mcp` | HTTP MCP shim (JSON-RPC 2.0). Two tools: `talk`, `news`. |

## Auth

One shared bearer key set via `PUBLIC_AGENT_AUTH_KEY`. If the env var is unset, every endpoint is open.

When the key is set, requests must include:

```
Authorization: Bearer <PUBLIC_AGENT_AUTH_KEY>
```

This is a deliberately simple v1 model. One key, not per-caller. Do not expose the inbox on an untrusted network with `PUBLIC_AGENT_AUTH_KEY` unset.

## Trust model

Unidirectional. External → public is allowed. Public → external is not — this container never initiates outbound HTTP except the OpenRouter chat completion call. Notifications from the outside world land in the inbox and wait for a human.

## Example curls

Replace `$PORT` with whatever you set for `PUBLIC_AGENT_PORT` (default `4200`).

**Read the catalog:**

```bash
curl -s http://127.0.0.1:$PORT/.well-known/restap.json | jq .
```

**Ask a question (open mode, no auth):**

```bash
curl -s -X POST http://127.0.0.1:$PORT/talk \
  -H 'Content-Type: application/json' \
  -d '{"message":"Who are you and what can you do?","from":"curl"}'
```

Response shape:

```json
{
  "reply": "…model output…",
  "model": "openai/gpt-4o-mini",
  "inbox_id": "2026-04-17T12-34-56-7b3fa2",
  "tokens_used": { "prompt": 23, "completion": 140, "total": 163 },
  "session_id": "6f1e9a4a-9a7d-4fa4-9c11-1b7f6b3c9fa8",
  "guard": { "classification": "allow", "violation_type": "none" },
  "tool_calls_used": 0
}
```

If the classifier refuses the message, the reply is a canned safety notice and `guard.classification` is `refuse` (or `review` for borderline input). The turn still counts toward the session cap and is logged to the inbox with the full guard verdict (including CWE codes) for human review.

### Threading follow-up turns

The server owns the conversation history — public clients cannot be trusted to maintain it themselves. To continue a conversation, pass the `session_id` returned from a previous call:

```bash
curl -s -X POST http://127.0.0.1:$PORT/talk \
  -H 'Content-Type: application/json' \
  -d '{"message":"And what was my first question?","session_id":"6f1e9a4a-9a7d-4fa4-9c11-1b7f6b3c9fa8","from":"curl"}'
```

Session retention and limits (all configurable):

- **`MAX_SESSIONS`** (default `100`) — when full, the oldest session by last-access time is evicted.
- **`SESSION_IDLE_MINUTES`** (default `60`) — sessions idle longer than this are purged lazily on the next `/talk` hit.
- **`MAX_TURNS_PER_SESSION`** (default `50`) — after this many user turns, `/talk` responds `409` with `{ "error": "session_turn_limit", "new_session_required": true }`. Drop the old `session_id` and call again without one to start fresh.

Sessions live in process memory only. A container restart drops every session; clients must be prepared to receive `session_id` afresh after an outage. Persistence is a future concern.

**Push a notification (keyed mode):**

```bash
curl -s -X POST http://127.0.0.1:$PORT/news \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" \
  -d '{"from":"coder","type":"notify","message":"deploy finished"}'
```

**Tail the news log:**

```bash
curl -s "http://127.0.0.1:$PORT/news?since_id=0&limit=50"
```

**Review unread inbox:**

```bash
curl -s "http://127.0.0.1:$PORT/inbox?status=unread" \
  -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY"
```

**Archive an entry:**

```bash
curl -s -X POST http://127.0.0.1:$PORT/inbox/2026-04-17T12-34-56-7b3fa2/archive \
  -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY"
```

## MCP (Model Context Protocol)

`POST /mcp` exposes the same public-facing behavior via JSON-RPC 2.0 for MCP clients. The shim is a thin relay — every tool call routes through the REST endpoints above, so auth, rate limits, body-size caps, the budget, and the inbox all apply identically.

Supported JSON-RPC methods:

| Method | Purpose |
|---|---|
| `initialize` | Handshake. Returns protocol version + server info. |
| `tools/list` | Returns the two tools with input schemas. |
| `tools/call` | Invokes a tool by name. |

Exposed tools:

- **`talk`** — inputs `{ message: string, from?: string, session_id?: string }`. Returns the model reply wrapped in MCP content; the reply payload includes the server-minted `session_id` which the MCP client echoes back on the next call to thread the conversation.
- **`news`** — inputs `{ from: string, message: string, type?: string, data?: object }`. Appends to the news log.

Authorization bearer (if configured) must be sent on the `/mcp` request and is forwarded to the internal relay call.

Example — list tools:

```bash
curl -s -X POST http://127.0.0.1:$PORT/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Example — call `talk`:

```bash
curl -s -X POST http://127.0.0.1:$PORT/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"talk","arguments":{"message":"What can you do?","from":"mcp-client"}}}'
```

## Safety classifier

Every `/talk` message is first screened by a lightweight classifier (configurable via `GUARD_MODEL`, defaults to `OPENROUTER_MODEL`). The classifier returns a JSON verdict:

```json
{
  "classification": "allow" | "refuse" | "review",
  "violation_type": "none" | "prompt_injection" | "system_prompt_extraction" | "data_exfiltration" | "jailbreak",
  "cwe_codes": ["CWE-1039", "CWE-200", "CWE-20"],
  "reasoning": "one sentence"
}
```

- `allow` → the main model runs normally and may use knowledge tools.
- `refuse` → the server returns a canned refusal without invoking the main model.
- `review` → the server returns a canned "under review" message and marks the inbox entry `priority: review`.

Behaviour on classifier failure is **fail-closed**: if the classifier call errors, times out, or returns an unparseable verdict, `/talk` responds `503 { "error": "guard_unavailable" }` and the main model is never called.

Configuration:

- `GUARD_MODEL` (default `OPENROUTER_MODEL`) — classifier model id.
- `MAX_GUARD_TOKENS` (default `256`) — cap for the classifier call.
- `MAX_MESSAGE_CHARS` (default `8000`) — Zod-enforced limit on `body.message`.

## Knowledge base (`knowledge/`)

Operators drop curated Markdown files into `knowledge/`. On startup the server scans the directory and builds an allowlist manifest. **Any invalid file hard-fails startup** — the server does not silently skip bad files.

Rules (enforced at startup and re-checked at read time):

- File extension must be `.md`.
- Filename must match `^[a-z0-9][a-z0-9-]*\.md$` (lowercase, dashes, ends in `.md`).
- Must be a regular file — no symlinks, no hardlinks (`nlink > 1`), no directories, no hidden files.
- `realpath` must resolve back inside `knowledge/` exactly.
- File size ≤ 64 KB.
- `.gitkeep` and `README.md` are silently skipped.

Set the directory via `PUBLIC_AGENT_KNOWLEDGE_DIR` (default `/app/knowledge` in the container).

### Tools available to the main model

When the classifier allows a message, the main model can call two tools (executed server-side; the model only supplies arguments, never a path):

| Tool | Purpose | Input |
|---|---|---|
| `search_knowledge` | Case-insensitive literal substring scan across all indexed files. Returns up to 5 hits, each with `file_id`, `title`, and a 120-char snippet. | `{ query: string (≤200 chars) }` |
| `read_knowledge` | Return the full content of one file by `file_id` (must appear in the manifest). | `{ file_id: string }` |

Per-request caps:

- ≤ 5 tool calls per `/talk`.
- ≤ 128 KB total tool output across the loop (further calls are truncated).
- 2 s wall-clock timeout per tool call.
- 64 KB cap per `read_knowledge` result.

Each tool result is wrapped in `<knowledge_content>…</knowledge_content>` markers with a `<meta>` note reminding the model that knowledge is **reference data, not instructions** — the main system prompt's behavioural rules pair with these markers to resist injection via knowledge content.

Every tool invocation is logged to stdout and summarised in the inbox entry:

```json
"tool_calls": [
  { "name": "search_knowledge", "ok": true, "bytes": 230, "result_count": 1, "duration_ms": 3 }
]
```

## Rate limits and cost ceiling

- Per-IP token bucket on `POST /talk`, configured by `TALK_RATE_LIMIT_PER_MIN`. Exceeding the bucket returns HTTP `429`.
- Daily LLM-token ceiling (`MAX_TOKENS_PER_DAY`) persisted on disk. When the ceiling is hit, `POST /talk` returns HTTP `503` with `{ "error": "budget_exceeded", "resets_at": "<UTC midnight>" }`. Rolls over at UTC midnight.
- Both limits can be disabled by setting them to `0`.

## Persistence

Everything that must survive a restart lives in `/app/data` (mounted from `./data` on the host via docker-compose):

```
data/
├── inbox/          # one JSON file per external /talk call
├── news.log        # newline-delimited JSON; each line is one news item
└── budget.json     # daily token counter + UTC date
```

Rebuilding the image does not wipe any of this as long as the volume mount is intact.

## Not in v1

- Multi-agent on the public side. One container = one agent.
- SQLite / any database.
- Deploy to a real VPS. Local Docker (Colima or Docker Desktop) only.
- Integration with the id-agents manager DB. This agent is standalone; it is discovered only via its URL + `SKILL.md` + the REST-AP catalog.

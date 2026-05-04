# Manager Polling

How to wait for a `/remote` query (or any in-flight agent work) to complete, the right way and the wrong way.

## TL;DR

After dispatching a query via `POST /remote { command: "/ask <agent> ..." }`, the daemon returns `{ queryId, status: "processing" }`. To wait for completion, hit:

```bash
curl -s -H "X-Id-Team: <team>" "http://localhost:4100/query/<queryId>?wait=30"
```

One call. Server holds the connection open until the query reaches a terminal state (`delivered`, `failed`, `cancelled`, `expired`) or the wait timeout elapses. Returns the full result inline including the agent's reply text. No `/news` scraping, no regex on JSON, no burst polling.

## Endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /query/:id?wait=<seconds>` | Long-poll a single query's status + result | Team header (`X-Id-Team` or `?team=`) |
| `GET /events?topics=...&since=...` | Stream wakeup-service events (heartbeats, schedules, query state) | Same |
| `POST /news` | Append-only inbox writes (manager + agents); not for waiting | Same |
| `GET /news` | Read inbox events (the `cursor` field paginates) | Same |

### `GET /query/:id?wait=<seconds>`

Source: `agent-manager-db.ts:2627-2710`.

- `wait` is clamped to `[0, 30]`. `0` (the default) returns whatever the DB says right now without blocking.
- If the row is non-terminal AND `wait > 0`, the handler registers a single-shot waker against the in-process `queryStatusWaiters` map and races it against a setTimeout. When `completeQueryDelivery` fires (success or failure path) it wakes every registered waiter for that `(team, queryId)` pair, the handler re-reads the DB, and returns.
- Status mapping is external-vocabulary: DB rows are `pending | processing | completed | cancelled | failed | expired`; the response uses `pending | processing | delivered | failed | expired`.

Response shape on success:

```json
{
  "query_id": "query_1777895417695_dygna3g",
  "status": "delivered",
  "agent": "cto",
  "created_at": 1777895417695,
  "completed_at": 1777895775976,
  "result": {
    "result": "<the agent's reply text>",
    "sessionId": "...",
    "messages": ["[Progress] ...", "[Tool] bash", ...]
  }
}
```

`result.result` is the agent's textual reply. `result.messages` is the agent's progress/tool-call trace (useful for debugging, often verbose).

For queries that take longer than 30s, chain calls:

```bash
while :; do
  resp=$(curl -s -H "X-Id-Team: idchain" "http://localhost:4100/query/$QID?wait=30")
  status=$(echo "$resp" | jq -r '.status')
  case "$status" in
    delivered|failed|expired|cancelled) echo "$resp"; break ;;
  esac
done
```

Each iteration is one TCP connection that hangs for up to 30s. No spam. No TIME_WAIT pressure on macOS.

### `GET /events`

Source: `agent-manager-db.ts:4510-4603`. Wakeup-service event stream — emits topics like `query:delivered`, `query:failed`, schedule firings, heartbeat ticks. Useful when you want to multiplex many queries / agents through one connection.

Per the in-code comment: "SSE/webhook delivery land in separate slices." Today this returns a snapshot batch with a `cursor`; SSE flavor is not yet implemented. For per-query waits, prefer `GET /query/:id?wait=`.

## What NOT to do

### Don't burst-poll `/news` with grep

```bash
# WRONG
for i in $(seq 1 60); do
  sleep 60
  resp=$(curl -s -X POST http://localhost:4100/remote ... -d '{"command":"/news cto"}')
  if echo "$resp" | grep -qE 'in_reply_to.*outbound\.reply'; then break; fi
done
```

Three failure modes:

1. **Brittle regex.** JSON key ordering is not guaranteed across serializers. The grep above looks for `in_reply_to` *before* `outbound.reply`, but the daemon serializes `type:"outbound.reply"` first inside the item object — so this regex never matches and polls always time out.
2. **TIME_WAIT exhaustion.** Each curl is a fresh TCP connection. macOS has ~16k ephemeral ports; a tight burst-poll loop (or many in parallel) can saturate them. The daemon looks down but isn't.
3. **Polling derived state.** `/news` is the inbox event stream; query completion is one event among many. The canonical state is the `queries` table, surfaced by `GET /query/:id`.

### Don't loop on raw SQLite reads from a client

```bash
# Also wrong — fast and direct, but no waiter wakeup, so it has to spin
while ! sqlite3 ~/.id-agents/id-agents.db "SELECT 1 FROM queries WHERE query_id='X' AND status='completed'" | grep -q 1; do
  sleep 5
done
```

This works but spins on the DB regardless of whether anything has changed. The long-poll endpoint already does the right thing: register a waiter, sleep, wake on event. Use the endpoint.

### Don't rely on `/remote /news` per-query

The `/remote` `/news <agent>` command is for browsing an agent's inbox by hand. It's not designed for query-completion waiting. Use `GET /query/:id?wait=`.

## Common patterns

### Dispatch + wait, single query

```bash
QID=$(curl -s -X POST http://localhost:4100/remote \
  -H "X-Id-Team: idchain" -H "Content-Type: application/json" \
  -d '{"command":"/ask cto your prompt here"}' \
  | jq -r '.result.queryId')

curl -s -H "X-Id-Team: idchain" "http://localhost:4100/query/$QID?wait=30" \
  | jq -r '.result.result'
```

For prompts that take longer than 30s, wrap the wait call in a loop that re-issues the long-poll until status is terminal (snippet above).

### Dispatch many queries, gather results

For a fan-out, dispatch each `/ask`, collect the queryIds, then wait on each in sequence (or in parallel via background subshells). Each waiter is one connection; the daemon serves them all without TIME_WAIT pressure because each connection is long-lived.

### Watch all agents' activity (debugging only)

`GET /events?topics=query:delivered,query:failed` for an aggregate view. Suitable for a dashboard, not for waiting on a specific query.

## Maintenance notes

This doc should stay synced with:

- `src/agent-manager-db.ts` route definitions (anchor: search for `app.get('/query/:id'` and `// WAKEUP SERVICE: GET /events`)
- The status vocabulary mapping in the same handler
- Any new wait endpoints added in future slices

When adding a new long-poll surface (e.g., `GET /task/:name?wait=`), update the endpoints table above and call out the difference from `/query/:id?wait=`.

If this doc drifts from the code, the doc is wrong. Cite a file:line ref when fixing.

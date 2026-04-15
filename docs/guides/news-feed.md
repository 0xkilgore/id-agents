# News Feed (`/news`)

`/news` is a loop-safe message channel and multi-reply catch-all. It is **not** the audit trail — it's the place where asynchronous notifications and extra replies land.

## When to Use `/news`

| Scenario | Example |
|----------|---------|
| **Fire-and-forget notifications** | Agent posts a status update that doesn't need a response |
| **Multi-reply overflow** | Agent generates additional output beyond the first `/talk-to` response |
| **Background progress** | Heartbeat messages, scheduled task results |
| **Broadcast receipts** | Replies from `/ask * <message>` land in each agent's news |

## When NOT to Use `/news`

| Need | Use Instead |
|------|-------------|
| Track task completion | `/task` — queryable todo/doing/done board |
| Correlate request-response | `/ask` + `queryId` — see below |
| Share file artifacts | `/output` + `/artifact` — structured file access |
| Verify code quality | Agent-internal checks (compile, test) — not a framework concern |

## Checking News

```bash
# Recent messages (summary)
/news agent-name

# Full content
/news -l agent-name
```

Via API:
```bash
curl http://localhost:4100/agents/{agent-id}/news
```

## Request-Response Correlation with queryId

When you send a message via `/ask`, the response includes a `queryId`. Use it to poll for the specific reply rather than scanning the news feed:

```bash
# Send a question
curl -X POST http://localhost:4100/agents/{id}/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "Analyze the auth module"}'
# Response: { "queryId": "q_abc123", "status": "pending" }

# Poll for this specific answer
curl http://localhost:4100/agents/{id}/news?queryId=q_abc123
# Returns only news items tagged with this queryId
```

This pattern gives you structured request-response tracking without treating the news feed as a task queue.

## How News Relates to Other Systems

```
┌──────────────┐     queryId correlation     ┌──────────────┐
│   /ask       │ ──────────────────────────→  │   /news      │
│  (request)   │                              │  (responses) │
└──────────────┘                              └──────────────┘

┌──────────────┐     task lifecycle           ┌──────────────┐
│   /task      │ ──────────────────────────→  │   /task list  │
│  (tracking)  │  todo → doing → done        │  (status)    │
└──────────────┘                              └──────────────┘

┌──────────────┐     file-level artifacts     ┌──────────────┐
│   /output    │ ──────────────────────────→  │   /artifact  │
│  (listing)   │                              │  (content)   │
└──────────────┘                              └──────────────┘
```

## Related

- [Task Tracking](./tasks.md) — structured work tracking with `/task`
- [Agent Outputs](./agent-outputs.md) — standardized output directory for artifacts

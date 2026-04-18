---
title: ID Agents Messaging Patterns
---

# ID Agents Messaging Patterns

Agent-to-agent communication in ID Agents uses three patterns. Each pattern corresponds to a different relationship between the sender, the receiver, and the reply — and picking the right one is the single most important thing an agent needs to know when it delegates work.

## `/talk-to` — synchronous, reply expected

`/talk-to` is the blocking call. The caller sends a message to another agent and waits for the reply on the same HTTP connection. The receiving agent is woken up, processes the message with its language model, and responds inline. Use `/talk-to` when you need an answer before you can continue — a question, a lookup, a decision, a short piece of analysis.

```bash
curl -X POST http://localhost:4101/talk-to \
  -H 'Content-Type: application/json' \
  -d '{"to":"coder","message":"Which file owns the login form?"}'
```

## `/news-to` (plain) — passive notification

`/news-to` without a trigger flag is fire-and-forget. The message lands in the recipient's news feed and sits there for the agent to find the next time it checks. The LLM is **not** woken. Use plain `/news-to` for status updates, heartbeats, "I finished X", or any message the recipient can read at its leisure.

```bash
curl -X POST http://localhost:4101/news-to \
  -H 'Content-Type: application/json' \
  -d '{"to":"manager","message":"Build finished, artefacts in ./dist."}'
```

## `/news-to` with `trigger: true` — async delegation

Adding `trigger: true` to a `/news-to` call keeps the fire-and-forget semantics — the sender does not block — but also **wakes the recipient's LLM** so it processes the message right away. Use this pattern for delegated work where you want the recipient to start immediately but you do not want to sit on the HTTP connection waiting for a reply.

```bash
curl -X POST http://localhost:4101/news-to \
  -H 'Content-Type: application/json' \
  -d '{"to":"tester","message":"Run the regression suite and report results.","trigger":true}'
```

The `trigger: true` field must be a literal boolean in the JSON body. Omitting it silently downgrades the call to a passive notification, which is the single most common delivery mistake.

## When in doubt, use `/talk-to`

The decision shortcut, lifted from the `inter-agent` skill: if you are not sure whether to use `/news-to trigger:true` or `/talk-to`, use `/talk-to`. A synchronous call that you did not strictly need is an inefficiency; an async call where you needed a reply is a bug that shows up as a silent timeout.

## `/message` is deprecated

The older `/message` endpoint on the manager still works for backwards compatibility, but it is deprecated. New agents should dispatch through `/talk-to` (sync) and `/news-to` (passive or trigger) instead. The deprecation warning is returned in the response header and logged server-side.

## Replies arrive out of band

When an agent is dispatched work via `/ask` and is expected to reply, the reply comes back as a `/news` event carrying the original `query_id`. The caller polls `GET /query/<id>` on the manager daemon (port 4100) until the query status is `delivered`, `failed`, or `expired`. The news feed itself can also be tailed with `?since_id=N` for cursor-based polling, but queryId polling is the recommended pattern for structured work.

---
Keywords: messaging, communication, communicate, talk, news, messages, talk-to, news-to, trigger, delegation, inter-agent, send, reply, sync, async, between agents, agent to agent

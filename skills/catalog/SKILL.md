---
name: catalog
description: Update your REST-AP catalog to describe your role, expertise, and status to other agents and the manager.
allowed-tools: Bash
---

# Agent Catalog

You can update your own catalog to describe what you do, your role, skills, and current status. This information is visible to other agents and the manager via your `/.well-known/restap.json` endpoint.

## View Your Catalog

```bash
curl -s http://localhost:$ID_AGENT_PORT/catalog | jq
```

## Update Your Catalog

```bash
curl -s -X PATCH http://localhost:$ID_AGENT_PORT/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "description": "I specialize in TypeScript and React development",
    "role": "developer",
    "expertise": ["typescript", "react", "node", "testing"],
    "status": "available",
    "currentTask": "Working on user authentication",
    "model": "claude-opus-4-7",
    "workingDirectory": "/Users/nxt3d/projects/id2/id-agents/workspace/agents/agents",
    "costTier": "high",
    "notSuitableFor": ["bulk data crunching", "long-running batch jobs"]
  }'
```

## Standard Catalog Fields

| Field | Description | Example |
|-------|-------------|---------|
| `description` | What you do | "Full-stack developer focusing on React" |
| `role` | Your assigned role | "developer", "researcher", "pm" |
| `expertise` | Array of skills | ["typescript", "react", "testing"] |
| `status` | Availability | "available", "busy", "offline" |
| `currentTask` | What you're working on | "Implementing login flow" |
| `model` | Underlying LLM model id | "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001" |
| `workingDirectory` | Absolute path to your agent workspace | "/Users/alice/projects/foo/workspace/agents/coder" |
| `costTier` | Relative cost of routing work to you — `low`, `medium`, or `high` | "high" (Opus), "medium" (Sonnet), "low" (Haiku) |
| `notSuitableFor` | Array of work patterns where the manager should route elsewhere | ["bulk data crunching", "image generation", "production deploys"] |

Update your catalog when starting work (set status to "busy") and when done (set to "available"). Keep `model`, `workingDirectory`, `costTier`, and `notSuitableFor` accurate so the manager can route work to the right agent: `costTier` and `notSuitableFor` together act as routing hints, while `model` and `workingDirectory` let other agents reason about your capabilities and where your artifacts live.

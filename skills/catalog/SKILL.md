---
name: catalog
description: Update your REST-AP catalog to describe your role, expertise, and status to other agents and the manager.
allowed-tools: Bash
---

# Agent Catalog

You can update your own catalog to describe what you do, your role, skills, and current status. This information is visible to other agents and the manager via your `/.well-known/restap.json` endpoint.

## View Your Catalog

```bash
curl -s http://localhost:$PORT/catalog | jq
```

## Update Your Catalog

```bash
curl -s -X PATCH http://localhost:$PORT/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "description": "I specialize in TypeScript and React development",
    "role": "developer",
    "expertise": ["typescript", "react", "node", "testing"],
    "status": "available",
    "currentTask": "Working on user authentication"
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

Update your catalog when starting work (set status to "busy") and when done (set to "available").

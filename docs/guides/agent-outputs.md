# Agent Outputs

Agents write generated artifacts (reports, analysis, code) to a standard location: `{workingDirectory}/output/`. This convention is injected into every agent's CLAUDE.md at deploy time.

## Commands

### `/output <agent>` — List Output Files

Lists files in the agent's output directory with filename, size, and modification time.

```bash
/output researcher
# 📁 Output files for researcher:
#   analysis.md   4.2KB  4/15/2026, 2:30:00 PM
#   data.json     12.1KB 4/15/2026, 2:31:00 PM
```

Via API:
```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/output researcher"}'
# { "ok": true, "result": { "agent": "researcher", "files": [...] } }
```

### `/artifact <agent> <path>` — Read Output File

Reads the content of a specific file from the agent's output directory.

```bash
/artifact researcher analysis.md
# 📄 analysis.md (4.2KB)
#
# # Analysis Report
# ...
```

Via API:
```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/artifact researcher analysis.md"}'
# { "ok": true, "result": { "agent": "researcher", "path": "analysis.md", "content": "...", "size": 4301 } }
```

## Safety

- **Directory traversal protection**: paths containing `..` or starting with `/` are rejected
- **Size limit**: files over 1MB are rejected to prevent runaway payloads
- **Read-only**: `/artifact` only reads — agents write to the directory themselves

## Convention

Every agent's CLAUDE.md includes this preamble at deploy time:

> Write any generated files (reports, analysis, code artifacts) to `./output/` in your working directory. Other agents can read these artifacts via `/artifact`.

Agents adopt this convention automatically. No additional configuration is needed.

## Per-document feedback

Chris (and other human reviewers) can leave comments directly on an
Artifact from `/agents/<agent>/output/<artifact_phid>` in the dashboard.
Each comment is a first-class `ADD_COMMENT` operation on the Artifact's
document history. Agents poll their unread feedback via the CLI without
opening the browser:

```bash
# List unread artifact comments for an agent
id-agents comments rams

# Same, as JSON for scripts/SDK callers
id-agents comments rams --json

# Acknowledge (mark read) a single comment
id-agents comments rams --ack phid:art-1 comment_abc123
```

In code, agents can call the same surface directly:

```ts
import { pollUnreadArtifactCommentsForSelf } from "@id-agents/cli/comments";

const unread = await pollUnreadArtifactCommentsForSelf();
// agentId defaults to process.env.AGENT_NAME
```

## Related

- [Task Tracking](./tasks.md) — coordinate work between agents
- [News Feed](./news-feed.md) — async message channel

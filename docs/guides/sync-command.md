# /sync — Reconcile Running Team with Config

The `/sync` command updates a running team to match a YAML config file without destroying unchanged agents. Unlike `/deploy`, which tears down and recreates every agent, `/sync` diffs the desired state against the running state and only touches what changed.

## Usage

```
/sync <config> [param=value ...] [--dry-run] [--verbose]
```

**Examples:**

```
/sync idchain                           # Reconcile team with configs/idchain.yaml
/sync idchain --dry-run                 # Preview changes without applying
/sync idchain --verbose                 # Show per-agent detail
/sync configs/custom.yaml name=alice    # With parameters
```

## How It Works

1. Parse the YAML config and resolve parameters (same as `/deploy`)
2. Load all running agents from the database for the team
3. Diff into four categories by matching agents **by name**:

| Category     | Condition                              | Action                                              |
|-------------|----------------------------------------|-----------------------------------------------------|
| **New**      | In config, not running                 | Spawn new agent (new ID, new port)                  |
| **Removed**  | Running, not in config                 | Kill process, delete DB row                         |
| **Changed**  | Config differs from running state      | Kill process, update DB row in-place, respawn on same port |
| **Unchanged**| Config matches running state           | Skip entirely — no process touch                    |

4. Return a structured result with per-agent categorization

## Diff Fields

These fields are compared to determine if an agent has changed:

- `model` — LLM model name
- `runtime` — Harness type (claude-agent-sdk, claude-code-cli, codex)
- `plugins` — Plugin list (compared by name, order-independent)
- `skills` — Skill list (order-independent)
- `allowedTools` — Tool whitelist (order-independent)
- `description` — Agent description
- `domain` — ENS domain
- `tokenId` — Onchain token ID
- `heartbeat` — Heartbeat enabled/disabled
- `workingDirectory` — Only compared when explicitly set in config

Protocol defaults and agent role files (`.claude/agents/<name>.md`) are always written at sync time regardless of diff results.

## Key Properties

**Session preservation**: Changed agents keep their agent ID, port, and working directory. Their `news_items`, `queries`, and `schedule_targets` are preserved across syncs.

**Port stability**: Changed agents are restarted on their existing port. Only new agents get fresh ports.

**Working directory changes**: If `workingDirectory` changes, the agent is destroyed and recreated (can't safely move data across directories).

**Removed agents**: Hard-deleted from the database. Process is killed, DB row and cascaded data (news, queries, schedules) are removed. Working directory is not deleted (preserved as backup, consistent with `/delete` behavior).

## /sync vs /deploy

| Behavior                     | `/deploy`                      | `/sync`                        |
|-----------------------------|--------------------------------|--------------------------------|
| Existing agents             | Delete + recreate all          | Only touch changed agents      |
| Agent IDs                   | New IDs every time             | Preserved for changed agents   |
| Ports                       | New ports every time           | Preserved for changed agents   |
| News/query history          | Lost on redeploy               | Preserved                      |
| Sessions                    | Reset                          | Preserved                      |
| Agents removed from config  | Left running (not cleaned up)  | Killed and deleted             |
| First-time deploy           | Yes                            | Yes (all agents are "new")     |

**When to use `/deploy`**: First-time setup, or when you want a clean slate.

**When to use `/sync`**: Updating a running team — adding agents, changing models, removing agents.

## Output

**Default output:**
```
Added 3, updated 1, removed 0, unchanged 8
  Added: dave, eve, frank
  Updated: alice
```

**With `--verbose`:**
```
Added 3, updated 1, removed 0, unchanged 8
  + dave (new)
  + eve (new)
  + frank (new)
  ~ alice (changed: model, description)
  = bob (unchanged)
  = charlie (unchanged)
  ...
```

**With `--dry-run`:**
```
Sync dry run: Added 3, updated 1, removed 0, unchanged 8
  + dave (new)
  ~ alice (changed: model)
  - removed-agent (removed)
  = bob (unchanged)
```

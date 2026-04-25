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
- `runtime` — Harness type (claude-agent-sdk, claude-code-cli, claude-code-local, codex, cursor-cli)
- `plugins` — Plugin list (compared by name, order-independent)
- `agent` — Library overlay name from `configs/agents/<name>/`
- `skills` — Skill list (order-independent)
- `allowedTools` — Tool whitelist (order-independent)
- `description` — Agent description
- `domain` — ENS domain
- `tokenId` — Onchain token ID
- `heartbeat` — Heartbeat enabled/disabled
- `workingDirectory` — Only compared when explicitly set in config

Protocol defaults and agent role files (under the runtime-specific template directory, e.g. `.claude/agents/`, `.agents/`, or `.cursor/agents/`) are always written at sync time regardless of diff results.

When `agent:` is set, sync deploys the named library entry into the workspace using the v3 two-step additive flow described below.

## Library Deployment (v3)

`agent:` and `skills:` are peer fields. Each refers to a library entry by name:

- `agent: <name>` — one entry from `configs/agents/<name>/`
- `skills: [<name>, ...]` — zero or more entries from `configs/skills/<name>/`

The library root is resolved from `ID_LIBRARY_ROOT` (env), else `<cwd>/configs`, else "no library configured" (in which case `agent:` and `skills:` resolve to empty).

### Two native agent shapes

`configs/agents/<name>/` accepts both shapes natively:

- **Claude-native** — folder with `CLAUDE.md` (plus optional `skills/`, `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/`). Discovered iff `<name>/CLAUDE.md` exists.
- **AGENTS.md-native** — sibling pair `<name>.md` + `<name>/`. The `.md` file is the persona; the directory carries extras (primarily `skills/`). Discovered iff both exist.

Discovery deduplicates by logical name; a mixed-shape collision is a validation error.

### Two-step deploy

1. **Step A** — copy the resolved agent entry into the workspace, mapping each source file through the runtime translation table.
2. **Step B** — for each name in `skills:`, copy `configs/skills/<skill>/` into the workspace. Standalone skills override same-named skills bundled inside the agent entry (last writer wins, deterministically).

### Per-harness mapping

| Library source | Claude target | Codex target | Cursor target |
|---|---|---|---|
| `CLAUDE.md` (Claude-native) or `<name>.md` (AGENTS.md-native) | `CLAUDE.md`, with fallback to `.claude/rules/agent-<name>.md` | `AGENTS.md` (refused if pre-existing) | `AGENTS.md` (refused if pre-existing) |
| `skills/<skill>/` (agent-bundled or standalone) | `.claude/skills/<skill>/` | `.agents/skills/<skill>/` | flatten into supported surface or skip with warning |
| `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/` | native Claude surfaces | runtime remap or skip per supported Codex surface | runtime remap or skip per supported Cursor surface |

Cursor remains the least native target: skill content flattens into a supported surface or is skipped with a warning rather than inventing a silent merge.

### Memory-file fallback

If the workspace already has the runtime's root memory file:

- **Claude target with existing `CLAUDE.md`** — write the persona to `.claude/rules/agent-<name>.md` instead. Claude auto-loads `.claude/rules/*.md`.
- **Codex or Cursor target with existing `AGENTS.md`** — refuse the deploy with a clear error. Operator can delete or rename `AGENTS.md`, or append the persona manually and re-run with `--skip-memory`.

This keeps sync additive: an existing root memory file is treated as user-owned and never silently rewritten.

### 4-case ownership

For each destination file in Step A or Step B:

| Target state | Action |
|---|---|
| Does not exist | Write, add to receipt |
| Exists, disk SHA == source SHA | No-op, ensure receipt entry present |
| Exists, disk SHA == receipt SHA | Still ours, overwrite with new content, update receipt |
| Exists, disk SHA is something else | User-owned or user-edited. Skip and warn. Do not write. |

**No file the user owns is ever modified or deleted.** Ownership is established by the receipt: a file is ours iff its current SHA matches what we last wrote. Everything else is sacred.

### Receipt

One receipt per workspace at `<workspace>/.id-agents/receipt.json`. Each managed destination file gets one entry with:

- `sha256` — latest content hash
- `source` — `agent:<name>` or `skill:<name>`

The receipt is rewritten atomically (temp file + rename) on every successful sync. It is the ownership ledger for sync, re-sync, and undeploy.

## Undeploy: `unsync`

The standalone CLI exposes an undeploy command that removes managed files using the receipt:

```
id-agents unsync <config> [--workspace <path>]
```

For each receipt entry:

- if disk SHA == receipt SHA, the file is still ours → delete it
- if disk SHA has drifted, leave the file on disk and only remove the receipt entry

User-edited files always survive `unsync`. Receipt cleanup is safe even when ownership has been lost due to edits.

## TUI library browsers

The TUI ships read-only browsers for the two library roots (`npm run tui:dev`):

- agents browser — list/detail for `configs/agents/` (handles both native shapes)
- skills browser — list/detail for `configs/skills/`

Both views fetch through the manager (`/library/agents`, `/library/skills`) rather than reading the filesystem directly. Set `ID_LIBRARY_ROOT` on the manager process to point them at any library clone.

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

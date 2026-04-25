# /sync — Reconcile Running Team with Config

`/sync` updates a running team to match a YAML config without destroying unchanged agents. It performs a per-agent diff against running state, then a workspace-file deploy of the v3 library entries selected by each agent's `agent:` and `skills:` fields. Both stages are **additive** — no file the user owns is ever modified or deleted.

Unlike `/deploy`, which tears down and recreates every agent, `/sync` only touches what changed.

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

## /sync vs /deploy

| Behavior                    | `/deploy`                     | `/sync`                       |
|-----------------------------|-------------------------------|-------------------------------|
| Existing agents             | Delete + recreate all         | Only touch changed agents     |
| Agent IDs                   | New IDs every time            | Preserved for changed agents  |
| Ports                       | New ports every time          | Preserved for changed agents  |
| News/query history          | Lost on redeploy              | Preserved                     |
| Sessions                    | Reset                         | Preserved                     |
| Agents removed from config  | Left running (not cleaned up) | Killed and deleted            |
| First-time deploy           | Yes                           | Yes (all agents are "new")    |

**Use `/deploy`** for first-time setup or when you want a clean slate. **Use `/sync`** for updating a running team — adding agents, changing models, removing agents.

## Running-team diff

1. Parse the YAML config and resolve parameters (same as `/deploy`).
2. Load all running agents from the database for the team.
3. Diff into four categories by matching agents **by name**:

| Category      | Condition                              | Action                                                     |
|---------------|----------------------------------------|------------------------------------------------------------|
| **New**       | In config, not running                 | Spawn new agent (new ID, new port)                         |
| **Removed**   | Running, not in config                 | Kill process, delete DB row                                |
| **Changed**   | Config differs from running state      | Kill process, update DB row in-place, respawn on same port |
| **Unchanged** | Config matches running state           | Skip entirely — no process touch                           |

4. For every **New** or **Changed** agent, run the workspace deploy described below.

### Diff fields

These fields are compared to determine if an agent has changed:

- `model` — LLM model name
- `runtime` — Harness type (`claude-agent-sdk`, `claude-code-cli`, `claude-code-local`, `codex`, `cursor-cli`)
- `plugins` — Plugin list (compared by name, order-independent)
- `agent` — Library entry name from `configs/agents/<name>/`
- `skills` — Skill list (order-independent)
- `allowedTools` — Tool whitelist (order-independent)
- `description` — Agent description
- `domain` — ENS domain
- `tokenId` — Onchain token ID
- `heartbeat` — Heartbeat enabled/disabled
- `workingDirectory` — Only compared when explicitly set in config

Protocol defaults and agent role files (under the runtime-specific template directory, e.g. `.claude/agents/`, `.agents/`, or `.cursor/agents/`) are always written at sync time regardless of diff results.

## Library deployment

`agent:` and `skills:` are peer fields on each agent entry. Each refers to a library entry by name:

- `agent: <name>` — one entry from `configs/agents/<name>/`
- `skills: [<name>, ...]` — zero or more entries from `configs/skills/<name>/`

The library root is resolved in this order:

1. `ID_LIBRARY_ROOT` env when set and present on disk
2. `<cwd>/configs` when present
3. otherwise no library configured (entries resolve to empty)

### Two native agent shapes

`configs/agents/<name>/` accepts both shapes natively:

- **Claude-native** — folder containing `CLAUDE.md` plus optional `skills/`, `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/`. Discovered iff `<name>/CLAUDE.md` exists.
- **AGENTS.md-native** — sibling pair `<name>.md` + `<name>/`. The `.md` file is the persona; the directory carries extras (primarily `skills/`). Discovered iff both exist.

Discovery deduplicates by logical name; a mixed-shape collision is a validation error.

### Two-step deploy

1. **Step A** — copy the resolved agent entry into the workspace, mapping each source file through the runtime translation table.
2. **Step B** — for each name in `skills:`, copy `configs/skills/<skill>/` into the workspace. Standalone skills override same-named skills bundled inside the agent entry (last writer wins, deterministically).

### Per-harness mapping

| Library source | Claude target | Codex target | Cursor target |
|---|---|---|---|
| `CLAUDE.md` (Claude-native) or `<name>.md` (AGENTS.md-native) | `.claude/CLAUDE.md` (sidecar to `.claude/rules/agent-<name>.md` when a user-authored `.claude/CLAUDE.md` is in the way) | marker-fenced block in workspace-root `AGENTS.md` | marker-fenced block in workspace-root `AGENTS.md` |
| `skills/<skill>/` (agent-bundled or standalone) | `.claude/skills/<skill>/` | `.agents/skills/<skill>/` | flatten into supported surface or skip with warning |
| `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/` | native Claude surfaces | runtime remap or skip per supported Codex surface | runtime remap or skip per supported Cursor surface |

Cursor remains the least native target: skill content flattens into a supported surface or is skipped with a warning rather than inventing a silent merge.

## Memory-file handling

The runtime's root memory file (`.claude/CLAUDE.md` for Claude, workspace-root `AGENTS.md` for Codex/Cursor) is the most user-touched surface. `/sync` never silently rewrites a user's edits.

### Codex / Cursor — marker-fenced append into `AGENTS.md`

For Codex and Cursor runtimes, `/sync` writes the workspace-root `AGENTS.md` using two marker-fenced blocks:

```
<!-- BEGIN id-agents framework -->
... PROTOCOL_DEFAULTS + roleBody ...
<!-- END id-agents framework -->

... user content here is preserved across syncs ...

<!-- BEGIN id-agents agent:<name> -->
... library persona from configs/agents/<name>/ ...
<!-- END id-agents agent:<name> -->
```

On re-sync, only the bytes between matching `BEGIN`/`END` markers are replaced. Content before, between, and after the managed blocks — including hand-written sections the operator added — is preserved exactly. If a marker pair is missing, the block is appended at the bottom separated by a blank line.

This means an existing user-authored `AGENTS.md` is **not** refused: `/sync` upserts its managed blocks alongside the existing content.

### Claude — sidecar fallback for user-authored `.claude/CLAUDE.md`

For Claude runtimes, `.claude/CLAUDE.md` is id-agents-managed end-to-end and gets a wholesale rewrite each sync (no marker fencing).

The sidecar fallback applies only when a user-authored `.claude/CLAUDE.md` is in the way — specifically when the file exists, has no entry in the receipt, and its bytes differ from the source persona. In that case `/sync` routes the library persona to:

```
.claude/rules/agent-<name>.md
```

Claude auto-loads `.claude/rules/*.md`, so the persona still applies without overwriting the user's `CLAUDE.md`.

## 4-case ownership

For each destination file written in Step A or Step B (excluding the marker-fenced AGENTS.md path described above):

| Target state | Action |
|---|---|
| Does not exist | Write, add to receipt |
| Exists, disk SHA == source SHA | No-op, ensure receipt entry present |
| Exists, disk SHA == receipt SHA | Still ours, overwrite with new content, update receipt |
| Exists, disk SHA is something else | User-owned or user-edited. Skip and warn. Do not write. |

**No file the user owns is ever modified or deleted.** Ownership is established by the receipt: a file is ours iff its current SHA matches what we last wrote. Everything else is sacred.

## Receipt

Every workspace gets a single receipt at:

```
<workspace>/.id-agents/receipt.json
```

Each managed destination file gets one entry with:

- `sha256` — latest content hash
- `source` — `agent:<name>` or `skill:<name>`

The receipt is rewritten atomically (temp file + rename) on every successful sync. It is the ownership ledger for sync, re-sync, and undeploy.

## Undeploy: `unsync`

The standalone CLI exposes a receipt-driven undeploy command:

```
id-agents unsync <config> [--workspace <path>]
```

For each receipt entry:

- if disk SHA == receipt SHA, the file is still ours → delete it
- if disk SHA has drifted, leave the file on disk and only remove the receipt entry

User-edited files always survive `unsync`. Receipt cleanup is safe even when ownership has been lost due to edits.

## TUI library browsers

The TUI ships read-only browsers for the two library roots (`npm run tui:dev`):

- **`l`** — agents browser (list/detail for `configs/agents/`, handles both native shapes)
- **`s`** — skills browser (list/detail for `configs/skills/`)

Both views fetch through the manager (`/library/agents`, `/library/skills`) rather than reading the filesystem directly. Set `ID_LIBRARY_ROOT` on the manager process to point them at any library clone.

## Key properties

**Session preservation**: Changed agents keep their agent ID, port, and working directory. Their `news_items`, `queries`, and `schedule_targets` are preserved across syncs.

**Port stability**: Changed agents are restarted on their existing port. Only new agents get fresh ports.

**Working-directory changes**: If `workingDirectory` changes, the agent is destroyed and recreated (data can't be safely moved across directories).

**Removed agents**: Hard-deleted from the database. Process is killed, DB row and cascaded data (news, queries, schedules) are removed. Working directory is not deleted (preserved as backup, consistent with `/delete` behavior).

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

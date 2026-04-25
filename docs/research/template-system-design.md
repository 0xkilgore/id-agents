# Template System Design

Research date: 2026-04-24

Scope: design only. This document proposes a deployable agent-template system for `id-agents` that packages skills plus harness-specific instruction files, agent definitions, commands, hooks, and seed memory into a single reusable bundle.

## Summary

The right v1 is a **filesystem template bundle** with a harness-agnostic canonical layout plus explicit per-harness mapping rules at deploy time. `id-agents` already has three useful primitives:

- runtime-aware path mapping in `src/runtime/registry.ts`
- workspace overlay/copy behavior in `src/config-parser.ts`
- skill deployment and personality-file writing in `src/agent-manager-db.ts`

What is missing is a first-class **template artifact** that can be referenced from config and deployed idempotently into an agent workspace.

The main design choice in this plan is:

- **v1 source model:** local path only
- **v1 deploy target:** agent workspace only
- **v1 TUI:** read-only discovery only
- **v1 merge behavior:** deterministic, conservative, manifest-driven, no silent duplication

Git URLs and registry lookup should wait until v1.1.

## 1. Three-Harness Folder Survey

### Claude Code

#### Upstream convention

Claude Code has the richest official on-disk model.

- Subagents are Markdown files with YAML frontmatter in:
  - project scope: `.claude/agents/`
  - user scope: `~/.claude/agents/`
- Project memory can live at either:
  - `./CLAUDE.md`
  - `./.claude/CLAUDE.md`
- User memory lives at:
  - `~/.claude/CLAUDE.md`
- Rules live in:
  - `.claude/rules/`
- Skills live in:
  - `.claude/skills/<skill-name>/SKILL.md`
- Custom slash commands live in:
  - `.claude/commands/`
  - `~/.claude/commands/`
- Hooks are configured in:
  - `.claude/settings.json`
  - `~/.claude/settings.json`
  - `.claude/settings.local.json`

Important nuance:

- Official Claude subagents are file-based `.md` definitions under `.claude/agents/`.
- Our current `id-agents` code also supports a **directory pattern** `.claude/agents/<name>/CLAUDE.md` for deploy overlays. That is an `id-agents` convention layered on top of Claude, not the primary upstream subagent format.

#### Subagent file shape

Official structure:

```md
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

System prompt body goes here.
```

Frontmatter fields confirmed in current Claude docs include at least:

- `description`
- `prompt` or Markdown body as the system prompt equivalent
- `tools`
- `disallowedTools`
- `model`
- `permissionMode`
- `mcpServers`
- `hooks`
- `maxTurns`
- `skills`
- `initialPrompt`
- `memory`
- `effort`
- `background`
- `isolation`
- `color`

Discovery:

- Claude discovers project subagents by scanning `.claude/agents/` from the current working directory.
- Project definitions override user definitions on name conflict.
- Manual file creation requires restart or `/agents` reload behavior.

#### What id-agents currently knows

`id-agents` already assumes Claude-style deployment as the default runtime:

- templates at `.claude/agents`
- overlay target `.claude`
- skills target `.claude/skills`
- personality file `.claude/CLAUDE.md`

Relevant code:

- `src/runtime/registry.ts`
- `src/config-parser.ts`
- `src/agent-manager-db.ts`

#### Gaps to paper over

- Claude upstream has multiple official instruction surfaces: `CLAUDE.md`, rules, subagents, skills, commands, settings/hooks.
- `id-agents` currently models only:
  - skills
  - agent template overlay
  - one personality file
- There is no first-class manifest describing which optional Claude surfaces a template ships.

### Codex CLI

#### Upstream convention

Codex terminology has drift compared to Claude:

- the core repo-level instruction file is `AGENTS.md`
- there is a user-level home directory at `~/.codex/`
- the current official docs navigation exposes Codex concepts for:
  - Rules
  - Hooks
  - `AGENTS.md`
  - MCP
  - Plugins
  - Skills
  - Subagents

What is clear from this machine and official OpenAI material:

- Codex definitely reads `AGENTS.md` in the repository
- local Codex state/config lives in `~/.codex/`
- this machine has:
  - `~/.codex/config.toml`
  - `~/.codex/rules/`
  - `~/.codex/skills/`
  - `~/.codex/memories/`
- `codex --help` exposes no repo-local subagent folder or agent-definition path analogous to `.claude/agents/`

So the safe conclusion for v1 is:

- **confirmed surfaces:** root `AGENTS.md`, user-level rules/skills/memories in `~/.codex/`
- **not confirmed enough for v1:** a formal project-local subagent folder convention

#### What id-agents currently knows

`id-agents` already maps Codex to:

- template dir: `.agents`
- overlay target: `.agents`
- skills dir: `.agents/skills`
- personality file: `AGENTS.md`

It also resolves role templates from:

- `.agents/<name>/AGENTS.md`
- `.agents/<name>.md`

This is useful as an internal deploy convention, but it is not backed by a clearly documented upstream Codex subagent format in the materials reviewed.

#### Gaps to paper over

- Codex has strong repo instructions but weak confirmed evidence for a Claude-style project-local subagent folder.
- `id-agents` already invented a workable `.agents/` convention. That is acceptable for our deploy system as long as we label it clearly as an **id-agents compatibility layer**, not “the official Codex folder layout.”

### Cursor CLI

#### Upstream convention

Cursor officially documents:

- project rules in `.cursor/rules/*.mdc`
- `AGENTS.md` at project root as a simple alternative to rules
- `CLAUDE.md` is also read by the CLI and applied alongside `.cursor/rules`
- CLI supports `plan` and `ask` read-only modes
- CLI supports workspaces, worktrees, and headless print mode
- `generate-rule|rule` is a first-class CLI command

Current official limitations for `AGENTS.md` in Cursor docs:

- root-level only
- no scoping
- single file

Cursor docs do **not** clearly document a `.cursor/agents/` subagent directory as a stable convention.

#### What id-agents currently knows

`id-agents` currently maps Cursor to:

- template dir: `.cursor/agents`
- overlay target: `.cursor`
- skills dir: `.cursor/skills`
- personality file: `AGENTS.md`

This means our current runtime registry assumes more structure than Cursor’s official docs confirm.

#### Gaps to paper over

- Cursor officially gives us `.cursor/rules` and root `AGENTS.md`/`CLAUDE.md`.
- `id-agents` currently assumes a `.cursor/agents` and `.cursor/skills` convention.
- For v1 we should keep those as **our deploy contract**, but explicitly document that they are `id-agents` packaging conventions for Cursor, not native Cursor discovery guarantees.

### Cross-harness comparison

| Harness | Confirmed upstream file shapes | Confirmed root/home locations | id-agents current model | Main gap |
|---|---|---|---|---|
| Claude Code | subagent `.md`, `CLAUDE.md`, `.claude/rules`, `.claude/skills`, `.claude/commands`, settings-defined hooks | project `.claude/*`, root `CLAUDE.md`, home `~/.claude/*` | strongest match | template manifest missing |
| Codex CLI | `AGENTS.md`, user rules/skills/memories under `~/.codex` | repo root + `~/.codex/*` | `.agents/*` compatibility layer | project-local subagent format not confirmed |
| Cursor CLI | `.cursor/rules/*.mdc`, root `AGENTS.md`, root `CLAUDE.md` | repo root `.cursor/*` | `.cursor/agents` compatibility layer | richer folder model is ours, not upstream |

## 2. Agent-Template Folder Schema

### Canonical template layout

Proposed canonical layout:

```text
templates/frontend-react-ts/
├── template.yaml
├── README.md
├── skills/
│   └── <skill-name>/...
├── agents/
│   └── <agent-name>/
│       ├── prompt.md
│       └── files/...
├── memory/
│   ├── base.md
│   ├── claude/CLAUDE.md
│   ├── codex/AGENTS.md
│   └── cursor/AGENTS.md
├── rules/
│   ├── claude/*.md
│   ├── codex/*.md
│   └── cursor/*.mdc
├── commands/
│   └── claude/*.md
├── hooks/
│   ├── claude/settings.json
│   └── scripts/...
├── scripts/
│   └── ...
└── files/
    └── shared overlay files
```

### Required vs optional

Required:

- `template.yaml`
- `README.md`

Optional:

- `skills/`
- `agents/`
- `memory/`
- `rules/`
- `commands/`
- `hooks/`
- `scripts/`
- `files/`

### Why these names

- `template.yaml` is the manifest and should be the only required machine-readable file.
- `memory/` is more portable than forcing `CLAUDE.md` or `AGENTS.md` at source.
- `rules/` must be harness-partitioned because Cursor and Claude use different formats.
- `agents/` is deliberately generic; it means “specialized teammate definitions bundled by the template,” not “the deployed folder path.”

### `template.yaml` shape

Proposed minimal schema:

```yaml
name: frontend-react-ts
displayName: Frontend React + TypeScript
version: 0.1.0
avatar: frontend-developer
author: idchain
license: MIT
description: Opinionated frontend coding agent with React, TypeScript, and UI polish defaults.

compatibility:
  harnesses:
    - claude-code-cli
    - codex
    - cursor-cli

contents:
  skills: true
  agents: true
  memory: true
  rules: true
  commands: true
  hooks: false
  scripts: true

deploy:
  mergeStrategy:
    memory: append-with-markers
    rules: replace-by-filename
    skills: replace-by-directory
    commands: replace-by-filename
```

### Per-harness deployment mapping

#### Claude Code target

- `skills/<skill>` -> `.claude/skills/<skill>`
- `agents/<name>/prompt.md` -> `.claude/agents/<name>.md`
- `agents/<name>/files/*` -> `.claude/agents/<name>/...`
- `memory/claude/CLAUDE.md` else `memory/base.md` -> `.claude/CLAUDE.md`
- `rules/claude/*.md` -> `.claude/rules/*.md`
- `commands/claude/*.md` -> `.claude/commands/*.md`
- `hooks/claude/settings.json` -> `.claude/settings.json`
- `hooks/scripts/*` -> `.claude/hooks/*`
- `files/*` -> workspace-relative overlay paths defined in manifest

#### Codex target

- `skills/<skill>` -> `.agents/skills/<skill>`
- `agents/<name>/prompt.md` -> `.agents/<name>.md` for v1
- `agents/<name>/files/*` -> `.agents/<name>/...`
- `memory/codex/AGENTS.md` else `memory/base.md` -> `AGENTS.md`
- `rules/codex/*.md` -> `.codex/rules/<template-name>-*.md` only if explicitly requested for user-home install in a future phase
- `commands/` -> no mapping in v1
- `hooks/` -> no mapping in v1

Important v1 boundary:

- Do **not** write into `~/.codex/` from normal agent deployment.
- Keep Codex deploys workspace-local.

#### Cursor target

- `skills/<skill>` -> `.cursor/skills/<skill>` as an `id-agents` convention
- `agents/<name>/prompt.md` -> `.cursor/agents/<name>.md` as an `id-agents` convention
- `agents/<name>/files/*` -> `.cursor/agents/<name>/...`
- `memory/cursor/AGENTS.md` else `memory/base.md` -> `AGENTS.md`
- `rules/cursor/*.mdc` -> `.cursor/rules/*.mdc`
- `commands/` -> no mapping in v1
- `hooks/` -> no mapping in v1

This lets Cursor get maximum value from what it officially supports today:

- root `AGENTS.md`
- `.cursor/rules/*.mdc`

### Recommendation

Use the canonical schema above and make per-harness mapping explicit in code, not implied by directory names alone.

## 3. id-agents Config Extension

### Current state

Today the agent spec supports:

- `skills: string[]`
- `plugins: {name, path}[]`
- `agent: string` as a role-template selector

There is no first-class `template` field.

### Proposed extension

Add:

```yaml
agents:
  - name: frontend
    runtime: claude-code-cli
    workingDirectory: /path/to/workspace
    template:
      source: ../public-agents/templates/frontend-react-ts
```

Expanded form:

```yaml
agents:
  - name: frontend
    runtime: cursor-cli
    workingDirectory: /path/to/workspace
    template:
      source: ../public-agents/templates/frontend-react-ts
      version: 0.1.0
      strategy: merge
      memoryMode: append
```

And a short form:

```yaml
agents:
  - name: frontend
    template: ../public-agents/templates/frontend-react-ts
```

### Proposed TypeScript shape

```ts
type TemplateRef =
  | string
  | {
      source: string;
      version?: string;
      strategy?: 'merge' | 'replace';
      memoryMode?: 'append' | 'replace';
    };
```

Add to `AgentSpec`:

- `template?: TemplateRef`

### Backward compatibility

- Existing `skills` behavior stays unchanged.
- Existing `agent` role-template behavior stays unchanged.
- If `template` is present, it becomes an additional deploy source, not a replacement for `skills`.
- Resolution order:
  1. template bundle deploy
  2. direct `skills` deploy
  3. runtime personality write
  4. legacy `agent` roleBody overlay, if still used

That preserves old configs and lets teams migrate incrementally.

## 4. Deploy Mechanics

### v1 deployment flow

At `id-cli register-agent` time: nothing. `id-cli` should remain onchain-only in v1.

At `id-agents /deploy` or `/sync` time:

1. Resolve template source
2. Read `template.yaml`
3. Validate harness compatibility
4. Copy template bundle into a staging area inside the agent workspace
5. Remap from canonical layout into harness-specific target paths
6. Merge or overwrite according to manifest rules
7. Write a deploy receipt for idempotency

### Pick one v1 source model

Pick **local path only** for v1.

Allowed:

- relative path
- absolute path

Deferred to v1.1:

- git clone
- registry lookup

Reason:

- local path is enough to ship template bundles from `public-agents`
- it avoids fetch/auth/caching/version-resolution complexity
- it keeps license review local and inspectable

### Workspace behavior

Deploy into the target agent workspace only.

Do not write to:

- `~/.claude`
- `~/.codex`
- `~/.cursor`

except in a future explicit “install globally” flow.

### Merge vs overwrite semantics

#### Skills

- key = skill directory name
- behavior = replace directory atomically by name

#### Memory files

- default v1 behavior = append template-managed block with markers
- markers:
  - `BEGIN id-agents template:<template-name>`
  - `END id-agents template:<template-name>`

On re-deploy:

- replace only the marked block
- preserve user edits outside the block

#### Rules

- key = relative filename
- behavior = replace by filename

#### Commands

- key = relative filename
- behavior = replace by filename

#### Hooks/settings

- v1 default = skip unless target file absent

Reason:

- hooks can be destructive because they are executable and globally behavior-changing

### Idempotency

Write a deploy receipt, for example:

```text
.id-agents/template-deploy.json
```

Suggested contents:

```json
{
  "template": "frontend-react-ts",
  "version": "0.1.0",
  "runtime": "claude-code-cli",
  "source": "/abs/path/to/template",
  "deployedAt": "2026-04-24T11:29:20-04:00",
  "files": {
    ".claude/skills/using-foundry/SKILL.md": "sha256:...",
    ".claude/CLAUDE.md": "sha256:..."
  }
}
```

On re-deploy:

- compare manifest + file hashes
- replace only managed files that drifted
- never duplicate marked memory blocks

## 5. TUI Surface

### Product shape

The TUI should expose template discovery only in v1.

Proposed views:

- `templates` list
- `template-detail`

Displayed in list:

- template name
- version
- avatar
- compatible harnesses
- license

Displayed in detail:

- README preview
- bundled skills
- bundled agent definitions
- memory/rules/commands/hook presence
- source path

No install action in v1.

### Where it fits in code

The existing TUI already has the right architecture for this:

- top-level view state in `src/tui/App.tsx`
- list/detail table pattern in:
  - `TasksTable.tsx`
  - `TaskDetail.tsx`
  - `AgentDetail.tsx`
- fetch helpers in `src/tui/api/manager.ts`
- types in `src/tui/api/types.ts`

Recommended landing points:

- add `templates | template-detail` to the `View` union in `src/tui/App.tsx`
- add `TemplatesTable.tsx` and `TemplateDetail.tsx`
- add fetcher/type pair alongside tasks
- use the same read-only polling and list-windowing pattern as tasks/calendar/heartbeats

Data source recommendation:

- add a manager read endpoint or `/remote` command in `id-agents`
- TUI should not read the filesystem directly

## 6. Rollout

### v1 ships

- canonical template bundle schema with `template.yaml`
- local-path template references in agent config
- deploy support in `id-agents /deploy` and `/sync`
- explicit harness remapping for Claude, Codex, Cursor
- receipt-based idempotent re-deploy
- TUI read-only template discovery
- at least one production template built from the shipped Foundry skills pack

### v1.1 adds

- git URL source resolution
- template registry/index lookup
- template version pinning
- template update diff preview
- optional global install surfaces for user-home dirs
- richer Cursor and Codex support if upstream subagent/package conventions become clearer

### Known risks

#### License contamination

This is the biggest product risk.

- MIT or Apache-2.0 skills can usually be bundled into MIT-compatible templates with attribution.
- CC-BY-SA-4.0 skills are different:
  - they create share-alike obligations
  - mixing them into a larger “template pack” may force the pack or derived parts into compatible share-alike terms
  - they should not be silently merged into otherwise MIT-branded templates

Recommendation:

- add `license` and `thirdParty[]` metadata to `template.yaml`
- fail validation if a template mixes incompatible licenses without an explicit override
- ship separate template families when needed:
  - `templates-mit/`
  - `templates-sharealike/`

#### Upstream mismatch risk

- Claude surfaces are well-documented.
- Codex and Cursor are less symmetric.
- `id-agents` should clearly distinguish:
  - “upstream-native convention”
  - “id-agents compatibility convention”

That prevents future breakage when upstream vendors publish more formal folder contracts.

#### Merge surprise risk

- writing directly into `AGENTS.md` or `CLAUDE.md` can clobber user edits
- hooks/settings can change behavior far beyond the template itself

Recommendation:

- use block markers for memory
- use replace-by-key for managed directories
- skip hooks/settings merge unless explicitly enabled

## Recommended Implementation Order

1. Add `template` field to config parsing and validation.
2. Add template manifest loader and canonical schema validator.
3. Add deploy remapper and receipt writer in `id-agents`.
4. Convert one real template from `public-agents/skills/foundry/`.
5. Add manager read endpoint for template inventory.
6. Add TUI read-only templates list/detail views.

## Recommended v1 Positioning

Call this feature:

- **agent templates**

Define it precisely:

- a template is a versioned bundle of skills plus harness-specific instruction assets that `id-agents` can deploy into an agent workspace

That is narrower and more implementable than “starter kits,” and broader than “skills pack.”

## Sources

Local code and repos:

- `id-agents/src/runtime/registry.ts`
- `id-agents/src/config-parser.ts`
- `id-agents/src/agent-manager-db.ts`
- `id-agents/src/tui/App.tsx`
- `id-agents/src/tui/components/*`
- `id-agents/docs/reference/harnesses.md`
- `id-agents/docs/reference/configuration.md`
- `public-agents/research/agent-template-avatars.md`
- `public-agents/skills/foundry/`
- `id-cli/src/commands/agent.ts`

Official docs and CLI help:

- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code slash commands: https://docs.anthropic.com/en/docs/claude-code/slash-commands
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- OpenAI Codex product/docs nav and AGENTS.md references:
  - https://developers.openai.com/
  - https://openai.com/index/introducing-codex/
- Cursor CLI/rules:
  - https://docs.cursor.com/en/cli/using
  - https://docs.cursor.com/en/context
  - local `cursor-agent --help`
  - local `codex --help`

Inference notes:

- Codex project-local subagent folders were not confirmed from the reviewed official materials; this plan therefore treats `.agents/` as an `id-agents` compatibility convention.
- Cursor `.cursor/agents` and `.cursor/skills` were not confirmed from official Cursor docs; this plan keeps them as deploy-time `id-agents` conventions and leans on officially-supported root `AGENTS.md` plus `.cursor/rules/*.mdc`.

# Revision v2 (2026-04-24)

Status: superseded for implementation planning by Revision v3 (2026-04-24). The earlier draft is retained in this file for history, but Sections 2 through 6 should be read as replaced by the model below.

## Summary

The operator simplified the source model materially:

- there is no template artifact, no `template.yaml`, and no invented canonical bundle format
- an agent library entry is just a Git-friendly `.claude/`-shaped directory under `/config/agents/<name>/`
- standalone skills live separately under `/config/skills/<name>/`
- team config references one optional `agent: <string>` plus peer `skills: <string[]>`
- deploy is sequential layering:
  - Step A copies the selected agent directory into the workspace harness target
  - Step B overlays each selected config-level skill into the harness skill target, with last-writer-wins over same-name skills shipped by the agent

Section 1 remains valid as written. The revision below replaces the old Section 2 folder schema, Section 3 config extension, Section 4 deploy mechanics, Section 5 TUI framing, and Section 6 rollout plan.

## 2. Agent Library Layout

Replace the old "agent-template folder schema" wholesale with a fixed library layout known to `id-agents`.

### Agent library

Each agent lives at:

```text
/config/agents/<name>/
├── CLAUDE.md
├── README.md
├── LICENSE
├── skills/
├── agents/
├── commands/
├── rules/
├── hooks/
├── settings.json
└── files/
```

Rules:

- a directory is discovered as an agent iff it contains `CLAUDE.md`
- the folder is intentionally `.claude/`-shaped rather than schema-driven
- `README.md` and `LICENSE` are part of the expected repo hygiene for published library entries
- the library root is fixed:
  - `/config/agents/`
  - `/config/skills/`

There is no manifest file. Compatibility, contents, and deploy behavior are inferred from the directory contents plus the runtime mapping layer already described in Section 1.

### Standalone skills library

Each standalone skill pack lives at:

```text
/config/skills/<name>/
└── SKILL.md
```

Optional neighboring skill assets remain allowed, but the discovery test is simply "single skill folder with `SKILL.md`."

### Discovery model

- Agent inventory: enumerate `/config/agents/*/` and include entries with `CLAUDE.md`
- Skill inventory: enumerate `/config/skills/*/` and include entries with `SKILL.md`
- There is no local-path resolution from arbitrary config values in v2; config names map to these fixed library roots

## 3. id-agents Config Extension

Replace the old `template:` proposal with two peer fields on each agent entry:

```yaml
agents:
  - name: frontend
    runtime: claude-code-cli
    workingDirectory: ~/projects/acme-app
    agent: frontend-react-ts
    skills:
      - using-foundry
      - writing-foundry-tests
```

Semantics:

- `agent: string`
  - optional
  - names a folder under `/config/agents/<name>/`
- `skills: string[]`
  - optional
  - each string names a folder under `/config/skills/<name>/`
  - remains a peer field, not nested under `agent`

Backward compatibility:

- preserve existing `skills: string[]` behavior
- preserve the existing `agent` field shape as a string
- change its meaning for this feature to "named agent library entry" rather than "template source path"
- configs that already use `skills` without `agent` still work

Recommended processing order:

1. Resolve runtime and working directory.
2. If `agent` is set, resolve `/config/agents/<agent>/`.
3. Resolve each config-level skill from `/config/skills/<skill>/`.
4. Deploy in sequence so config-level skills can intentionally override agent-shipped skills of the same name.

## 4. Deploy Mechanics

Replace the old manifest-driven deploy flow with a fixed sequential overlay.

### Deployment flow

At `/deploy` or `/sync` time:

1. Resolve the selected agent library folder from `/config/agents/<agent-name>/`.
2. Copy that folder into the harness-specific workspace target.
3. For each config-level skill name, copy `/config/skills/<skill>/` into the harness-specific skill destination.
4. Write/update deploy receipt metadata with per-file hashes and provenance.

There is no v2 concept of:

- arbitrary template source paths
- `template.yaml`
- manifest-declared merge strategy
- staging from a generic canonical format

### Sequential layering contract

Step A:

- rsync `/config/agents/<agent-name>/` -> `<workspace>/.claude/` for Claude-shaped deployment

Step B:

- for each config skill, rsync `/config/skills/<skill>/` -> `<workspace>/.claude/skills/<skill>/`

Conflict rule:

- config-level skills overwrite same-name skills shipped inside the agent folder
- last writer wins deterministically

This is simpler than the prior proposal because the agent folder itself already carries the `.claude/`-shaped payload.

### Per-harness mapping

The principle is unchanged: Claude can receive an identity copy of the agent folder, while Codex and Cursor still need remapping from Claude-shaped source names into their local conventions.

| Source item in `/config/agents/<name>/` | Claude Code target | Codex target | Cursor target | Notes |
|---|---|---|---|---|
| `CLAUDE.md` | `.claude/CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | main personality/instruction file |
| `skills/<skill>/` | `.claude/skills/<skill>/` | `.agents/skills/<skill>/` or other existing Codex compatibility target | `.cursor/skills/<skill>/` or other existing Cursor compatibility target | `id-agents` compatibility layer for non-Claude harnesses remains explicit |
| `agents/` | `.claude/agents/` | mapped into existing Codex compatibility surface | mapped into existing Cursor compatibility surface | preserve current runtime-specific remapper behavior |
| `commands/` | `.claude/commands/` | no v2 change from prior mapping policy | no v2 change from prior mapping policy | harness support differs |
| `rules/` | `.claude/rules/` | runtime-specific remap if supported | `.cursor/rules/` where applicable | keep current harness-aware handling |
| `hooks/` / `settings.json` | `.claude/hooks/`, `.claude/settings.json` | runtime-specific remap/skip policy | runtime-specific remap/skip policy | same risk posture as prior draft |
| `files/` | copied per runtime overlay rules | copied per runtime overlay rules | copied per runtime overlay rules | unchanged in principle |

Implementation guidance:

- keep the existing per-harness mapping table in code/docs, but rename the source side from "canonical template layout" to "agent library folder"
- keep distinguishing upstream-native surfaces from `id-agents` compatibility conventions for Codex and Cursor

### Drift, markers, and receipts

The drift and receipt model from the original draft still stands, with naming updated from `template` to `agent` plus `skills` layers.

Recommended receipt content per managed destination file:

- destination path
- SHA256
- source kind: `agent-folder` or `skill-layer`
- source name: agent name or skill name

This provenance is required so re-deploy can answer:

- which files belong to the base agent layer
- which files were later overlaid by config-level skills
- which source should win on the next run

#### Marker strategy

Memory-file block replacement remains the safest merge mode for root instruction files.

Recommended markers:

- agent block:
  - `BEGIN id-agents agent:<name>`
  - `END id-agents agent:<name>`
- skill block:
  - `BEGIN id-agents skill:<name>`
  - `END id-agents skill:<name>`

Cleanest approach:

- reserve the root `CLAUDE.md` / `AGENTS.md` managed block for the agent layer
- if skill content also needs to contribute to the root instruction file, append separate per-skill blocks after the agent block in deploy order
- receipt provenance should point each block-backed file entry to the contributing layer so re-deploy can replace only the right segment

Everything else from the prior drift semantics still applies:

- SHA256 per destination file
- replace only managed blocks/files
- preserve user edits outside managed regions
- avoid duplicate blocks on re-deploy

### License contamination risk

This risk remains unchanged and still needs to be called out prominently. The source model is simpler, but combining third-party skill content into agent folders or config-level overlays can still create license-mixing problems. The prior recommendations about explicit licensing, attribution, and avoiding silent share-alike mixing remain valid.

## 5. TUI Surface

Replace the old "template browser" framing with read-only browsers for the two library roots.

### Product shape

The TUI should expose:

- `agents` library list/detail for `/config/agents/`
- `skills` library list/detail for `/config/skills/`

Displayed in the agents list:

- agent library name
- presence of `README.md`
- license file presence
- discovered subdirectories/surfaces summary

Displayed in the skills list:

- skill name
- presence of `SKILL.md`
- optional short description preview

Displayed in detail:

- README preview where present
- surfaced folder inventory
- source path

No write/install action is needed in v2. This remains a read-only manager-backed browser.

### Data source

Keep the manager endpoint model from the earlier draft:

- the TUI should fetch library listings through the manager
- the TUI should not read the filesystem directly

Manager endpoints now need to enumerate:

- `/config/agents/`
- `/config/skills/`

and return list/detail payloads for the TUI.

## 6. Rollout

Replace the earlier rollout with the simpler v2 scope.

### v2 scope

Ship:

- fixed library discovery under `/config/agents/` and `/config/skills/`
- config support for peer `agent:` and `skills:`
- sequential deploy:
  - base agent folder first
  - config-level skills second
- existing per-harness remapping preserved
- drift detection and receipt provenance per managed file
- read-only TUI browsers for agents and skills libraries

Do not ship in v2:

- manifest files
- local path source resolution
- git/registry fetch
- schema-heavy bundle validation

### Recommended implementation order

1. Add library enumerators for `/config/agents/` and `/config/skills/`.
2. Update config parsing to treat `agent` and `skills` as peer library references.
3. Rewrite deploy logic to do Step A then Step B with deterministic overwrite order.
4. Update receipts to track per-file provenance as `agent-folder` vs `skill-layer`.
5. Add manager read endpoints for library inventory.
6. Add TUI agents/skills browser views.

### Positioning

The simpler story is now:

- an agent library entry is a reusable `.claude/`-shaped repo directory
- a skill library entry is a reusable standalone skill folder
- team config composes one base agent plus zero or more extra skills
- deploy is just deterministic filesystem layering with receipts

# Revision v3 (final, 2026-04-24)

Status: final implementation-planning revision. Revision v2 is retained as history but superseded by this section for implementation work.

## Summary

The operator session converged on a narrower and more native model than v2:

- `/configs/agents/` supports two library shapes natively:
  - Claude-native directory entries
  - AGENTS.md-native sibling `.md` + directory pairs
- `/configs/skills/<name>/SKILL.md` remains unchanged as the cross-vendor skill format
- sync is additive-only and receipt-driven
- no file the user owns is ever modified or deleted

This revision also includes a verified compatibility note on `agent:`:

- current `id-agents` code still exposes `agent?: string` in config parsing and the TUI forwarding path
- the present implementation is a hardcoded `configs/agents/<agent>/ -> .claude/` overlay
- there are no current team configs using `agent:`
- the live template mechanism in production is the existing `name`-based sub-agent template lookup, not the `agent:` overlay field

That means v3 can safely repurpose `agent:` as the library-entry selector without a production migration burden. The old behavior is only relevant as a code/test compatibility cleanup concern, not as an active user workflow.

## 1. Library Layout

`/configs/agents/` accepts exactly two native source shapes.

### Claude-native

```text
/configs/agents/<name>/
├── CLAUDE.md
├── skills/
├── agents/
├── commands/
├── rules/
├── settings.json
├── hooks/
└── files/
```

Rules:

- the directory is an agent entry iff `CLAUDE.md` exists
- optional surfaces are `skills/`, `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, and `files/`

### AGENTS.md-native

```text
/configs/agents/<name>.md
/configs/agents/<name>/
└── skills/
```

Rules:

- the `.md` file is the memory/persona file
- the sibling directory holds extras, primarily `skills/`
- there is no `AGENTS.md` inside the folder
- the pair is an agent entry only when both the `.md` file and the sibling directory exist

### Skills library

`/configs/skills/<name>/SKILL.md` stays unchanged. This remains the shared open skill format used by Claude and Codex.

## 2. Discovery Rule

Enumerate `/configs/agents/*`.

An entry is an agent iff either:

- `<name>/CLAUDE.md` exists
- both `<name>.md` and `<name>/` exist as siblings

Both shapes are first-class and supported natively. Discovery should deduplicate by logical agent name so an accidental mixed-shape collision becomes a validation error instead of producing two entries.

Skill discovery is unchanged:

- enumerate `/configs/skills/*`
- include folders containing `SKILL.md`

## 3. Config Shape

Each configured agent entry uses peer fields:

```yaml
agents:
  - name: frontend
    runtime: claude-code-cli
    workingDirectory: ~/projects/acme-app
    agent: frontend-react-ts
    skills: [using-foundry, writing-foundry-tests]
```

Rules:

- `agent:` selects one library agent entry by name
- `skills:` selects zero or more standalone skills by name
- `agent:` and `skills:` are peers, not nested

## 4. `agent:` Compatibility Decision

The requested survey is complete.

Verified state in current `id-agents`:

- `agent?: string` exists in `src/config-parser.ts`
- `copyLibraryAgentOverlay()` currently treats it as a direct `configs/agents/<agent>/ -> .claude/` overlay
- no checked-in team configs currently use `agent:`
- `configs/agents/` is presently empty
- tests cover the old helper, but there is no production data depending on it

Design consequence:

- v3 does not need a production compatibility fallback for `agent:`
- implementation can redefine `agent:` as the new library selector directly

Guardrails for rollout:

- clearly document in code and release notes that `agent:` now resolves named library entries across both native source shapes
- keep the old helper/tests only long enough to replace them with the new runtime-aware resolver
- avoid conflating this field with the separate, still-live `name`-based sub-agent template lookup

If maintainers still want a temporary bridge during refactor, the safe precedence is:

1. new library entry resolution under `/configs/agents/`
2. otherwise no special fallback for old overlay semantics

That bridge is optional, not required by production usage.

## 5. Sync Mechanics

Sync remains two-stage and additive-only.

### Step A: deploy the selected agent

- resolve the chosen library entry
- walk every source file contributed by that entry
- map each source file through the runtime translation table
- for each destination file, apply the 4-case ownership logic below

### Step B: deploy config-level skills

- for each name in `skills:`
- copy `/configs/skills/<skill>/SKILL.md` and any neighboring assets
- route them through the same runtime translation table and the same 4-case ownership logic

Order matters:

- agent layer first
- standalone config skills second

This preserves intentional skill overrides without introducing destructive merge behavior.

## 6. Four-Case Ownership Logic

Per destination file:

| Target state | Action |
|---|---|
| Does not exist | Write, add to receipt |
| Exists, disk SHA == source SHA | No-op, ensure receipt entry present |
| Exists, disk SHA == receipt SHA | Still ours, overwrite with new content, update receipt |
| Exists, disk SHA is something else | User-owned or user-edited. Skip and warn. Do not write. |

This is the core rule for both deploy and re-sync.

Interpretation:

- matching the source SHA means the file is already correct
- matching the prior receipt SHA means we previously owned it and may update it
- any other drift means the file is sacred and must not be touched

## 7. Receipt

Use one receipt file per workspace:

```text
<workspace>/.id-agents/receipt.json
```

Schema requirements:

- one entry per managed destination file
- `sha256`: latest content hash only
- `source`: `agent:<name>` or `skill:<name>`

Operational requirements:

- rewrite atomically on every successful sync
- write to a temporary file first, then rename into place
- the receipt is the ownership ledger for deploy, re-sync, and undeploy

No historical hash chain is needed.

## 8. Memory-File Fallback

When the target harness already has its own root memory file, v3 does not silently merge.

### Claude target

If the workspace already has `CLAUDE.md`, write the persona content to:

```text
.claude/rules/agent-<name>.md
```

Reason:

- additive only
- Claude auto-loads `.claude/rules/*.md`

### Codex or Cursor target

If the workspace already has `AGENTS.md`:

- refuse deploy with a clear error
- do not silently merge
- instruct the operator to delete or rename `AGENTS.md`, or append the persona manually and re-run with `--skip-memory`

## 9. Per-Harness Mapping

Keep the v2 mapping-table concept, but correct the Codex skill entry and make the mapping explicitly deploy-time.

| Library source | Claude target | Codex target | Cursor target | Notes |
|---|---|---|---|---|
| Claude-native `CLAUDE.md` | `CLAUDE.md` or fallback `.claude/rules/agent-<name>.md` | `AGENTS.md` subject to existing-file refusal rule | `AGENTS.md` subject to existing-file refusal rule | root memory handling is harness-specific |
| AGENTS.md-native `<name>.md` | `CLAUDE.md` or fallback rules file | `AGENTS.md` subject to refusal rule | `AGENTS.md` subject to refusal rule | same persona source, different target name |
| `skills/<skill>/` from agent entry | `.claude/skills/<skill>/` | `.agents/skills/<skill>/` | flatten into supported target surface or drop with warning | Codex supports native skills here; Cursor still does not |
| standalone `/configs/skills/<skill>/` | `.claude/skills/<skill>/` | `.agents/skills/<skill>/` | flatten into supported target surface or drop with warning | same mapping as agent-shipped skills |
| `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/` | native Claude surfaces | runtime remap or skip per supported Codex surface | runtime remap or skip per supported Cursor surface | unsupported surfaces must warn, not invent silent merge behavior |

Cursor remains the least native target:

- no native skills folder should be claimed
- skill content must either flatten into a supported deploy surface or be skipped with a warning

## 10. Undeploy

Undeploy walks the receipt.

For each receipt entry:

- if disk SHA equals receipt SHA, the file is still ours, so delete it
- if disk SHA has drifted, leave the file on disk and only remove the receipt entry

Result:

- user-edited files always survive undeploy
- receipt cleanup is safe even when ownership has been lost due to edits

## 11. TUI

The TUI surface remains unchanged from v2 in scope:

- read-only browser for `/configs/agents/`
- read-only browser for `/configs/skills/`

The only model update is discovery:

- agent inventory must understand both native agent shapes
- skill inventory is unchanged

## 12. Sacredness Statement

No file the user owns is ever modified or deleted.

Ownership is established by the receipt:

- a file is ours iff its current SHA matches what we last wrote
- everything else is sacred

This statement is the implementation rule, not just product copy.

## 13. Recommended Implementation Order

Implementation should ship in small reviewed slices:

1. library enumerators for `/configs/agents/` and `/configs/skills/`
2. config parsing with peer `agent:` and `skills:` fields, using the new library semantics
3. 4-case sync engine with SHA and receipt machinery
4. memory-file fallback logic
5. per-harness rename-at-deploy translation table
6. undeploy and receipt cleanup
7. manager read endpoints for library inventory
8. TUI browser views

Each slice should land green before the next begins:

- `tsc`
- tests
- targeted integration smoke where applicable

That frame is narrower, easier to explain, and much closer to how the target harnesses already behave.

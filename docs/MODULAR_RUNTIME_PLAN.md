# Modular Runtime Plan

## Goal

Make Claude SDK, Claude Code CLI, Codex CLI, and mixed-runtime teams predictable to deploy, validate, run, and debug.

The current system works, but runtime selection is still spread across manager logic, local process startup, agent server behavior, harness implementations, and UI text. That makes mixed teams fragile and causes runtime-specific bugs to leak into unrelated layers.

## Problems To Fix

### 1. Runtime is not a first-class concept

Today the codebase still mixes:

- agent `type` (`claude`, `interactive`, `virtual`)
- runtime (`claude-agent-sdk`, `claude-code-cli`, `codex`)
- provider-specific naming (`Claude Agent`, `Claude Code`, `Codex`)

That creates confusion about which field controls execution and which field is just describing topology.

### 2. Runtime defaults are inferred in multiple places

The following decisions are currently duplicated or implied:

- default model
- auth expectations
- environment variables
- session resume behavior
- display labels
- process spawn env
- validation rules

This makes it easy for one layer to think an agent is Codex while another still behaves like Claude.

### 3. Runtime behavior leaks outside harnesses

The recent Codex fix required changes in:

- manager deploy logic
- local worker spawn env
- agent server session handling
- runtime UI labels

That is a sign the harness contract is too thin. Runtime-specific behavior should be encapsulated more cleanly.

### 4. Team startup lacks validation and smoke tests

Deploys should fail fast when configs are inconsistent. Right now too much invalid state is allowed to start and only fails during live requests.

## Target Design

Split runtime concerns into three explicit layers:

1. `AgentTopology`
2. `RuntimeProfile`
3. `HarnessAdapter`

### AgentTopology

Describes how an agent is hosted and addressed:

- `interactive`
- `local`
- `remote`
- `virtual`

This replaces overloading `type` as both topology and runtime.

### RuntimeProfile

Describes how an agent executes LLM work:

- `claude-agent-sdk`
- `claude-code-cli`
- `codex`

Each runtime profile should define:

- `id`
- display name
- provider name
- default model
- supported auth modes
- session policy
- whether plugins are supported
- whether a local CLI login is required
- required env vars
- optional env vars
- config validation rules

### HarnessAdapter

Owns execution semantics for one runtime:

- argument construction
- stdin/stdout parsing
- session behavior
- error normalization
- capability reporting

The server layer should not need special-case runtime logic except to ask the profile what is supported.

## Proposed Module Shape

Add a new runtime module family:

```text
src/runtime/
  types.ts
  registry.ts
  profiles/
    claude-agent-sdk.ts
    claude-code-cli.ts
    codex.ts
```

### `src/runtime/types.ts`

Core types:

```ts
export type AgentTopology = 'interactive' | 'local' | 'remote' | 'virtual';
export type RuntimeId = 'claude-agent-sdk' | 'claude-code-cli' | 'codex';

export interface RuntimeProfile {
  id: RuntimeId;
  displayName: string;
  providerName: string;
  defaultModel: string;
  sessionPolicy: 'persistent' | 'fresh-per-query';
  auth: {
    mode: 'api-key' | 'cli-login';
    requiredEnv?: string[];
  };
  capabilities: {
    supportsResume: boolean;
    supportsPlugins: boolean;
    supportsAllowedTools: boolean;
  };
  validate(config: RuntimeValidationInput): RuntimeValidationIssue[];
  buildEnv(input: RuntimeEnvInput): NodeJS.ProcessEnv;
}
```

### `src/runtime/registry.ts`

Single source of truth:

- `getRuntimeProfile(runtimeId)`
- `resolveRuntime(agentConfig, defaults)`
- `validateRuntime(agentConfig)`
- `getRuntimeDisplayName(runtimeId)`

This becomes the only place that knows runtime defaults.

## Responsibilities By Layer

### Manager

Files:

- `src/agent-manager-db.ts`
- `src/interactive-agent-cli.ts`

Manager should:

- resolve runtime once
- validate runtime before deploy
- persist runtime explicitly
- build spawn env from the runtime profile
- expose runtime metadata to CLI/UI

Manager should not:

- hardcode Codex model defaults inline
- know per-runtime resume behavior
- manually map UI labels for each runtime

### Local Agent Bootstrap

File:

- `src/local-agent-server.ts`

Bootstrap should:

- read resolved runtime from env or config
- ask runtime registry for display labels
- ask runtime profile for auth expectations

Bootstrap should not:

- infer runtime behavior from ad hoc string comparisons

### Agent Server

File:

- `src/claude-agent-server.ts`

This file should eventually be renamed to something runtime-neutral such as:

- `src/agent-rest-server.ts`

Server should:

- create the correct harness
- query the runtime profile for user-facing labels
- obey runtime session policy

Server should not:

- contain provider-specific UI wording
- special-case Codex behavior outside profile/harness contracts

### Harnesses

Files:

- `src/harness/*.ts`

Harnesses should:

- implement execution
- normalize output
- report runtime-specific failures clearly

Harnesses should not:

- rely on the server to compensate for runtime incompatibilities

## Validation Layer

Add deploy-time validation before any process is started.

Examples:

- `runtime=codex` with a Claude model should be an error
- `runtime=claude-agent-sdk` without `ANTHROPIC_API_KEY` should be an error
- `runtime=codex` without `codex login status` success should be an error
- unsupported plugin/runtime combinations should be warnings or errors

Add a command path for explicit validation:

```bash
/validate configs/my-team.yaml
```

Validation should output:

- agent name
- topology
- runtime
- model
- auth status
- warnings
- blockers

## Team Launch Flow

Add a launch flow that works the same for single-runtime and mixed-runtime teams:

1. Parse config
2. Resolve runtime for each agent
3. Validate runtime and auth prerequisites
4. Create team if needed
5. Spawn agents
6. Poll health
7. Verify `/.well-known/restap.json`
8. Run a smoke-test prompt per agent
9. Print a summary table

This should become a first-class CLI path rather than an accidental side effect of deploy.

## Migration Plan

### Phase 1: Runtime Registry

Introduce runtime profiles without changing external behavior.

Tasks:

- add `src/runtime/types.ts`
- add `src/runtime/registry.ts`
- define profiles for Claude SDK, Claude Code CLI, and Codex
- move display-name logic out of server/bootstrap files
- move default-model logic out of manager inline branches

### Phase 2: Validation

Add preflight checks to deploy and config parsing.

Tasks:

- runtime/model compatibility checks
- CLI auth checks
- env requirement checks
- plugin compatibility warnings

### Phase 3: Session Policy Cleanup

Move session semantics fully into runtime profile plus harness contract.

Tasks:

- replace server-side runtime-specific session branching
- let runtime profile advertise `sessionPolicy`
- make harness contract explicit about resume support

### Phase 4: Naming Cleanup

Remove Claude-specific naming from runtime-neutral layers.

Tasks:

- adopt `src/agent-rest-server.ts` as the preferred import path first
- later rename `claude-agent-server.ts` to `agent-rest-server.ts` once compatibility fallout is handled
- rename ambiguous CLI text
- update docs to describe all runtimes equally

### Phase 5: Team Launcher

Add a dedicated mixed-runtime launch command with preflight and smoke tests.

Suggested CLI shape:

```bash
/launch configs/default-mixed.yaml
```

## Testing Plan

Add integration coverage for:

- Claude SDK only team
- Claude Code CLI only team
- Codex only team
- mixed Claude Code + Codex team
- invalid runtime/model combinations
- runtime-specific auth failures

Minimum smoke test per runtime:

1. deploy local agent
2. confirm runtime metadata in manager
3. send `/message`
4. verify reply
5. verify `/.well-known/restap.json`

## First Implementation Slice

The smallest useful refactor is:

1. add runtime registry and profiles
2. route manager deploy defaults through registry
3. route local-agent banner and REST-AP labels through registry
4. route session policy through runtime profile

That would eliminate most of the current duplication without requiring a full rename or command redesign first.

## Success Criteria

The redesign is successful when:

- runtime selection is resolved in one place
- mixed teams can be launched without runtime-specific patching
- invalid configs fail before agents start
- UI text and runtime behavior are always consistent
- adding a new runtime no longer requires editing unrelated manager/server code paths

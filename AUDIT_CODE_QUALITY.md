# Code Quality Audit Report

**Auditor:** agents.agent-16.sep.xid.eth
**Date:** 2026-03-23
**Scope:** All TypeScript source files in `src/`

---

## 1. Dead Code

### 1.1 Unused Imports

| File | Line | Unused Import |
|------|------|---------------|
| `src/claude-agent-server.ts` | 19 | `formatAgentDisplay` (from `./core/agent-identifier.js`) |
| `src/claude-agent-server.ts` | 19 | `normalizeAlias` (from `./core/agent-identifier.js`) |
| `src/agent-manager-db.ts` | 18 | `execSync` (from `child_process`) |
| `src/agent-manager-db.ts` | 25 | `setAgentEndpoints` (from `./onchain/idchain-register.js`) |
| `src/agent-manager-db.ts` | 29 | `getConfigParameters` (from `./config-parser.js`) |
| `src/agent-manager-db.ts` | 29 | `resolveHeartbeatFile` (from `./config-parser.js`) |
| `src/agent-manager-db.ts` | 30 | `formatAgentDisplay` (from `./core/agent-identifier.js`) |
| `src/interactive-agent-cli.ts` | 11 | `execSync` (from `child_process`) |
| `src/interactive-agent-cli.ts` | 15 | `AgentSpec` (type, from `./config-parser.js`) |
| `src/interactive-agent-cli.ts` | 15 | `ValidationError` (type, from `./config-parser.js`) |
| `src/interactive-agent-cli.ts` | 15 | `OnchainConfig` (type, from `./config-parser.js`) |
| `src/core/agent-identifier.ts` | 17 | `formatERC7930Short` (from `./erc7930.js`) |

### 1.2 Unused Variables

| File | Line | Variable | Notes |
|------|------|----------|-------|
| `src/claude-agent-server.ts` | 678 | `allowedFields` | Array defined but never used; the `PATCH /catalog` handler accepts all fields without filtering |

### 1.3 Deprecated/Dead Functions

| File | Line | Function | Notes |
|------|------|----------|-------|
| `src/db.ts` | 400 | `getOrCreateProjectId()` | Marked "deprecated" backward compatibility alias for `getOrCreateTeamId()`, never called anywhere in the codebase |
| `src/claude-agent-server.ts` | 36 | `getRuntimeName()` | Always returns the static string `'Claude Code'` regardless of the `harnessType` parameter; the parameter is never meaningfully used |

### 1.4 Commented-Out Code

| File | Line | Code |
|------|------|------|
| `src/agent-manager-db.ts` | 1644 | `// const teamDir = \`${this.baseWorkDir}/teams/${name}\`;` |

### 1.5 Duplicate Code

| File | Lines | Description |
|------|-------|-------------|
| `src/claude-agent-server.ts` | 386-432 vs 436-503 | Two nearly identical implementations of `addFilesFromDir()` within `GET /files/list` and `GET /files`. Both recursively list files from `/tmp`, working directory, and shared directory with the same deduplication logic. Should be extracted into a shared helper method. |
| `src/agent-manager-db.ts` | 1502-1525 vs 1731-1772 | Duplicate `GET /teams` route registered twice in `setupRoutes()`. The second registration (line 1731) shadows the first (line 1502) with a slightly different response format (adds `portRange`, `registry`, etc.). Only the last-registered Express route handler takes effect. |
| `src/agent-manager-db.ts` | 1528-1560 vs 1775-1804 | Duplicate `POST /teams` route registered twice. The second registration shadows the first. |
| `src/agent-manager-db.ts` | 1655-1696 | `GET /projects` is a near-copy of the second `GET /teams` handler (backward compatibility alias). Could delegate to the same internal function. |
| `src/agent-manager-db.ts` | 1699-1730 | `POST /projects` is a near-copy of the second `POST /teams` handler. |

---

## 2. TODO / FIXME / HACK Comments

No `TODO`, `FIXME`, `HACK`, `XXX`, `TEMP`, or `TEMPORARY` comments were found in any `src/` files. The codebase is clean of these markers.

---

## 3. Inconsistent Error Handling

### 3.1 Mixed Error Handling Patterns

The codebase uses several different error handling approaches depending on the layer:

**Pattern A: Return `OperationResult` objects** (used in `src/core/` services)
```typescript
return { success: false, error: err.message };
```
Files: `agent-service.ts`, `messaging-service.ts`, `team-service.ts`, `file-service.ts`, `registry-service.ts`

**Pattern B: Throw errors** (used in config parsing, DB operations)
```typescript
throw new Error(`Config file not found: ${absolutePath}`);
```
Files: `config-parser.ts`, `db.ts`, `core/agent-identifier.ts`

**Pattern C: `console.error` + return HTTP error** (used in Express handlers)
```typescript
console.error('Error creating team:', error);
res.status(500).json({ error: error.message || 'Failed to create team' });
```
Files: `agent-manager-db.ts`, `claude-agent-server.ts`, `interactive-agent-server.ts`

**Pattern D: `console.warn` + swallow error** (used for non-critical failures)
```typescript
console.warn(`Could not fetch team port range: ${err}`);
```
Files: `local-agent-server.ts`, `claude-agent-server.ts`

**Pattern E: Silent catch** (empty catch blocks or `catch(() => {})`)
```typescript
} catch {
  // best-effort; don't block startup
}
```
Files: `db.ts` (line 107), `local-agent-server.ts` (line 329), `interactive-agent-server.ts` (various `.catch(() => {})`)

### 3.2 Specific Inconsistencies

| File | Line | Issue |
|------|------|-------|
| `src/claude-agent-server.ts` | 328 | `validateClientApiKey()` calls `${managerUrl}/keys/validate` but the manager (`agent-manager-db.ts`) does not expose a `/keys/validate` endpoint. This validation will always fail with a 404, effectively making client API key validation non-functional. |
| `src/local-agent-server.ts` | 329 | Empty `catch {}` block when updating database on shutdown. Agent stop errors are completely swallowed. |
| `src/db.ts` | 107 | Empty `catch {}` during port range migration. If port reassignment fails, existing data may be inconsistent. |

---

## 4. TypeScript `any` Casts

### 4.1 Summary by File

| File | Count | Severity |
|------|-------|----------|
| `src/interactive-agent-cli.ts` | 171 | High - pervasive untyped data |
| `src/agent-manager-db.ts` | 98 | High |
| `src/human-agent-cli.ts` | 30 | Medium |
| `src/claude-agent-server.ts` | 27 | Medium |
| `src/core/agent-service.ts` | 15 | Medium |
| `src/core/registry-service.ts` | 14 | Medium |
| All other files | ~61 | Low-Medium |

**Total: ~426 `any` occurrences across the codebase.**

### 4.2 Most Concerning Patterns

| File | Line(s) | Pattern | Risk |
|------|---------|---------|------|
| `src/interactive-agent-cli.ts` | 433 | `async function managerFetch(pathname: string, init: any = {})` | Function parameter typed as `any` -- all callers lose type safety |
| `src/interactive-agent-cli.ts` | 320 | `function getAgentDisplayName(agent: any): string` | All agent data flows through untyped parameter |
| `src/core/agent-service.ts` | 60, 112, 133, 171, 205, 309 | `const data: any = await response.json()` | API response data is never typed; bugs in response shape will not be caught |
| `src/core/messaging-service.ts` | 44, 87, 163 | `const data: any = await response.json()` | Same pattern in messaging service |
| `src/agent-manager-db.ts` | 129 | `AgentMetadata = Record<string, any>` | All agent metadata is untyped |
| `src/claude-agent-server.ts` | 122-129, 160 | `data?: any`, `result?: any`, `[key: string]: any` | Core data structures use `any` |
| `src/harness/types.ts` | 37 | `[key: string]: any` on `HarnessMessage` | Unified message type is an open record |

---

## 5. Long Functions

Functions exceeding ~150 lines that should be decomposed:

| File | Function | Start Line | Approx Lines | Recommendation |
|------|----------|------------|---------------|----------------|
| `src/interactive-agent-cli.ts` | `handleLine()` | 1334 | ~2056 | Giant command router. Extract each `/command` handler into its own function. |
| `src/agent-manager-db.ts` | `setupRoutes()` | 958 | ~1951 | All Express route definitions in one method. Group routes by domain (agents, teams, registry, etc.) into separate methods. |
| `src/agent-manager-db.ts` | `executeRemoteCommand()` | 2909 | ~1333 | Massive switch-like command dispatcher. Extract each command into its own handler function. |
| `src/claude-agent-server.ts` | `setupRoutes()` | 379 | ~801 | All REST-AP routes in one method. Split into route groups. |
| `src/interactive-agent-cli.ts` | `checkAgentStatus()` | 3589 | ~362 | Status checking with heavy formatting. |
| `src/interactive-agent-cli.ts` | `deployFromConfig()` | 4645 | ~304 | Deploy orchestration logic. |
| `src/interactive-agent-cli.ts` | `managerFetch()` | 433 | ~259 | HTTP client wrapper with reconnection logic. |
| `src/claude-agent-server.ts` | `executeQuery()` | 1377 | ~235 | Query execution with harness interaction. |
| `src/interactive-agent-cli.ts` | `talkToAgentAndWait()` | 5112 | ~151 | Synchronous agent communication. |

---

## 6. References to Removed Features

### 6.1 `/pay` and Wallet System (Removed)

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/agent-manager.ts` | 12, 17-20, 53, 63-64, 84-119, 163-231, 331-338, 405-406, 697-698, 737-738, 765-776, 794-796, 807-809 | Full wallet management system: `AgentWallet` interface, `ensureAgentWallet()`, `loadAgentWalletStore()`, `persistAgentWalletStore()`, `/agents/pay` endpoint, `createWalletClient`, `parseEther` | The entire `agent-manager.ts` file appears to be legacy (superseded by `agent-manager-db.ts`) but is still exported from `src/index.ts`. Contains the full wallet/pay system that was removed. |
| `src/agent-manager-db.ts` | 8-9, 1899, 2241-2245, 2323, 2724-2733 | Comments about wallet management, `INSERT INTO wallets` during agent move, agent_account derivation, agentWallet endpoint parsing during registry pull | Wallet references remain in agent move and registry pull operations. |
| `src/core/registry-service.ts` | 203-247 | `payAgent()` function | Full pay-agent API client function still present. |
| `src/db.ts` | 141-164, 237-250 | `wallets` table migration and creation | Table kept for backward compatibility (intentional), but the column migration code is still active. |

### 6.2 `/keys` and `api_keys` (Removed from Manager)

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/db.ts` | 325-347 | `api_keys` table creation and index | Table still created during migration but no code uses it. |
| `src/claude-agent-server.ts` | 277-283, 318-351 | `validateClientApiKey()` calls `${managerUrl}/keys/validate` | Worker agent attempts to validate `sk-id-*` keys against a manager endpoint that no longer exists. Will always return false. |

### 6.3 `/task` and `/phase` Commands

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/inter-agent-skill.ts` | 302-391 | `TASK_MANAGEMENT_SKILL` constant | Full task management API documentation still provided to agents as a skill. |
| `src/inter-agent-skill.ts` | 505 | Task skill injected via `withInterAgentSkill()` | Task skill is always included in agent prompts. |
| `src/agent-manager-db.ts` | 3697-3825+ | `/tasks` and `/task` remote command handlers | Full task management still implemented in manager's `executeRemoteCommand()`. |
| `src/db.ts` | 349-376 | `tasks` table creation and indexes | Table still created during migration. |

### 6.4 `/chat` Command

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 2259-2270 | `/chat` command handler | Full `/chat` command still implemented with help text and routing. |
| `src/human-agent-cli.ts` | 120, 181, 195-210 | `/chat` in help menu and command handler | Same `/chat` feature present in alternative CLI. |

### 6.5 `/watch` Command

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 3210-3323 | `/watch` command handler and WebSocket watcher | Full `/watch` feature still implemented. |
| `src/claude-agent-server.ts` | 1449, 1462, 1474, 1614, 1668 | Comments referencing `/watch` subscribers | Comments reference broadcasting to `/watch` subscribers. |

### 6.6 `/fetch`, `/upload`, `/share` Commands

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 3088-3110, 3323-3370, 5747-5840, 6114-6200 | `/fetch`, `/share`, `/upload` command handlers | All three file operation commands still fully implemented. |
| `src/human-agent-cli.ts` | 126-127, 187-188, 328-376, 710, 784 | `/fetch` and `/upload` in help and handlers | Same commands in alternative CLI. |
| `src/inter-agent-skill.ts` | 147 | Reference to `/share` command | Mentions `/share` in shared files documentation provided to agents. |

### 6.7 `/run`, `/runs`, `/programs` Commands

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 2303-2463, 5291-5744 | `/run`, `/runs`, `/programs` command handlers | Full script execution system still implemented (~500 lines). |

### 6.8 `/configs` Command

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 2464-2593, 4299, 4319 | `/configs` command handler and references | Lists available deployment configs with badges. |

### 6.9 `/model` Command

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/interactive-agent-cli.ts` | 2595-2675, 4590-4643 | `/model` command handler and `changeAgentModel()` | Model change feature still implemented. |
| `src/agent-manager-db.ts` | 2168-2203, 3663-3695 | `POST /agents/:id/model` endpoint and `/model` remote command | Manager-side model change still present. |

### 6.10 `/virtual` Agent Type

| File | Line(s) | Reference | Notes |
|------|---------|-----------|-------|
| `src/agent-manager-db.ts` | 119 | `type AgentType = 'claude' | 'virtual' | 'interactive' | 'automator'` | `virtual` type still in the type union. |
| `src/core/types.ts` | 47 | `export type AgentType = 'claude' | 'virtual' | 'interactive'` | `virtual` type still in the core type definition. |

### 6.11 `agent-manager.ts` (Legacy File)

| File | Notes |
|------|-------|
| `src/agent-manager.ts` | 816-line legacy manager file superseded by `agent-manager-db.ts`. Still exported from `src/index.ts` as `AgentManager`. Contains the full wallet system, `/agents/pay` endpoint, and in-memory agent storage. Not referenced by any runtime code except `index.ts` exports. |

### 6.12 License Inconsistency

| File | Line | Issue |
|------|------|-------|
| `src/index.ts` | 9 | ~~`@license MIT` in JSDoc comment, but the SPDX header on line 1 says `GPL-3.0-only`.~~ Resolved: project switched to MIT license. All files now use `MIT`. |

---

## Summary

### Critical Issues
1. **Broken key validation** -- `claude-agent-server.ts` calls a `/keys/validate` endpoint on the manager that does not exist, making client API key validation silently fail.
2. **Duplicate route registration** -- `GET /teams` and `POST /teams` are registered twice in `agent-manager-db.ts`, with the second silently overriding the first.

### High-Impact Issues
3. **426 `any` casts** across the codebase, with 269 concentrated in the two largest files (`interactive-agent-cli.ts` and `agent-manager-db.ts`). Core data structures like `NewsItem.data`, `ActiveQuery.result`, and `AgentMetadata` all use `any`.
4. **3 functions exceed 1000 lines** (`handleLine` ~2056, `setupRoutes` in manager ~1951, `executeRemoteCommand` ~1333). These are very difficult to maintain and test.
5. **12 unused imports** across 4 files.

### Medium-Impact Issues
6. **Extensive dead feature code** -- Commands `/chat`, `/watch`, `/fetch`, `/upload`, `/share`, `/run`, `/runs`, `/programs`, `/configs`, `/model`, `/task`, `/phase` are all still fully implemented (~2000+ lines combined) despite being listed as removed in the commit history.
7. **Legacy `agent-manager.ts`** (816 lines) still exported from index but superseded by `agent-manager-db.ts`.
8. **`payAgent()` function** still present in `src/core/registry-service.ts`.
9. **`api_keys` and `tasks` tables** still created during DB migration with no code using them.
10. **`wallets` table** migration code still runs for a deprecated table.
11. **Duplicate file listing code** in `claude-agent-server.ts` (`addFilesFromDir` implemented twice).

### Low-Impact Issues
12. **`getRuntimeName()`** always returns `'Claude Code'`, ignoring its parameter.
13. **`allowedFields`** defined but never used in catalog update handler.
14. **`getOrCreateProjectId()`** deprecated alias function never called.
15. ~~**License mismatch** in `index.ts`~~ (resolved: project switched to MIT license).
16. **Inconsistent error handling** -- mix of OperationResult returns, thrown errors, console.warn+swallow, and empty catch blocks across different layers.

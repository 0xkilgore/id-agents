# Security Audit: ID Agents (2026-03-27)

**Audited by:** agents.agent-16.sep.xid.eth
**Scope:** Full codebase — input validation, injection, secrets, path traversal, deploy-upsert, changes since last review
**Method:** Parallel sub-agent audits (4 agents) with manual consolidation
**Architecture note:** API key auth intentionally removed (trusted local setup). All servers bind to `127.0.0.1`.

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **HIGH** | 7 |
| **MEDIUM** | 11 |
| **LOW** | 8 |

The top systemic issues are:

1. **Path traversal via team names** — The `X-Id-Team` header flows unsanitized into filesystem paths, enabling arbitrary directory creation and file writes by any local process.
2. **Full `process.env` propagated to agent subprocesses** — Every spawned agent inherits all manager secrets (`PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`).
3. **Deploy-upsert cascading hard delete** — Redeploy destroys all agent history (news, queries, wallets) with no transaction safety and no process cleanup.

Previous audit findings that were **resolved**: All `ID_CONTROL_API_KEY`, `ID_AGENT_API_KEY`, `X-Api-Key` references removed. Auth middleware no-op removed. `safeCompare` imports cleaned from target files.

Previous findings **still open**: env propagation, path traversal, deploy-upsert, manager identity spoofing, plaintext wallet keys, metadata exposure, symlink following.

---

## Table of Contents

1. [Path Traversal & Filesystem](#1-path-traversal--filesystem)
2. [Secrets & Key Material](#2-secrets--key-material)
3. [Deploy-Upsert & Race Conditions](#3-deploy-upsert--race-conditions)
4. [Manager Identity Spoofing](#4-manager-identity-spoofing)
5. [Input Validation & Injection](#5-input-validation--injection)
6. [Information Disclosure](#6-information-disclosure)
7. [Positive Findings](#7-positive-findings)
8. [Remediation Priority](#8-remediation-priority)

---

## 1. Path Traversal & Filesystem

### HIGH-1: Team name path traversal — arbitrary directory creation and file writes

**File:** `src/agent-manager-db.ts:346-372`

```typescript
private async getTeam(req: express.Request): Promise<{ name: string; id: string }> {
    const name = this.getTeamName(req);  // raw X-Id-Team header, no validation
    const teamDir = `${this.baseWorkDir}/teams/${name}`;
    if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
```

A request with `X-Id-Team: ../../etc/cron.d` creates directories outside the workspace. The same unsanitized name flows into archive paths (line 1167), deploy paths (line 2931), and shared directory creation (line 1336).

**Recommendation:** Validate team names in `getTeamName()`: `if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Invalid team name');`

### HIGH-2: Working directory injection via POST body

**File:** `src/agent-manager-db.ts:1498, 1515`

```typescript
const workingDirectory = configWorkDir || `${this.baseWorkDir}/agents/${id}`;
mkdirSync(workingDirectory, { recursive: true });
```

The `/agents/spawn` endpoint accepts any absolute path as `workingDirectory`. The server creates directories, writes `CLAUDE.md`, copies plugins, and spawns agents there.

**Recommendation:** Validate that resolved path starts with `this.baseWorkDir`.

### MEDIUM-1: Skill name path traversal in `deploySkillsToAgent`

**File:** `src/agent-manager-db.ts:4050, 4067`

```typescript
const skillFile = path.join(skillsSource, skillName, 'SKILL.md');
const targetSkillDir = path.join(workDir, '.claude', 'skills', skillName);
```

Skill names from YAML configs or API body are used directly in `path.join()`. A name like `../../foo` escapes the target directory. Unlike agent names, **skill names have no validation anywhere**.

**Recommendation:** Add `if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) continue;`

### MEDIUM-2: Plugin name path traversal in `copyPluginToAgent`

**File:** `src/agent-manager-db.ts:278`

Same pattern as skills — `plugin.name` used in `path.join()` without validation.

**Recommendation:** Validate in `validateConfig()` with the same regex as agent names.

### MEDIUM-3: Agent name validation only in CLI, not server API

**File:** `src/agent-manager-db.ts:1483` vs `src/interactive-agent-cli.ts:256`

`VALID_AGENT_NAME_REGEX` (`/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/`) is enforced only in the CLI. The `/agents/spawn` endpoint checks only truthiness. Agent names flow into log file paths and OWS wallet names.

**Recommendation:** Extract validation to a shared module and enforce in the API endpoint.

### MEDIUM-4: Symlink following in `copyDirRecursive`

**File:** `src/agent-manager-db.ts:327`

```typescript
const stat = statSync(srcPath);  // follows symlinks
```

A symlink in a plugin source directory pointing to `/etc/` or `~/.ssh/` would be followed and copied into the agent workspace.

**Recommendation:** Use `lstatSync` and skip symlinks.

### LOW-1: `claudeMdFile` can read files outside config directory

**File:** `src/config-parser.ts:432`

`path.resolve(basePath, spec.claudeMdFile)` with a value like `../../../../etc/passwd` reads arbitrary files. Low risk since config files are authored by the operator.

**Recommendation:** Validate resolved path stays within config directory, or document configs as trusted input.

### LOW-2 (positive): `rmSync` properly guarded

**File:** `src/agent-manager-db.ts:1901`

The `rmSync` calls check `agent.working_directory === expectedDir` before deleting. No issue.

### LOW-3 (positive): File upload/download properly sanitized

**File:** `src/claude-agent-server.ts:404`

Uses `path.basename(filename)` and `express.static()` root containment. No traversal risk.

---

## 2. Secrets & Key Material

### HIGH-3: Full `process.env` propagated to all child processes

**Files:**
- `src/agent-manager-db.ts:4115` — `...process.env as Record<string, string>`
- `src/interactive-agent-cli.ts:984`
- `src/harness/claude-code-cli.ts:66`
- `src/harness/claude-agent-sdk.ts:125`
- `src/onchain/idchain-register.ts:19`

Every spawned agent inherits `PRIVATE_KEY`, `ID_REGISTRAR_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, and all other secrets. Agents run LLM-generated code that can execute `printenv`.

Note: `src/claude-agent.ts:83-99` correctly uses an explicit allowlist — this is the pattern to follow.

**Recommendation:** Build a minimal allowlist: `PATH`, `HOME`, `ID_TEAM`, `MANAGER_URL`, `CLAUDE_MODEL`, `ID_AGENT_TOKEN_ID`, `OWS_WALLET`. Only pass `ANTHROPIC_API_KEY` to agents that need it for SDK mode.

### HIGH-4: Wallet private keys stored in plaintext in database

**Files:** `src/db/migrations/sqlite.ts:37-45`, `src/db/migrations/postgres.ts:228-237`

The `wallets` table has `private_key TEXT NOT NULL`. Postgres migration comments it as "DEPRECATED" but both backends still create the table. The SQLite file at `~/.id-agents/id-agents.db` has no restrictive permissions.

**Recommendation:** Stop creating the table on new installs, or drop the `private_key` column. If data exists, encrypt or redact.

### MEDIUM-5: SQLite database directory created without restrictive permissions

**File:** `src/db/index.ts:23`

```typescript
mkdirSync(dataDir, { recursive: true });  // default umask, world-readable
```

Contrast with `interactive-agent-cli.ts:344` which correctly uses `mode: 0o700`.

**Recommendation:** `mkdirSync(dataDir, { recursive: true, mode: 0o700 });`

### MEDIUM-6: Vestigial `api_key` column — plaintext, unused

**Files:** `src/db/migrations/sqlite.ts:33`, `src/db/types.ts:30`, `src/agent-manager-db.ts:1568`

Always set to `null` during creation. Stored in plaintext with no hashing. The REST-AP catalog in `interactive-agent-server.ts:163` still advertises `auth: 'api_key'`.

**Recommendation:** Remove the column via migration, or hash if planning to reuse. Remove stale `auth: 'api_key'` from catalog.

### LOW-4: Stale auth reference in REST-AP catalog

**File:** `src/interactive-agent-server.ts:162-163`

The catalog describes `/remote` as requiring API key authentication (`auth: 'api_key'`). Auth has been removed.

**Recommendation:** Update catalog description to reflect current state.

### LOW-5: Registrar private key passed via env to id-cli

**File:** `src/onchain/idchain-register.ts:18-26`

`buildIdCliEnv()` spreads full `process.env` plus `PRIVATE_KEY`. The id-cli is trusted, but the full env propagation violates least privilege.

**Recommendation:** Pass only `PATH`, `HOME`, and the key/wallet variable.

---

## 3. Deploy-Upsert & Race Conditions

### HIGH-5: Cascading hard delete destroys all agent history on redeploy

**File:** `src/agent-manager-db.ts:3059-3063`

```typescript
const existing = await this.db.agents.getByName(effectiveTeamId, agentName);
if (existing) {
  await this.db.agents.deleteAgent(effectiveTeamId, existing.id);
}
```

`deleteAgent` performs `DELETE FROM agents`. Child tables (`news_items`, `queries`, `wallets`) have `ON DELETE CASCADE`. Every redeploy permanently destroys the agent's message history, query records, and wallet links.

The CLI `/delete` command (line 2704) correctly uses soft delete (`UPDATE SET deleted_at`). The deploy path is inconsistent and more destructive.

**Recommendation:** Use soft delete or reuse the existing agent ID with `upsert()`.

### HIGH-6: No transaction wrapping — crash between delete and create loses agent

**File:** `src/agent-manager-db.ts:3059-3082`, `src/db/db-adapter.ts`

The `DbAdapter` interface has no transaction support (`beginTransaction`, `commit`, `rollback`). If the process crashes after DELETE but before CREATE, the agent is permanently gone.

**Recommendation:** Add transaction support. For SQLite use `better-sqlite3`'s `.transaction()`. For PostgreSQL wrap in `BEGIN`/`COMMIT`.

### HIGH-7: Orphaned agent process on redeploy

**File:** `src/agent-manager-db.ts:3059-3102`

The old agent's database row is deleted without stopping its process. A new port is allocated and a new process spawned. The old process becomes an orphan consuming resources on its old port.

Contrast: `/delete` (line 2688), `/agent stop` (line 3218), and `DELETE /agents/:id` (line 1881) all properly stop the process first.

**Recommendation:** Before database delete, call `killAgentProcess(existing.port)` and `stopHeartbeatForAgent(existing.id)`.

### MEDIUM-7: Port allocation TOCTOU race

**File:** `src/db/repos/sqlite/agents-repo.ts:181-188`, `src/db/repos/postgres/agents-repo.ts:152-159`

`nextPort()` reads `MAX(port)` and returns `max+1`, but the port isn't reserved until the agent row is inserted later. Two concurrent `/agents/spawn` requests can allocate the same port.

**Recommendation:** Add `UNIQUE` constraint on port (where port > 0) and retry on conflict, or use a port sequence.

### MEDIUM-8: SQLite read-merge-write race in teams config

**File:** `src/db/repos/sqlite/teams-repo.ts:64-82`

`setRegistrarAddress` and `setDefaultRegistry` perform read-modify-write without transactions. Concurrent updates lose data. The Postgres backend correctly uses atomic `jsonb_set`.

**Recommendation:** Wrap in SQLite transaction or use `json_set()`.

### MEDIUM-9: Inconsistent deletion semantics across 4 code paths

**File:** `src/agent-manager-db.ts` (multiple locations)

| Path | Stops process | Cancels queries | Stops heartbeat | DB action |
|------|:---:|:---:|:---:|-----------|
| CLI `/delete` (line 2662) | Yes | Yes | Yes | Soft delete |
| HTTP `DELETE /agents/:id` (line 1881) | Yes | No | No | Hard delete |
| HTTP `DELETE /agents/by-name/:name` (line 1915) | Yes | No | No | Hard delete |
| Deploy redeploy (line 3059) | **No** | **No** | **No** | Hard delete |

**Recommendation:** Centralize into a single `removeAgent(teamId, agentId, options)` method.

### LOW-6: PostgreSQL `updateIdentity` overwrites all fields unconditionally

**File:** `src/db/repos/postgres/agents-repo.ts:279-302`

Always updates ALL five columns even if only one was provided. Partial updates null out unspecified fields. The SQLite version correctly builds a dynamic SET clause.

**Recommendation:** Port the SQLite dynamic-SET approach to PostgreSQL.

---

## 4. Manager Identity Spoofing

### MEDIUM-10: Manager identity spoofing via unvalidated `from` field

**File:** `src/claude-agent-server.ts:1266`

```typescript
const isManager = from === 'manager' || from === 'remote';
```

The `from` field comes directly from the HTTP request body (line 613). Any local process can POST `{"from": "manager", "message": "..."}` to any agent's `/talk` endpoint, causing the LLM to receive `"[Message from the manager (your owner/operator)]"`.

The manager at line 738 sets `from || 'manager'` as the default, with no cryptographic signature or header to distinguish real manager messages from spoofed ones.

**Mitigating factor:** With 127.0.0.1 binding, only local processes can reach agents. But a compromised agent can impersonate the manager to other agents.

**Recommendation:** Add a shared secret or HMAC signature that only the manager process can produce. Or derive `from` from a trusted source rather than the request body.

---

## 5. Input Validation & Injection

### MEDIUM-11: Prototype pollution via PATCH /catalog

**File:** `src/claude-agent-server.ts:563-573`

```typescript
for (const [key, value] of Object.entries(updates)) {
    this.catalog[key] = value;
}
```

Any key-value pair accepted without validation. Keys like `__proto__` or `constructor` could cause prototype pollution.

**Recommendation:** Filter with an explicit key allowlist. Use `Object.create(null)` for the catalog object.

### LOW-7: Missing type checks on message fields

**Files:** `src/agent-manager-db.ts:949`, `src/claude-agent-server.ts:615`

The `message` field is checked for truthiness but not type. Non-string values (numbers, objects) pass validation and could cause downstream errors.

**Recommendation:** Add `typeof message !== 'string'` checks.

### LOW-8: RegExp replacement `$`-pattern injection in template substitution

**File:** `src/agent-manager-db.ts:4063`

```typescript
content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
```

The replacement `value` can contain `$'`, `$&`, `$1` etc., which JavaScript's `String.replace()` interprets specially. Currently safe because keys are hardcoded, but the values (agent display name, team name) could contain `$`.

**Recommendation:** Escape `$` in replacement values or use `split().join()`.

---

## 6. Information Disclosure

### MEDIUM-12 (renumbered): Full metadata exposed in API responses

**File:** `src/agent-manager-db.ts:392-412`

```typescript
return { ...metadata: a.metadata, workingDirectory: a.working_directory, ... };
```

Metadata includes `plugins` (filesystem paths), `agent_account` (ETH address), `ows_wallet`, `host_pid`, `runtime`, `internal_url`. Working directory exposes absolute paths.

**Recommendation:** Strip sensitive fields before returning. Create a `sanitizeMetadata()` helper.

### LOW-9: Error messages expose internal details

**File:** `src/agent-manager-db.ts:2363-2364, 978-979`

Error handlers return `error.message` directly, which can contain file paths or connection strings.

**Recommendation:** Log full errors server-side, return generic messages to clients.

---

## 7. Positive Findings

- **No SQL injection.** All queries across all 17 database files use parameterized queries consistently.
- **No command injection.** All `child_process` calls use `execFileSync`/`execFile` (not `exec`), avoiding shell interpretation. Arguments passed as arrays.
- **Safe YAML parsing.** `js-yaml` v4 defaults to safe `CORE_SCHEMA` — no arbitrary code execution.
- **Safe JSON parsing.** `db-json.ts` wraps all `JSON.parse` in try/catch with type validation and safe defaults.
- **Agent ID validation.** `/agents/register` validates ID format: `/^[a-zA-Z0-9_:-]{1,200}$/`.
- **File upload sanitized.** Uses `path.basename()` and `express.static()` root containment.
- **`rmSync` properly guarded.** Checks exact path match before recursive delete.
- **Timing-safe comparison.** `safe-compare.ts` implements proper `crypto.timingSafeEqual` (ready for future use).
- **Servers bind to 127.0.0.1.** Limits all network exposure to local processes only.
- **Admin key file permissions.** `~/.id-agents/admin.key` written with `mode: 0o600`.
- **Auth removal was clean.** No stale `ID_CONTROL_API_KEY`, `ID_AGENT_API_KEY`, `X-Api-Key`, `safeCompare` references remain in the 6 target source files.

---

## 8. Remediation Priority

### Immediate — prevents filesystem and data compromise

| # | Finding | Impact |
|---|---------|--------|
| HIGH-1 | Validate team names in `getTeamName()` | Blocks all team-name path traversal (also fixes archive writes) |
| HIGH-2 | Validate `workingDirectory` against `baseWorkDir` | Blocks arbitrary directory/file writes via API |
| HIGH-3 | Allowlist env vars for child processes | Contains blast radius of compromised agents |

### Short-term — prevents data loss and process leaks

| # | Finding | Impact |
|---|---------|--------|
| HIGH-5 | Replace hard delete with soft delete/upsert in deploy | Prevents history loss on redeploy |
| HIGH-6 | Add transaction support to DbAdapter | Prevents data loss on crash |
| HIGH-7 | Stop old agent process before deploy delete | Prevents orphan process leak |
| MEDIUM-1,2,3 | Validate skill/plugin/agent names server-side | Blocks remaining path traversal vectors |

### Medium-term — defense in depth

| # | Finding | Impact |
|---|---------|--------|
| HIGH-4 | Encrypt or remove plaintext wallet keys | Reduces exposure from DB access |
| MEDIUM-5 | Restrictive SQLite directory permissions | Limits access on shared systems |
| MEDIUM-10 | Add manager message signing | Prevents inter-agent impersonation |
| MEDIUM-11 | Filter PATCH /catalog keys | Prevents prototype pollution |
| MEDIUM-12 | Sanitize metadata in API responses | Reduces information disclosure |

---

## Changes Since Previous Audit (2025-03-27)

| Previous Finding | Status |
|-----------------|--------|
| Auth disabled on manager (prev HIGH-1) | **By design** — auth intentionally removed, servers now bind 127.0.0.1 |
| WebSocket auth bypass (prev HIGH-2) | **By design** — auth code removed |
| Manager identity spoofing (prev HIGH-3,4,5) | **Reduced to MEDIUM** — 127.0.0.1 binding limits to local processes only |
| Full env propagation (prev HIGH-9) | **Still open** — HIGH-3 in this report |
| Plaintext wallet keys (prev HIGH-10) | **Still open** — HIGH-4 in this report |
| Deploy-upsert cascading delete (prev HIGH-11) | **Still open** — HIGH-5 in this report |
| Path traversal via skills/plugins (prev HIGH-6,7,8) | **Still open** — MEDIUM-1,2 in this report |
| Metadata exposure (prev MEDIUM-2) | **Still open** — MEDIUM-12 in this report |
| ID_CONTROL_API_KEY overwrites ID_AGENT_API_KEY | **Resolved** — both env vars removed from code |
| All X-Api-Key header sending/checking | **Resolved** — removed from all 6 target files + skill files |
| `requireAuth` field and `ID_REQUIRE_CLIENT_AUTH` | **Resolved** — removed from config parser, agent metadata, and worker auth |
| Stale `auth: 'api_key'` in REST-AP catalog | **NEW** — found in `interactive-agent-server.ts:163` |

---

*Generated by parallel sub-agent audit (4 specialized agents). Findings deduplicated across audit domains.*

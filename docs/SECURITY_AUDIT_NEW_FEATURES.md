# Security Audit: New Features (2025-03-27)

**Audited by:** agents.agent-16.sep.xid.eth
**Scope:** SQLite database layer, OWS signer, skill deployment, manager identity, deploy-upsert fix
**Method:** Parallel sub-agent audits with manual consolidation

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **HIGH** | 11 |
| **MEDIUM** | 14 |
| **LOW** | 10 |

The most critical systemic issue is **disabled authentication on the manager** (`agent-manager-db.ts:188-189`), which amplifies nearly every other finding. The second systemic issue is **manager identity spoofing** -- the `from` field in request bodies is trusted without verification, allowing any network client to impersonate the manager or any agent. The third is the **deploy-upsert pattern** which performs a cascading hard delete without transactions, destroying agent history on every redeploy.

---

## Table of Contents

1. [Authentication & Authorization](#1-authentication--authorization)
2. [Manager Identity Spoofing](#2-manager-identity-spoofing)
3. [Path Traversal & Filesystem](#3-path-traversal--filesystem)
4. [Secrets & Key Material](#4-secrets--key-material)
5. [Deploy-Upsert Race Conditions](#5-deploy-upsert-race-conditions)
6. [SQLite Database Layer](#6-sqlite-database-layer)
7. [Input Validation](#7-input-validation)
8. [Information Disclosure](#8-information-disclosure)
9. [Positive Findings](#9-positive-findings)
10. [Remediation Priority](#10-remediation-priority)

---

## 1. Authentication & Authorization

### HIGH-1: Manager API authentication is disabled -- all endpoints publicly accessible

**File:** `src/agent-manager-db.ts:188-189`

```typescript
// Auth removed -- local-only system, no API keys needed
this.managementApp.use((_req, _res, next) => next());
```

The `/remote` endpoint executes arbitrary CLI commands. `/agents/spawn` creates agent processes. `DELETE /agents/:id` deletes agents. All are unauthenticated. When deployed behind Caddy on the Hetzner VPS (`idbot.live`), this exposes full administrative control to the internet.

**Recommendation:** Reinstate API key middleware checking `ID_CONTROL_API_KEY` on administrative endpoints. The WebSocket handler at line 3780 already implements auth -- apply the same pattern.

### HIGH-2: WebSocket auth bypass when ID_CONTROL_API_KEY is unset

**File:** `src/agent-manager-db.ts:3780-3787`

```typescript
if (controlApiKey && !safeCompare(apiKey, controlApiKey) && !safeCompare(apiKey, agentApiKey)) {
```

The `controlApiKey &&` guard means if `ID_CONTROL_API_KEY` is not set, the entire auth block is skipped. Any WebSocket client can execute CLI commands via `type: 'command'` messages.

**Recommendation:** Always require authentication for WebSocket connections regardless of env var presence.

### MEDIUM-1: PATCH /identity endpoint allows unauthenticated identity modification

**File:** `src/claude-agent-server.ts:1051-1096`

When `ID_REQUIRE_CLIENT_AUTH` is not `true` (the default), the `/identity` endpoint allows unauthenticated updates to `tokenId`, `domain`, and metadata -- effectively reassigning an agent's onchain identity.

**Recommendation:** Always require authentication for `/identity` regardless of the `ID_REQUIRE_CLIENT_AUTH` setting.

---

## 2. Manager Identity Spoofing

### HIGH-3: Manager identity spoofing via `from` field in /talk

**File:** `src/claude-agent-server.ts:656-680, 1329-1339`

```typescript
const { message, session_id, from } = req.body;
// ...
const isManager = from === 'manager' || from === 'remote';
```

Any HTTP client can POST `{"from": "manager", "message": "..."}` to any agent's `/talk` endpoint. The agent's LLM receives: `"[Message from the manager (your owner/operator)]"` with `"Respond directly and helpfully"`. No verification of the `from` field occurs.

**Recommendation:** Do not trust `from` from the request body. Require a separate manager-only secret to claim manager identity, or derive `from` from the authenticated API key.

### HIGH-4: Manager's /message endpoint passes through arbitrary `from`

**File:** `src/agent-manager-db.ts:730, 756`

```typescript
const result = await this.forwardToAgent(targetUrl, message, from || 'manager', session_id);
```

Combined with disabled auth (HIGH-1), any network client can send `POST /message` with `{"to": "any-agent", "from": "manager"}` and the target agent treats it as a manager message.

**Recommendation:** The manager should override `from` based on authenticated identity, not accept it from the request body.

### HIGH-5: Proxy route forwards `from` field verbatim with internal API key

**File:** `src/agent-manager-db.ts:2430-2480`

The `/:tokenId/*` proxy route forwards the entire request body to agents, including any `from` field, while also injecting the internal API key (`X-Api-Key`). An external unauthenticated user at `https://idbot.live/23/talk` can claim manager identity with the proxy's own auth credentials.

**Recommendation:** Strip `from` from forwarded requests or set it to `"external"`.

### MEDIUM-2: POST /news allows identity spoofing with LLM triggering

**File:** `src/claude-agent-server.ts:799-853`

The `/news` endpoint accepts `from` and `trigger: true`, invoking LLM execution with the spoofed identity.

**Recommendation:** Verify `from` against authenticated identity.

### MEDIUM-3: Agent-to-agent communication uses shared API key

**File:** `src/agent-manager-db.ts:4168`

All agents share the same `ID_AGENT_API_KEY` (derived from `ID_CONTROL_API_KEY`). Even with key verification, there is no way to distinguish which agent made a request.

**Recommendation:** Issue per-agent API keys. The `api_key` column already exists in the agents table.

---

## 3. Path Traversal & Filesystem

### HIGH-6: Path traversal via unvalidated skill names

**File:** `src/agent-manager-db.ts:4097-4117`

```typescript
const skillFile = path.join(skillsSource, skillName, 'SKILL.md');
const targetSkillDir = path.join(workDir, '.claude', 'skills', skillName);
```

A skill name like `../../etc` resolves outside the target directory. Skill names flow from YAML configs and the `/agents/spawn` POST body. **No validation exists for skill names** (unlike agent names which have `/^[a-zA-Z0-9_-]+$/`).

**Recommendation:** Add `if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) continue;`

### HIGH-7: Path traversal via unvalidated plugin names

**File:** `src/agent-manager-db.ts:286-322`

```typescript
const targetDir = path.join(pluginsDir, plugin.name);
```

Same pattern as skills -- `plugin.name` from configs or API body is used in path construction without validation.

**Recommendation:** Validate plugin names in `validateConfig()` with the same regex as agent names.

### HIGH-8: Arbitrary working directory via POST body

**File:** `src/agent-manager-db.ts:1506, 1522`

```typescript
const workingDirectory = configWorkDir || `${this.baseWorkDir}/agents/${id}`;
mkdirSync(workingDirectory, { recursive: true });
```

The `/agents/spawn` endpoint accepts `workingDirectory` from the request body. An attacker can set it to any path, and the code will create directories, write `CLAUDE.md`, copy plugins, and deploy skills there.

**Recommendation:** Validate that `workingDirectory` resolves within `this.baseWorkDir`.

### MEDIUM-4: Path traversal via team name in directory creation

**File:** `src/agent-manager-db.ts:356-382`

Team names from `X-Id-Team` header or `team` query param are used directly in `path.join(baseWorkDir, 'teams', name)` with no sanitization.

**Recommendation:** Validate team names: `/^[a-zA-Z0-9_-]+$/`

### MEDIUM-5: `claudeMdFile` allows reading arbitrary files

**File:** `src/config-parser.ts:430-449`

```typescript
const filePath = path.resolve(basePath, spec.claudeMdFile);
```

A config with `claudeMdFile: "../../../../etc/passwd"` reads arbitrary files into the agent's system prompt.

**Recommendation:** Validate resolved path stays within config directory or workspace.

### MEDIUM-6: Symlink following in `copyDirRecursive`

**File:** `src/agent-manager-db.ts:327-343`

Uses `statSync` which follows symlinks. A symlink in a plugin source directory pointing to `/etc/passwd` or `~/.ssh/id_rsa` would be copied into the agent workspace.

**Recommendation:** Use `lstatSync` and skip symlinks.

---

## 4. Secrets & Key Material

### HIGH-9: Full process.env propagated to all child processes

**File:** `src/agent-manager-db.ts:4163-4172`

```typescript
const localEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    // ...
};
```

Every spawned agent receives `ID_REGISTRAR_PRIVATE_KEY`, `PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `ID_CONTROL_API_KEY`, `DATABASE_URL`, and all other secrets. A compromised agent with Bash access can read `process.env`.

Same pattern in:
- `src/onchain/idchain-register.ts:19` (`buildIdCliEnv`)
- `src/harness/claude-code-cli.ts:66`
- `src/interactive-agent-cli.ts:993-1003`

**Recommendation:** Build an explicit allowlist: `ID_TEAM`, `MANAGER_URL`, `ID_AGENT_API_KEY`, `CLAUDE_MODEL`, `ID_AGENT_TOKEN_ID`, `OWS_WALLET`, `PATH`, `HOME`.

### HIGH-10: Wallet private keys stored in plaintext in database

**File:** `src/db/migrations/sqlite.ts:37-45`, `src/db/migrations/postgres.ts:228-237`

The `wallets` table stores raw private keys as `TEXT NOT NULL`. The Postgres migration comments it as "DEPRECATED" but both migrations still create the table.

**Recommendation:** Remove the table from new installs or encrypt at rest. If deprecated, stop creating it.

### MEDIUM-7: ID_CONTROL_API_KEY overwrites ID_AGENT_API_KEY in child env

**File:** `src/agent-manager-db.ts:4168`

```typescript
...(process.env.ID_AGENT_API_KEY && { ID_AGENT_API_KEY: process.env.ID_AGENT_API_KEY }),
...(process.env.ID_CONTROL_API_KEY && { ID_AGENT_API_KEY: process.env.ID_CONTROL_API_KEY }),
```

If both are set, the admin control key silently overwrites the agent key. Every agent process receives admin privileges.

**Recommendation:** Only fall back to `ID_CONTROL_API_KEY` if `ID_AGENT_API_KEY` is unset. Never pass the control key to agents.

### MEDIUM-8: Registrar private key passed via env var to id-cli

**File:** `src/onchain/idchain-register.ts:18-26`

When OWS is not configured, the raw `PRIVATE_KEY` is passed as an environment variable to `id-cli`. Env vars are readable via `/proc/<pid>/environ` on Linux.

**Recommendation:** Use OWS exclusively in production. If raw key path is needed, pass via stdin or temp file.

### MEDIUM-9: Agent API keys stored in plaintext in database

**File:** `src/db/migrations/sqlite.ts:33`, `src/db/repos/sqlite/agents-repo.ts:257,275`

The `api_key` column stores keys as plaintext. While `agentToResponse()` correctly omits it from API responses, the raw value is available throughout the codebase.

**Recommendation:** Store hashed keys and compare hashes during authentication.

### LOW-1: SQLite database file created without restrictive permissions

**File:** `src/db/index.ts:22-25`

`mkdirSync` uses default umask (0o755 for dirs). The database file is created world-readable (0o644) by `better-sqlite3`.

**Recommendation:** Set directory to `0o700` and file to `0o600`.

### LOW-2: scripts/register-team.ts writes private keys to JSON file

**File:** `scripts/register-team.ts:53, 70`

Generated private keys are written in plaintext to `.claude/team-registry/web-dev-team.json`.

**Recommendation:** Add to `.gitignore`. Consider encrypting or storing only addresses.

### LOW-3: Error messages may leak wallet configuration details

**File:** `src/agent-manager-db.ts:467, 469`

Error messages include OWS wallet names and internal details, potentially returned to API callers.

**Recommendation:** Return generic errors to callers; log details server-side only.

---

## 5. Deploy-Upsert Race Conditions

### HIGH-11: Cascading hard delete destroys all agent history on redeploy

**File:** `src/agent-manager-db.ts:3096-3100`

```typescript
const existing = await this.db.agents.getByName(effectiveTeamId, agentName);
if (existing) {
  await this.db.agents.deleteAgent(effectiveTeamId, existing.id);
}
```

`deleteAgent` performs `DELETE FROM agents`. All child tables (`wallets`, `news_items`, `queries`) have `ON DELETE CASCADE`. Every redeploy permanently destroys the agent's entire conversation history, query results, and wallet associations.

Compare: the `/delete` CLI command uses soft delete (`UPDATE SET deleted_at`), making the deploy path more destructive than explicit deletion.

**Recommendation:** Use soft delete, or reuse the existing agent ID and call `upsert()`.

### MEDIUM-10: No transaction wrapping -- crash between delete and create loses agent

**File:** `src/agent-manager-db.ts:3099-3119`, `src/db/db-adapter.ts`

Delete and create are separate operations with no transaction boundary. The `DbAdapter` interface has no transaction support at all. A crash between lines 3099 and 3104 permanently deletes the agent with no replacement.

**Recommendation:** Add transaction support to `DbAdapter`. For SQLite, use `db.transaction()`.

### MEDIUM-11: Old agent process orphaned on redeploy

**File:** `src/agent-manager-db.ts:3096-3100`

The existing agent's database row is deleted without stopping its process. The new agent gets a new port. The old process continues running as an orphan, consuming resources and potentially serving stale requests.

Compare: the `/delete` and `DELETE /agents/:id` handlers properly stop the runtime before database changes.

**Recommendation:** Kill the existing agent's process before the database delete:
```typescript
if (existing) {
  await this.killAgentProcess(existing.port);
  this.stopHeartbeatForAgent(existing.id);
  await this.db.agents.deleteAgent(effectiveTeamId, existing.id);
}
```

### MEDIUM-12: Race condition -- concurrent deploys create duplicates

**File:** `src/agent-manager-db.ts:2487, 3096-3119`

No mutex or lock on deploy. Two simultaneous `/remote` requests deploying the same agent will both find the existing row, both delete it, and both create new entries -- resulting in duplicate agents with the same name and possible port collisions from the TOCTOU gap in `nextPort()`.

**Recommendation:** Add a per-agent-name deploy mutex. For port allocation, use atomic `INSERT ... RETURNING`.

### LOW-4: Agent briefly missing from DB during redeploy

**File:** `src/agent-manager-db.ts:3099-3104`

Between delete and create, the agent does not exist. Concurrent message routing returns "not found".

**Recommendation:** Use `upsert()` instead of delete-then-create to eliminate the availability gap.

### LOW-5: Existing upsert() method not used

**File:** `src/db/repos/sqlite/agents-repo.ts:280-316` vs `src/agent-manager-db.ts:3099`

A well-implemented `upsert()` with `ON CONFLICT DO UPDATE` already exists but isn't used by the deploy path. The deploy generates a new ID each time, so the existing upsert on `(team_id, id)` doesn't match.

**Recommendation:** Look up the existing agent's ID and reuse it, or add a `UNIQUE` constraint on `(team_id, name) WHERE deleted_at IS NULL`.

---

## 6. SQLite Database Layer

### MEDIUM-13: Wallet name substring match allows cross-wallet data leakage

**File:** `src/agent-manager-db.ts:460`, `src/onchain/idchain-register.ts:212`, `src/interactive-agent-cli.ts:2426`

```typescript
if (line.includes('Name:') && line.includes(owsWallet)) { inWallet = true; }
```

`String.includes()` performs substring matching. Wallet name `"dev-agent"` matches `"dev-agent-backup"`.

**Recommendation:** Use exact match or regex with word boundaries.

### MEDIUM-14: Read-merge-write race condition in SQLite teams config

**File:** `src/db/repos/sqlite/teams-repo.ts:64-83`

`setRegistrarAddress` and `setDefaultRegistry` read config, modify in JS, then write back -- with no transaction. Concurrent updates lose data. The Postgres implementation uses atomic `jsonb_set`.

**Recommendation:** Wrap in a SQLite transaction or use `json_set()`.

### LOW-6: `SQLITE_PATH` env var allows arbitrary file path

**File:** `src/db/index.ts:24`

No validation on the override path. Low risk since controlling env vars implies local access.

**Recommendation:** Validate path is within home directory or log a warning.

### LOW-7: `SELECT *` exposes sensitive columns in application code

**File:** `src/db/repos/sqlite/agents-repo.ts` (25 occurrences)

All queries return `api_key` even when not needed. Any future code that serializes raw rows could leak keys.

**Recommendation:** Use explicit column lists or create a `AgentPublicRow` type.

### LOW-8: `exec()` method is public on SqliteAdapter

**File:** `src/db/sqlite-adapter.ts:30-32`

Accepts raw SQL without parameterization. Currently only called with hardcoded strings but is a public API surface.

**Recommendation:** Make `exec()` private.

### LOW-9: Migration runs as single exec() block

**File:** `src/db/migrations/sqlite.ts:5-79`

The entire schema is a single `exec()` call. A failure mid-way leaves partial DDL applied with no rollback.

**Recommendation:** Split into individual statements or wrap in a transaction.

---

## 7. Input Validation

### LOW-10: No input validation on agent name in /agents/spawn API

**File:** `src/agent-manager-db.ts:1506-1507`

The API endpoint does not enforce `VALID_AGENT_NAME_REGEX`. The CLI-side code validates at line 256, but direct API callers bypass this.

**Recommendation:** Apply `isValidAgentName()` from `src/core/config-utils.ts`.

---

## 8. Information Disclosure

### MEDIUM-15 (note: renumbered from above): Agent metadata exposed in all API responses

**File:** `src/agent-manager-db.ts:415`

```typescript
metadata: a.metadata,  // includes ows_wallet, plugins, allowed_tools, internal_url, etc.
```

The unfiltered metadata object is returned on every `GET /agents` call, with no auth required.

**Recommendation:** Filter to public-safe fields only.

*(This finding was reported by both the OWS and Manager Identity audits.)*

---

## 9. Positive Findings

- **No SQL injection:** All queries across all 17 database files use parameterized queries consistently. Dynamic query construction uses hardcoded fragments with parameterized values.
- **Safe JSON parsing:** `parseJsonObject()` and `parseJsonArray()` in `src/db/db-json.ts` wrap `JSON.parse` in try-catch with type validation.
- **`execFileSync` used for OWS/id-cli:** All external CLI invocations use `execFileSync` (not `execSync`), preventing shell injection.
- **Timing-safe key comparison:** `src/core/safe-compare.ts` implements proper `crypto.timingSafeEqual` with length normalization.
- **OWS architecture is sound:** Private keys stay in `~/.ows/` encrypted storage; agents interact only via the `ows` CLI.
- **Agent wallet isolation:** Each agent gets its own OWS wallet (`{team}-{agentName}`).
- **Safe YAML parsing:** `js-yaml` v4 defaults to the safe `CORE_SCHEMA` -- no arbitrary code execution.
- **Agent name validation exists** in config parsing (`/^[a-zA-Z0-9_-]+$/` at `config-parser.ts:263`).
- **Working directory deletion validates path** before `rmSync`.
- **`.gitignore` correctly excludes** `.env` and `.env.*`.

---

## 10. Remediation Priority

### Immediate (fixes amplifying vulnerabilities)

| # | Finding | Impact |
|---|---------|--------|
| HIGH-1 | Re-enable manager authentication | Blocks nearly all remote exploitation |
| HIGH-3,4,5 | Fix manager identity spoofing | Prevents agent manipulation via forged `from` |
| HIGH-9 | Allowlist env vars for child processes | Contains blast radius of compromised agents |

### Short-term (data loss and filesystem risks)

| # | Finding | Impact |
|---|---------|--------|
| HIGH-11 | Replace hard delete with soft delete/upsert in deploy | Prevents history loss on redeploy |
| HIGH-6,7,8 | Validate skill/plugin/team names and working directories | Blocks path traversal attacks |
| MEDIUM-10 | Add transaction support to DbAdapter | Prevents data loss on crash |
| MEDIUM-11 | Stop old agent process before deploy delete | Prevents orphan process leak |
| MEDIUM-7 | Fix ID_CONTROL_API_KEY overwrite logic | Prevents privilege escalation |

### Medium-term (defense in depth)

| # | Finding | Impact |
|---|---------|--------|
| HIGH-10 | Encrypt or remove plaintext private keys | Reduces exposure from DB file access |
| MEDIUM-3 | Issue per-agent API keys | Enables identity verification |
| MEDIUM-12 | Add deploy mutex | Prevents race conditions |
| LOW-1 | Restrictive file permissions on SQLite DB | Limits access on shared systems |

---

*Generated by parallel sub-agent audit. Each area was audited independently by a specialized security agent. Findings were deduplicated and consolidated where multiple agents reported the same issue (e.g., disabled auth, metadata exposure).*

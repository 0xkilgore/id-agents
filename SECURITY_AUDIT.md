# id-agents Security Audit — Consolidated Report

**Date:** 2026-03-22
**Auditors:** 3 parallel sub-agents (API, Crypto, Infrastructure)
**Scope:** Full codebase audit of the id-agents multi-agent orchestration platform

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH | 7 |
| MEDIUM | 10 |
| LOW | 6 |
| INFO | 5 |

---

## CRITICAL

### C-1. API Key Comparison Uses `===` (Not Timing-Safe)
**Files:** `agent-manager-db.ts:218,2887,2942,3003,3046,3359,4920`, `claude-agent-server.ts:271`
All API key comparisons use `===`/`!==`, vulnerable to timing attacks. An attacker can brute-force keys character by character.
**Fix:** Replace with `crypto.timingSafeEqual()` everywhere.

### C-2. Wallet Private Keys Stored as Plaintext in Database
**Files:** `db.ts:242`, `agent-manager-db.ts:602-604`
The `wallets` table stores `private_key text NOT NULL` — no encryption. Code comment falsely claims keys are "encrypted in PostgreSQL." `pgcrypto` is loaded only for UUID generation.
**Fix:** Encrypt private keys at rest using `pgp_sym_encrypt()` or application-level encryption.

### C-3. Per-Agent API Keys Stored in Plaintext
**File:** `db.ts:317`, `agent-manager-db.ts:1939`
The `agents.api_key` column stores keys in plaintext. Client-issued keys in the `api_keys` table correctly use hashing, but per-agent keys do not.
**Fix:** Store only SHA-256 hash of per-agent API keys.

### C-4. `dangerouslySkipPermissions` Bypasses All Claude Safety
**Files:** `claude-agent.ts:60-61`, `configs/idchain.yaml:21`
Grants agents full unsandboxed tool access (file write, shell execution, network) without human approval. Combined with arbitrary working directories, a prompt-injected agent has full host access.
**Fix:** Remove `bypassPermissions` from SDK harness. Use `allowedTools` to restrict capabilities.

---

## HIGH

### H-1. No Rate Limiting on Any Endpoint
**Files:** All server files
No rate limiting anywhere. `/talk` spam can exhaust LLM credits. `/agents/spawn` can create unlimited agents.
**Fix:** Add `express-rate-limit` on all endpoints.

### H-2. Shared `ID_AGENT_API_KEY` Across All Agents
**File:** `agent-manager-db.ts:206-223`
One compromised agent exposes the key that authenticates to every other agent and the manager, including `/agents/pay`.
**Fix:** Generate per-agent authentication tokens.

### H-3. Shell Command Injection via `execSync`
**Files:** `agent-manager-db.ts:5227`, `interactive-agent-cli.ts:1041,1549`, `loader-service.ts:93`
Port values and PIDs interpolated into shell commands via `execSync()`. The loader-service uses `spawn('bash', ['-c', ...])` with unvalidated env vars.
**Fix:** Use `process.kill()` for PIDs, `spawn` with array args instead of `bash -c`.

### H-4. No WebSocket Connection Limits
**File:** `agent-manager-db.ts:4873`
No `maxPayload`, `maxConnections`, or per-IP limits on WebSocket server.
**Fix:** Configure limits on `WebSocketServer`.

### H-5. No Body Size Limit on Express JSON Parser
**Files:** `agent-manager-db.ts:202`, `claude-agent-server.ts:219`
No explicit `limit` on `express.json()`. The `/files/upload` endpoint allows 50MB.
**Fix:** Set `express.json({ limit: '1mb' })` globally.

### H-6. Auth Bypass When No API Key Configured
**Files:** `agent-manager-db.ts:212`, `claude-agent-server.ts:245`
When `ID_CONTROL_API_KEY` is unset, all management endpoints are wide open. No startup warning.
**Fix:** Log a prominent warning. Require keys when `NODE_ENV=production`.

### H-7. Live Secrets in `.env` Accessible to All Agents
Registrar private key, Anthropic/OpenAI/OpenRouter API keys, and platform auth keys all in `.env`. Any agent with filesystem access can read them.
**Fix:** Use a secrets manager or restrict agent filesystem access.

---

## MEDIUM

### M-1. `/remote` Enables Full Management Access
**File:** `agent-manager-db.ts:3350-3376`
Simple string API key grants full platform control (deploy, delete, register, pay, issue keys).
**Fix:** Consider JWT/OAuth2, rate limiting, and audit logging.

### M-2. WebSocket Auth Accepts Agent Key for Management Commands
**File:** `agent-manager-db.ts:4913-4923`
`ID_AGENT_API_KEY` grants same WebSocket access as `ID_CONTROL_API_KEY`.
**Fix:** Separate permission scopes.

### M-3. No Path Traversal Prevention on `workingDirectory`
**File:** `agent-manager-db.ts:1858,1965`
API accepts arbitrary absolute paths for agent working directories.
**Fix:** Validate paths are within allowed directories.

### M-4. SSRF via Agent Proxy Route
**File:** `agent-manager-db.ts:3415-3465`
Virtual agents with crafted endpoint URLs can proxy requests to internal services.
**Fix:** Block RFC 1918, link-local, and cloud metadata addresses.

### M-5. CLAUDE.md Injection via Agent Identity
**File:** `agent-manager-db.ts:2163-2174`
ENS domain values written directly into CLAUDE.md. Could enable prompt injection if registration is compromised.
**Fix:** Sanitize identity names before writing.

### M-6. Missing Env Var Validation at Startup
**File:** `agent-manager-db.ts:208-213`
No startup warning when running without authentication keys.
**Fix:** Log warnings for missing security-critical env vars.

### M-7. Error Responses Leak Internal Details
**Files:** Multiple locations across all servers
Error messages include internal paths, database errors, implementation details.
**Fix:** Return generic errors in production, log details server-side.

### M-8. No CORS Configuration
No `cors()` middleware on any server.
**Fix:** Add explicit CORS restricting to known origins.

### M-9. No Security Headers
No `helmet()` or manual security headers (CSP, HSTS, X-Frame-Options).
**Fix:** Add `helmet()` middleware.

### M-10. `idchain-register.ts` Passes Full `process.env` to Child
**File:** `idchain-register.ts:49`
`const env = { ...process.env }` exposes all env vars to `id-cli` child process.
**Fix:** Pass only required env vars.

---

## LOW

### L-1. Legacy `agent-manager.ts` Writes Wallets to Plaintext JSON
**File:** `agent-manager.ts:89-122`
Old code path writes `agent-wallets.json`. May leave files on disk.
**Fix:** Remove legacy file or clean up on migration.

### L-2. Localhost Bypass on Agent Auth
**File:** `claude-agent-server.ts:254-258`
Any local process can communicate with agents without auth.

### L-3. Agent Name Sanitization Inconsistent
**Files:** `local-agent-server.ts:166`, `config-parser.ts:260`, `agent-manager-db.ts:1858`
Different validation rules in different places.

### L-4. Log File Path Traversal
**File:** `agent-manager-db.ts:5199`
Agent name used in `/tmp/${name}.log` without `path.basename()`.

### L-5. API Key in WebSocket Query Parameter
**File:** `agent-manager-db.ts:4913`
Keys in query params get logged by proxies/load balancers.

### L-6. Team Clone Copies Same Private Key
Cloning a team reuses the wallet key instead of generating a fresh one.

---

## INFO (Positive Findings)

- `.env` properly gitignored, `.env.example` has no real secrets
- No hardcoded secrets in source files
- All SQL queries use parameterized queries (no SQL injection)
- `execFile` (not `exec`) used for `id-cli` calls — prevents shell injection
- `crypto.randomBytes(32)` provides proper CSPRNG entropy for wallet generation
- Client-issued API keys (`sk-id-xxx`) correctly hashed with SHA-256
- `/remote` command dispatch uses structured `switch`, not shell execution

---

## Priority Remediation Order

1. **Timing-safe API key comparison** (C-1) — one-line fix per location
2. **Encrypt wallet private keys at rest** (C-2) — requires migration
3. **Hash per-agent API keys** (C-3) — schema change
4. **Add rate limiting** (H-1) — `express-rate-limit` middleware
5. **Fix `execSync` injection patterns** (H-3) — use `process.kill()` and array `spawn`
6. **Per-agent auth tokens** (H-2) — replace shared key
7. **Startup warnings for missing auth** (H-6, M-6)
8. **WebSocket limits** (H-4, H-5)
9. **Restrict working directory paths** (M-3)
10. **Separate agent/control key permissions** (M-2)

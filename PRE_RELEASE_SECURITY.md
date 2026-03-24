# Pre-Release Security Scan

**Date:** 2026-03-23
**Scanner:** agents.agent-16.sep.xid.eth

## Blockers

1. **nohup.out was committed in initial commit (974ad2f) with Node.js REPL output.** It was removed in 05a50ea and added to `.gitignore`, but the content remains in git history. Not a secret leak (just `undefined` lines from a REPL), but run `git log -p -- nohup.out` to confirm no sensitive data leaked. **Low risk but verify.**

2. **`wallets` table stores `private_key` in plaintext.** The table is marked DEPRECATED in `src/db.ts:237` and the code says per-agent keys now come from `.env.<agent_id>` files. However, the table is still created on migration and the team-copy code in `agent-manager-db.ts:2171` still copies private keys between teams. If any wallets exist in the DB, keys are stored unencrypted. **If the wallets table has real data in production, those keys are at risk.**

## Warnings

1. **Stale comment references removed `sk-id-xxx` validation.** `src/claude-agent-server.ts:235` still says "Client-issued keys (sk-id-xxx) - validated via manager" but `validateClientApiKey()` was removed in commit 05a50ea. The comment is misleading but harmless -- the actual auth logic at lines 240-276 only checks `ID_AGENT_API_KEY`. Clean up the comment.

2. **`env.example` (tracked) contains placeholder credentials that look real-ish.** Lines like `ID_INDEXER_API_KEY=sk-id-YOUR_KEY` and `DATABASE_URL=postgresql://idagents:idagents@localhost:5433/id_agents` are fine as examples, but the `SEPOLIA_REGISTRAR_ADDRESS=0x05f080e221059721716d2761bf4f97327bda7908` is an actual on-chain address. Not a secret, but worth noting. The `.env.example` file uses commented-out placeholders and is fine.

3. **Hardcoded default registry address.** `src/agent-manager-db.ts:585` has `0x2b39585cc5004712c938480cd7ff5b97d2bbf433` as a fallback. This is a public contract address (not a secret) but should be documented.

4. **`api_keys` and `tasks` table creation still in `db.ts` migrations** (per RELEASE_CHECKLIST.md). The `/keys` system was removed but the table schema may still be created. Not a security issue, just dead code. (Confirmed: `api_keys` is NOT in `db.ts` -- it was already removed. Only `tasks` may remain as noted in the checklist.)

## Passed

- **No hardcoded secrets in source code.** No API keys, passwords, or private keys found in any `.ts` files.
- **No real secrets in git history.** Searched for `sk-ant-`, `PRIVATE_KEY` values, 64-char hex strings -- all clean. `.env.example` only has placeholder text.
- **`.gitignore` is solid.** Covers `.env`, `.env.*`, `*.pem`, `*.key`, `**/agent-wallets.json`, `**/.env.wallet`, `nohup.out`, `node_modules/`, `*.tgz`, `workspace/`, `.claude/`.
- **No `.env` or secret files tracked.** Only `.env.example` is tracked (intentional, has placeholder values only).
- **`safeCompare` is correctly implemented and actively used.** Uses `crypto.timingSafeEqual` with proper length-normalization. Used in `agent-manager-db.ts` (control API key for `/remote` and WebSocket auth) and `claude-agent-server.ts` (agent API key auth). Appropriate and necessary.
- **No SQL injection.** All database queries in `db.ts` and `agent-manager-db.ts` use parameterized queries (`$1`, `$2`, etc.). No string concatenation in SQL.
- **No command injection.** All `spawn()` calls use array arguments, not shell string interpolation. The one `spawn('/bin/bash', ['-c', ...])` in `claude-code-cli.ts:256` builds the command from internal config, not user input.
- **`validateClientApiKey` fully removed.** No references remain in source code (removed in 05a50ea).
- **Auth middleware is sound.** Both the manager (`/remote`, WebSocket) and worker (agent API key) properly validate keys using `safeCompare`.

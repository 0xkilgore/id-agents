# XMTP Messaging System -- Security Review

**Date:** 2026-04-02
**Branch:** `feature/xmtp-messaging`
**Reviewers:** crypto-security, infra-security, api-security (specialized security agents)
**Team agents consulted:** contracts, gateway, web, cli, indexer (could not access branch -- working in separate repos)

---

## Executive Summary

The XMTP messaging subsystem was reviewed across three security domains: cryptographic/key management, infrastructure/file I/O, and API/input validation. The review identified **1 critical**, **5 high**, **7 medium**, and **7 low** severity findings, plus 2 informational notes.

The most urgent issue is a **critical bug**: the OWS signer path does not pass the DB encryption key to the XMTP SDK, leaving message history and MLS keys stored in plaintext SQLite databases on disk.

Three high-severity findings form a **critical chain**: unauthenticated XMTP endpoints (H1) + open-mode allowlist default (H3) + unsanitized prompt injection (H2) means any XMTP network user can send crafted messages that the agent's LLM processes with full tool access (Bash, file I/O). This is effectively remote code execution via prompt injection.

---

## Findings

### Critical

#### C1: Unencrypted XMTP database on OWS signer path

**File:** `src/xmtp/xmtp-messaging.ts` lines 227-230
**Domain:** Cryptographic

When the OWS wallet path is taken, `Agent.create(signer, options)` is called without `dbEncryptionKey`. Only `Agent.createFromEnv()` reads `XMTP_DB_ENCRYPTION_KEY` from `process.env` -- the manual `create()` path does not. The `XmtpConfig` interface even declares a `dbEncryptionKey` field (line 30) but it is never read.

All agents using OWS wallets have their XMTP message history, MLS group keys, and identity keys stored in plaintext SQLite databases at `.xmtp/<env>-<port>.db3`.

**Fix:** Pass `dbEncryptionKey` to `Agent.create()` options:
```typescript
const dbKey = this.config.dbEncryptionKey || process.env.XMTP_DB_ENCRYPTION_KEY;
this.agent = await Agent.create(signer, {
  ...(this.config.env && { env: this.config.env }),
  ...(this.config.dbPath && { dbPath: () => this.config.dbPath! }),
  ...(dbKey && { dbEncryptionKey: dbKey.startsWith('0x') ? dbKey : `0x${dbKey}` }),
});
```

---

### High

#### H1: No authentication on XMTP endpoints

**File:** `src/claude-agent-server.ts` lines 1063-1085
**Domain:** API

`POST /xmtp/send` and `GET /xmtp/status` have no authentication -- no API key check, no localhost restriction. By contrast, `/talk-to` explicitly checks `req.ip` for localhost access (lines 926-936). Any network client that can reach the agent port can send arbitrary XMTP messages impersonating the agent.

**Fix:** Apply the same localhost restriction used by `/talk-to`, or require API key authentication.

#### H2: Prompt injection via inbound XMTP messages

**File:** `src/claude-agent-server.ts` line 1680
**Domain:** API + Infra

Inbound XMTP message content is embedded directly into the LLM prompt with no sanitization:

```typescript
const prompt = `[XMTP message from ${inbound.senderAddress}]\n\n${inbound.content}`;
```

The `[XMTP message from ...]` prefix provides no meaningful boundary. An attacker can craft messages containing prompt injection payloads. Since agents have full tool access (Bash, Read, Write), successful injection amounts to remote code execution.

**Fix:**
1. Wrap content in strong delimiters with system-level instructions marking it as untrusted user input.
2. Consider restricting available tools when processing XMTP-originated queries.
3. Add content length limits on inbound messages.

#### H3: Empty allowlist defaults to open mode + no approval callback

**Files:** `src/xmtp/xmtp-messaging.ts` lines 147-149; `src/claude-agent-server.ts` lines 1671-1716
**Domain:** API + Crypto

`isSenderAllowed()` returns `true` when the allowlist is empty (line 148). In `startXmtp()`, no `setApprovalCallback()` is ever called. If `.xmtp/allowlist.yaml` doesn't exist or is empty, **any XMTP user on the network** can send messages that are processed by the agent's LLM with no approval gate.

The entire approval callback mechanism (lines 99-101, 314-322, 377-385, 396-407) is dead code in the current integration.

**Fix:**
1. Default to closed mode (empty allowlist rejects all senders).
2. Always set an approval callback in `startXmtp()` for unknown senders.
3. Log a prominent warning at startup when operating in open mode.

#### H4: XMTP env vars not passed to spawned agent processes

**File:** `src/agent-manager-db.ts` lines 4897-4926
**Domain:** Infra

The agent process spawner builds an explicit env allowlist (`localEnv`). This allowlist does NOT include `XMTP_DB_ENCRYPTION_KEY`, `XMTP_ENV`, or `WEB3_BIO_API_KEY`. XMTP will silently fail to start on spawned agents unless `OWS_WALLET` is the signing method (which IS forwarded).

**Fix:** Add `XMTP_DB_ENCRYPTION_KEY`, `XMTP_ENV`, and `WEB3_BIO_API_KEY` to the spawned env allowlist. Do NOT add `XMTP_WALLET_KEY` (would share private key across agents).

#### H5: Dummy key `0x00...00` in OWS signer `getIdentifier()`

**File:** `src/xmtp/ows-signer.ts` line 31
**Domain:** Cryptographic

The `getIdentifier()` function constructs a `User` object with an all-zeros key and passes it to `createIdentifier()`. While `createIdentifier` currently only reads `user.account.address` and ignores the key, this is architecturally fragile. If the XMTP SDK ever changes to derive the identifier from the key, the agent would silently bind to the wrong identity (`0x3f17...5FB5`).

**Fix:** Build the `Identifier` object directly:
```typescript
getIdentifier: () => ({
  identifier: address.toLowerCase(),
  identifierKind: 0, // IdentifierKind.Ethereum
}),
```

---

### Medium

#### M1: No message size limit on /xmtp/send or inbound

**Files:** `src/claude-agent-server.ts` line 1063; `src/xmtp/xmtp-messaging.ts` line 363
**Domain:** API

The global Express body parser allows up to 100KB (default). No application-level validation of `message` field length. Inbound XMTP messages have no size validation before being passed into the LLM prompt, consuming excessive tokens.

**Fix:** Validate `message.length` in `/xmtp/send` (e.g., 4KB max). Truncate oversized inbound messages in `handleInbound()`.

#### M2: No rate limiting on inbound XMTP messages

**Files:** `src/xmtp/xmtp-messaging.ts` line 240; `src/claude-agent-server.ts` lines 1674-1709
**Domain:** API

Every received message triggers `handleInbound()` with no rate limiting. Messages accumulate in the query queue with no bound. An attacker sending 100 messages creates 100 queued LLM queries.

**Fix:** Add per-sender rate limiting (e.g., 5 messages/minute). Cap the query queue size.

#### M3: No recipient validation on outbound /xmtp/send

**Files:** `src/xmtp/xmtp-messaging.ts` lines 290-336; `src/claude-agent-server.ts` line 1068
**Domain:** API

The `to` field accepts any string. Unusual inputs (long strings, special characters, null bytes) are passed to ENS resolution and potentially to `execFileSync('id-cli', ['info', name])`.

**Fix:** Validate `to` format: match `^0x[a-fA-F0-9]{40}$` for addresses or a reasonable ENS pattern (`/^[a-z0-9.-]+\.eth$/i`, max 100 chars).

#### M4: Allowlist file written without restrictive permissions

**File:** `src/xmtp/xmtp-messaging.ts` lines 188-203
**Domain:** Infra

`writeFileSync` uses default permissions (typically 644). Another user or process could read the trusted sender list or modify it to add a malicious address.

**Fix:** Write with `mode: 0o600`. Create `.xmtp/` directory with `mode: 0o700`.

#### M5: Message content logged to world-readable files

**Files:** `src/claude-agent-server.ts` line 1676; `src/xmtp/xmtp-messaging.ts` line 375
**Domain:** Infra

First 80 characters of every XMTP message are logged. Agent stdout is redirected to `/tmp/${name}.log` with default permissions (644, world-readable).

**Fix:** Don't log message content, or gate behind a debug flag. Write log files with mode `0o600`. Move logs out of `/tmp/`.

#### M6: `execFileSync` arguments not format-validated

**Files:** `src/xmtp/ows-signer.ts` lines 38-46, 62; `src/xmtp/xmtp-messaging.ts` lines 259-276
**Domain:** Infra + Crypto

`walletName` and ENS `name` are passed to `execFileSync` without format validation. While `execFileSync` with array args prevents shell injection, argument injection is possible (e.g., `--help` as a wallet name). The `walletName` matching in `getOwsAddress` uses substring match (`line.includes(walletName)`) which could select the wrong wallet if names are prefixes of each other.

**Fix:**
1. Validate `walletName` against `/^[a-zA-Z0-9_-]+$/`.
2. Validate ENS names against `/^[a-z0-9.-]+\.eth$/i`.
3. Use exact matching for wallet names in `getOwsAddress`.
4. Use `--` end-of-options separator before arguments.

#### M7: Dead `walletKey` field in XmtpConfig

**File:** `src/xmtp/xmtp-messaging.ts` lines 25-26
**Domain:** Crypto

The `XmtpConfig` interface declares `walletKey?: string` but it is never read. A developer who sets it believes their key is being used, but it's silently ignored.

**Fix:** Either implement `walletKey` support or remove the field from the interface.

---

### Low

#### L1: Interval timer leak on query timeout

**File:** `src/claude-agent-server.ts` lines 1685-1705
**Domain:** API

The poll-based reply mechanism uses `setInterval` + `setTimeout`. On timeout, the `activeQueries` entry is never cleaned up. Minor: stale entries accumulate.

**Fix:** Clean up `activeQueries` entry on timeout. Consider `Promise.race` instead of polling.

#### L2: Error messages may leak internal details

**Files:** `src/claude-agent-server.ts` line 1075; `src/xmtp/xmtp-messaging.ts` line 334; `src/xmtp/ows-signer.ts` line 89
**Domain:** API + Crypto

Error responses return `err?.message` directly, which may include internal paths, connection strings, or wallet names.

**Fix:** Return generic error messages to clients. Log full errors server-side only.

#### L3: No security headers on worker endpoints

**File:** `src/claude-agent-server.ts` (global)
**Domain:** API

No CORS, Helmet, CSP, or HSTS headers. Low risk behind Caddy reverse proxy but no defense-in-depth.

**Fix:** Consider adding `helmet()` middleware.

#### L4: TOCTOU race in allowlist persistence

**File:** `src/xmtp/xmtp-messaging.ts` lines 165-203
**Domain:** Infra

`existsSync` + `readFileSync` is a TOCTOU pattern. No atomic write (write-to-temp-then-rename). Low probability due to Node.js single-threaded nature.

**Fix:** Use atomic write pattern. Wrap `readFileSync` in try/catch instead of `existsSync` check.

#### L5: XMTP env vars not documented in .env.example

**File:** `.env.example`
**Domain:** Infra

No XMTP-related env vars are documented. Operators may misconfigure.

**Fix:** Add an XMTP section to `.env.example` with commented placeholders.

#### L6: `execFileSync` in `signMessage` blocks the event loop

**File:** `src/xmtp/ows-signer.ts` lines 38-46
**Domain:** Crypto

`signMessage` is declared `async` but uses `execFileSync` with a 30-second timeout, blocking the entire event loop during signing.

**Fix:** Use `execFile` (async) with `util.promisify`.

#### L7: Message content logged before approval decision

**File:** `src/xmtp/xmtp-messaging.ts` line 375
**Domain:** Crypto

The first 80 chars of every inbound message are logged before the approval callback runs. Content is logged even for messages that will be rejected.

**Fix:** Move content logging after the approval check.

---

### Informational

#### I1: `yaml.load()` is safe in js-yaml v4

**File:** `src/xmtp/xmtp-messaging.ts` line 170

The project uses `js-yaml ^4.1.0` where `yaml.load()` defaults to `DEFAULT_SAFE_SCHEMA`. No YAML deserialization attack is possible.

#### I2: `.xmtp/` directory is properly gitignored

The `.xmtp/` directory (containing database files and allowlists) is excluded from version control.

---

## Critical Attack Chain

Findings H1 + H3 + H2 form a high-impact attack chain:

```
Unauthenticated /xmtp/send (H1)
    + Open-mode allowlist accepts all senders (H3)
    + No approval callback configured (H3)
    + Unsanitized prompt injection into LLM (H2)
    + Agent has full tool access (Bash, Read, Write)
    = Remote code execution via prompt injection
```

**Priority fix order:**
1. **C1** -- Pass `dbEncryptionKey` to `Agent.create()` (one-line fix, critical data exposure)
2. **H3** -- Default to closed allowlist mode, set approval callback (breaks the attack chain)
3. **H1** -- Add authentication to XMTP endpoints (prevents impersonation)
4. **H2** -- Add prompt injection mitigations (defense in depth)
5. **H4** -- Forward XMTP env vars to spawned agents (silent failure)
6. **H5** -- Replace dummy key with direct identifier (fragility)

---

## Positive Observations

- `execFileSync` with array args (not string interpolation) is used consistently -- prevents shell injection
- `XMTP_WALLET_KEY` env var is never logged
- Sender identity is verified before content processing in `handleInbound()`
- `noAutoReply: true` on inbound queries prevents basic reply loops
- Self-message filtering (`senderAddress === agent.address`) prevents self-loops
- The OWS signing model (key never leaves vault) is the correct architecture

---

## Summary Table

| ID | Severity | Finding | File |
|----|----------|---------|------|
| C1 | CRITICAL | Unencrypted XMTP DB on OWS path | xmtp-messaging.ts:227 |
| H1 | HIGH | No auth on XMTP endpoints | claude-agent-server.ts:1063 |
| H2 | HIGH | Prompt injection via inbound messages | claude-agent-server.ts:1680 |
| H3 | HIGH | Open-mode allowlist + no approval callback | xmtp-messaging.ts:148, claude-agent-server.ts:1671 |
| H4 | HIGH | XMTP env vars not forwarded to spawned agents | agent-manager-db.ts:4897 |
| H5 | HIGH | Dummy key fragility in OWS signer | ows-signer.ts:31 |
| M1 | MEDIUM | No message size limit | claude-agent-server.ts:1063 |
| M2 | MEDIUM | No rate limiting on inbound | xmtp-messaging.ts:240 |
| M3 | MEDIUM | No recipient validation | xmtp-messaging.ts:296 |
| M4 | MEDIUM | Allowlist file permissions | xmtp-messaging.ts:188 |
| M5 | MEDIUM | Content logged to world-readable files | claude-agent-server.ts:1676 |
| M6 | MEDIUM | execFileSync args not validated | ows-signer.ts:38, xmtp-messaging.ts:262 |
| M7 | MEDIUM | Dead walletKey config field | xmtp-messaging.ts:25 |
| L1 | LOW | Interval timer leak | claude-agent-server.ts:1685 |
| L2 | LOW | Error messages leak details | claude-agent-server.ts:1075 |
| L3 | LOW | No security headers | claude-agent-server.ts (global) |
| L4 | LOW | TOCTOU in allowlist I/O | xmtp-messaging.ts:165 |
| L5 | LOW | Env vars not documented | .env.example |
| L6 | LOW | Sync signing blocks event loop | ows-signer.ts:38 |
| L7 | LOW | Content logged before approval | xmtp-messaging.ts:375 |
| I1 | INFO | yaml.load safe in v4 | xmtp-messaging.ts:170 |
| I2 | INFO | .xmtp/ properly gitignored | .gitignore |

# Release Readiness Audit

**Date:** 2026-03-23
**Version:** 0.1.0-beta
**Auditor:** agents.agent-16.sep.xid.eth

---

## 1. Build

**Status: PASS**

`npm run build` (tsc) succeeds with zero errors and zero warnings.

```
> id-agents@0.1.0-beta build
> tsc
```

Build output (`dist/`) contains all expected files including `interactive-agent-cli.js` (bin entry) and `index.js` (main entry). The bin entry has the correct `#!/usr/bin/env node` shebang.

---

## 2. package.json

**Issues found: 5**

### [MEDIUM] env.example vs README env var name mismatch
- README documents `PRIVATE_KEY` for wallet private key
- env.example uses `ID_REGISTRAR_PRIVATE_KEY`
- These are different names for what appears to be the same purpose

### [MEDIUM] Stale orchestrator/Docker env vars in env.example
Lines 72-80 of `env.example` reference `ORCHESTRATOR_TYPE=docker`, `ORCHESTRATOR_URL`, `ORCHESTRATOR_API_KEY`, `CONTAINER_MANAGER_PORT`, and `CONTAINER_MANAGER_API_KEY`. The Docker container system was removed (per CLAUDE.md: "Docker container system was removed"), but these env vars remain.

### [MEDIUM] Scripts reference files that may not exist or serve dead paths
- `claude` script runs `dist/claude-agent-cli.js` -- exists, but not documented
- `claude:server` runs `dist/start-claude-server.js` -- exists, but not documented
- `claude:talk` runs `dist/claude-restap-cli.js` -- exists, but not documented
- `test:claude` runs `dist/test-claude-agent.js` -- test helper, not documented
- `test:claude-client` runs `dist/examples/test-claude-client.js` -- example code, not documented
- `demo` and `demo:inter-agent` run example files -- not documented
- These are not necessarily broken, but many are internal/dev scripts exposed in the public package.json

### [LOW] `node-fetch` may be unnecessary
Node.js 20+ (the minimum engine version) has native `fetch`. The project imports `node-fetch` in 9 source files. This is a dependency that could be removed, though it works fine as-is.

### [LOW] `@types/node-fetch` in devDependencies
If `node-fetch` is kept, this is fine. If migrated to native fetch, both should be removed.

---

## 3. README.md

**Issues found: 6**

### [MEDIUM] Stale Docker/container references removed from README -- GOOD
The main README has been cleaned up and does not reference Docker. This is correct.

### [MEDIUM] `DATABASE_URL` listed as "Required" in README but "Optional" in CLAUDE.md
- README: `DATABASE_URL | Yes | PostgreSQL connection string`
- CLAUDE.md project instructions: `DATABASE_URL | No | PostgreSQL connection`
- env.example provides a default value, suggesting it is required for operation

### [MEDIUM] README env var `PRIVATE_KEY` does not match env.example `ID_REGISTRAR_PRIVATE_KEY`
README line 170: `PRIVATE_KEY | No | Wallet private key for onchain agent registration`
env.example line 64: `ID_REGISTRAR_PRIVATE_KEY=0x...`

### [LOW] CLI commands list in README is a subset of actual commands
README documents ~15 commands. CLAUDE.md documents ~50+. This is intentional simplification per commit `d9ce2c2` ("Simplify help menu for public release") and is acceptable for a public-facing README, but users may not discover many features.

### [LOW] Quick Start references `cp env.example .env`
The file is named `env.example` (not `.env.example`). This is correct as written. No issue.

### [LOW] README does not mention the mobile app
A `mobile/` directory with 16 tracked files (React Native app) exists in the repo but is not mentioned anywhere in README or docs. If this is intentional (WIP/internal), it should either be documented or excluded from the repo.

---

## 4. .gitignore

**Status: GOOD with issues**

### [CRITICAL] `nohup.out` is tracked in git
The file `nohup.out` is committed to the repository. It contains Node.js REPL output. This file should not be in version control. `.gitignore` does not exclude `nohup.out`.

### [LOW] Missing `.gitignore` entries
The following could be added:
- `nohup.out` -- should be ignored
- `*.tgz` -- npm pack output
- `.npmrc` -- if local npm config exists

Current coverage is otherwise solid: `node_modules/`, `dist/`, `.env`, `.env.*`, `*.pem`, `*.key`, `agent-wallets.json`, `.env.wallet`, IDE files, coverage, workspace dirs are all covered.

---

## 5. Git State

**Status: CLEAN**

```
On branch main
nothing to commit, working tree clean
```

Commit history (3 commits):
```
9e8ffd4 Remove dead code and update docs for v1 release
d9ce2c2 Simplify help menu for public release
974ad2f Initial commit
```

The history is clean and logical. Only 3 commits suggests this was squashed or freshly prepared for release.

---

## 6. Tests

**Status: EXISTS but NOT RUNNABLE standalone**

### [MEDIUM] Tests require running infrastructure
7 integration test files exist in `tests/integration/`:
- `agent-capabilities.test.ts`
- `agent-lifecycle.test.ts`
- `agent-relay.test.ts`
- `api-key-auth.test.ts`
- `external-client.test.ts`
- `remote-commands.test.ts`
- `require-auth-config.test.ts`

Plus a helper: `tests/helpers/manager-client.ts`

Test config (`vitest.config.ts`) is properly configured with 5-minute timeouts.

However, running `npm test` / `npx vitest run` hangs indefinitely because tests require:
- A running PostgreSQL database
- A running manager instance
- `ANTHROPIC_API_KEY` set

There are no unit tests that can run without infrastructure. No CI configuration exists.

### [LOW] No unit tests
All tests are integration tests. No isolated unit tests for core logic (config parsing, agent identification, messaging, etc.).

---

## 7. Files That Should Not Be Committed

### [CRITICAL] `nohup.out` is tracked
Contains Node.js REPL output. Should be removed from tracking and added to `.gitignore`.

```
git rm --cached nohup.out
```

### [LOW] `.env` files on disk but not tracked (GOOD)
Multiple `.env.*` files exist on disk (`.env`, `.env.contracts.*`, `.env.web.*`, etc.) but are properly gitignored. Only `.env.example` (as `env.example`) is tracked. No secrets are committed.

### [LOW] `.env.example.swp` exists on disk
A vim swap file exists but is not tracked (covered by `*.swp` in `.gitignore`). Just cleanup.

---

## 8. License

**Status: GOOD**

- `LICENSE` file: MIT (full text, correct)
- `package.json`: `"license": "MIT"` (correct)
- README badge: MIT (correct)
- SPDX headers across source files: `MIT` (correct)
- `src/index.ts` JSDoc `@license MIT` matches SPDX header `MIT`

### [LOW] Version string in `src/index.ts` is `0.1.0-alpha` but package.json is `0.1.0-beta`
Line 8: `@version 0.1.0-alpha` -- should be `0.1.0-beta` to match.

---

## 9. env.example

**Status: EXISTS with issues**

### [MEDIUM] Contains stale Docker/orchestrator configuration
Lines 72-80 document `ORCHESTRATOR_TYPE=docker`, `ORCHESTRATOR_URL`, `ORCHESTRATOR_API_KEY`, and deprecated `CONTAINER_MANAGER_PORT`/`CONTAINER_MANAGER_API_KEY`. Docker has been removed from the system.

### [MEDIUM] Variable name mismatch with README
- env.example: `ID_REGISTRAR_PRIVATE_KEY`
- README: `PRIVATE_KEY`

### [LOW] `CLAUDE_DEFAULT_PLUGIN` references `/spawn` command
Line 19: "Can be overridden per-agent using the plugin-path parameter in /spawn" -- the `/spawn` command does not appear in README or the simplified help menu. May be renamed or internal.

### [LOW] DATABASE_URL default references docker-compose
Line 39: "For local development (uses docker-compose postgres)" -- Docker has been removed. The connection string itself is fine for any local PostgreSQL.

---

## 10. Documentation

**Status: EXISTS with stale references**

### Referenced docs from README -- all present:
- `docs/README.md` -- present, accurate index
- `docs/protocol/rest-ap.md` -- present
- `docs/guides/interactive-agent.md` -- present
- `docs/reference/configuration.md` -- present
- `docs/reference/database.md` -- present

### Additional docs present:
- `docs/reference/api-keys.md`
- `docs/reference/harnesses.md`
- `docs/reference/id-indexer-api.md`
- `docs/deployment/hetzner.md`
- `docs/deployment/hetzner-setup.md`
- `docs/design/system-design-plan.md`
- `docs/design/mobile-app-proposal.md`
- `docs/agents/org-chart.md`
- `docs/erc-draft-agent-identifiers.md`

### [MEDIUM] `docs/reference/harnesses.md` documents removed harnesses
Documents 3 harnesses: `claude-code`, `open-code`, and `codex`. The actual codebase only has 2 harnesses (`claude-agent-sdk` and `claude-code-cli`). The OpenCode and Codex harnesses have been removed from the code but the documentation still references them extensively.

### [MEDIUM] Multiple docs reference Docker/containers
8 documentation files still reference Docker containers or the container-manager:
- `docs/guides/interactive-agent.md`
- `docs/deployment/hetzner-setup.md`
- `docs/deployment/hetzner.md`
- `docs/reference/configuration.md`
- `docs/reference/database.md`
- `docs/design/system-design-plan.md`
- `docs/protocol/rest-ap.md`
- `docs/README.md` (via harnesses link)

### [MEDIUM] `CONTRIBUTING.md` references removed components
- Line 34: `container-manager.ts` -- file does not exist
- Line 35: `Orchestrator service` -- removed
- Line 40: `orchestrator/` directory -- does not exist
- Line 94: "Docker version" in environment details -- Docker not needed

### [MEDIUM] `SECURITY.md` references Docker containers
- Line 26: "runs code in containers"
- Lines 43-46: "Agents run in Docker containers with isolated filesystems"
- Line 51: "Agent containers expose REST-AP endpoints"
- All of these are now inaccurate; agents run as local processes.

### [MEDIUM] `CHANGELOG.md` references Docker containers
- Line 13: "Multi-agent orchestration with Docker containers" -- should say "local processes"

### [LOW] `skills/README.md` references Docker containers
- Line 47: "outside Docker containers"
- Lines 84-85: "Inside containers, skills live at: /app/skills/"
- The container paths no longer apply.

### [LOW] `docs/README.md` still links to harnesses doc mentioning removed runtimes
The harnesses doc (`docs/reference/harnesses.md`) describes OpenCode and Codex which no longer exist in the codebase.

---

## Summary Table

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 2 | `nohup.out` tracked in git; `nohup.out` should be in .gitignore |
| MEDIUM | 13 | Stale Docker/container references across docs, CONTRIBUTING, SECURITY, CHANGELOG, env.example; harness docs describe removed runtimes; license mismatch in index.ts; env var name mismatches; DATABASE_URL required vs optional conflict; tests not runnable standalone |
| LOW | 9 | Missing .gitignore entries; version mismatch in index.ts; no unit tests; undocumented mobile app; simplified CLI docs; node-fetch possibly unnecessary; swap file on disk; skills README Docker refs; stale /spawn reference |

---

## Recommended Actions Before Release

### Must Fix (Critical)
1. Remove `nohup.out` from git tracking and add to `.gitignore`

### Should Fix (Medium)
2. ~~Fix license annotation conflict in `src/index.ts`~~ (resolved: project switched to MIT)
3. Update `CONTRIBUTING.md` -- remove references to `container-manager.ts`, `orchestrator/` dir, Docker
4. Update `SECURITY.md` -- change "Docker containers" to "local processes"
5. Update `CHANGELOG.md` -- change "Docker containers" to "local processes"
6. Update `docs/reference/harnesses.md` -- remove OpenCode and Codex sections, document actual harnesses (`claude-agent-sdk`, `claude-code-cli`)
7. Clean up `env.example` -- remove stale orchestrator/Docker vars
8. Align env var name `PRIVATE_KEY` (README) vs `ID_REGISTRAR_PRIVATE_KEY` (env.example)
9. Decide if `DATABASE_URL` is required or optional, and make README, CLAUDE.md, and env.example consistent
10. Update Docker references in other docs (`docs/deployment/`, `docs/reference/`, `docs/design/`)

### Nice to Have (Low)
11. Update version in `src/index.ts` from `0.1.0-alpha` to `0.1.0-beta`
12. Decide whether `mobile/` should be in the repo (document it or exclude it)
13. Add `nohup.out` and `*.tgz` to `.gitignore`
14. Consider adding at least one unit test that can run without infrastructure
15. Consider migrating from `node-fetch` to native `fetch` (Node 20+)

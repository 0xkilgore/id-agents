# Release Checklist — ID Agents v0.1.0-beta

**Date:** 2026-03-23 | **Auditor:** agents.agent-16.sep.xid.eth
**Based on:** AUDIT_FUNCTIONALITY.md, AUDIT_CODE_QUALITY.md, AUDIT_RELEASE.md

---

## MUST FIX (Critical — blocks release)

- [ ] **Deploy ignores domain/tokenId/address from YAML configs.** `deployFromConfig()` never reads `domain`, `tokenId`, or `address` from agent specs. Deploying with `idchain.yaml` creates agents with no onchain identity. Fix: include these fields in the spawn payload and store them in the DB.
  *Source: AUDIT_FUNCTIONALITY.md*

- [ ] **Broken `/keys/validate` call in worker.** `claude-agent-server.ts` calls `${managerUrl}/keys/validate` to validate client API keys, but that endpoint was removed. This silently fails every request. Fix: remove the `validateClientApiKey()` function and its callsites, or replace with a simpler auth check.
  *Source: AUDIT_CODE_QUALITY.md*

- [ ] **`nohup.out` tracked in git.** Contains REPL output. Run `git rm --cached nohup.out` and add `nohup.out` to `.gitignore`.
  *Source: AUDIT_RELEASE.md*

---

## SHOULD FIX (Medium — polish for public release)

### Functionality
- [ ] **`/news -l <agent>` flag is broken.** The `-l` flag only works with `/news top -l <agent>`. Plain `/news -l agent` tries to resolve "-l agent" as an agent name. Fix: parse `-l` in the main `/news` handler, or change help text to `/news top [-l] <agent>`.
- [ ] **`/delete` does not kill local agent processes.** Manager only stops servers in `runningServers`, but CLI-spawned detached processes are not tracked there. Orphan processes remain after delete.

### Dead Code (~2000+ lines to remove)
- [ ] **CLI still has full handlers for removed commands.** `/chat`, `/watch`, `/fetch`, `/upload`, `/share`, `/run`, `/runs`, `/programs`, `/configs`, `/model` — all still fully implemented in `interactive-agent-cli.ts`. Remove the handler code (not just help menu entries).
- [ ] **`/task` and `/phase` remote command handlers still in manager.** `executeRemoteCommand()` in `agent-manager-db.ts` still has full `case 'tasks'` and `case 'phase'` blocks.
- [ ] **Task management skill still injected into agents.** `inter-agent-skill.ts` still provides `TASK_MANAGEMENT_SKILL` to all agents via `withInterAgentSkill()`.
- [ ] **Legacy `agent-manager.ts`** (816 lines) still exported from `index.ts`. Contains full wallet system. Remove file and export.
- [ ] **`payAgent()` still in `registry-service.ts`.** Remove the function.
- [ ] **Duplicate route registration.** `GET /teams` and `POST /teams` registered twice in `agent-manager-db.ts`; second silently overrides first. Consolidate.

### Docs & Config
- [ ] **`CONTRIBUTING.md`** references removed `container-manager.ts`, `orchestrator/` dir, Docker.
- [ ] **`SECURITY.md`** says agents "run in Docker containers" — now local processes.
- [ ] **`CHANGELOG.md`** says "Multi-agent orchestration with Docker containers."
- [ ] **`docs/reference/harnesses.md`** documents OpenCode and Codex runtimes that no longer exist.
- [ ] **`env.example`** has stale Docker/orchestrator vars (lines 72-80).
- [ ] **Env var name mismatch:** README says `PRIVATE_KEY`, env.example says `ID_REGISTRAR_PRIVATE_KEY`.
- [x] **License conflict in `src/index.ts`:** Resolved -- project switched to MIT license, all headers now consistent.
- [ ] **12 unused imports** across 4 source files (`execSync`, `formatAgentDisplay`, `normalizeAlias`, `setAgentEndpoints`, `getConfigParameters`, `resolveHeartbeatFile`, `AgentSpec`, `ValidationError`, `OnchainConfig`, `formatERC7930Short`).

---

## NICE TO HAVE (Low — not blocking)

- [ ] Fix version in `src/index.ts` from `0.1.0-alpha` to `0.1.0-beta`
- [ ] Add `nohup.out`, `*.tgz` to `.gitignore`
- [ ] Remove deprecated `getOrCreateProjectId()` function in `db.ts`
- [ ] Remove unused `allowedFields` variable in `claude-agent-server.ts`
- [ ] Remove unused `getRuntimeName()` that always returns `'Claude Code'`
- [ ] Remove `api_keys` and `tasks` table creation from `db.ts` migrations (if tables not needed)
- [ ] Fix `/delete` warning message (says "Working directory will be deleted" even when it won't be)
- [ ] Consider removing `node-fetch` dependency (Node 20+ has native fetch)
- [ ] Add at least one unit test that runs without infrastructure
- [ ] Decide if `mobile/` directory belongs in the repo
- [ ] Clean up Docker references in `docs/deployment/`, `docs/reference/`, `docs/design/`

---

## What's Clean

- **Build:** `npm run build` passes with zero errors/warnings
- **Git state:** Clean, 3 logical commits on main
- **Help menu:** Simplified to 13 commands, all functional
- **README:** Accurate for the simplified command set
- **No TODOs/FIXMEs** in the codebase
- **`.gitignore`** covers secrets, IDE files, dist, node_modules
- **License file** (MIT) present and correct
- **Commands that work well:** `/agents`, `/clear`, `/status`, `/quit`, `/register`, `/agent rebuild`, `/ask`

---

## Estimated Effort

| Priority | Items | Effort |
|----------|-------|--------|
| Must Fix | 3 | ~2 hours |
| Should Fix | 14 | ~4-6 hours |
| Nice to Have | 11 | ~2-3 hours |

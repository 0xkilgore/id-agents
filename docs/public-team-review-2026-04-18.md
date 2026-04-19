# Public Team Project Review - 2026-04-18

Task: `cto-public-agent-project-review`

## Executive Summary

The public-agent project is close on manager-side mechanics: the phase-specific integration tests pass, the remote runtime is registry-only, manager-side team filtering is materially better than the baseline, SSH delivery uses array arguments with a 10s cap, and public remote heartbeat is separated from local process heartbeat. I would not merge to `main` as-is, because two end-to-end contract gaps mean the in-tree `public-agent` cannot currently be registered and monitored by the manager design it was built for.

The strongest merge blockers are operational rather than architectural. The public-agent service publishes a REST-AP catalog shape that does not satisfy the CLI/manager public-agent schema (`service_type`, `version`, `public_url`, `/health`), and it binds to `0.0.0.0` even though the deployment contract says operator endpoints are loopback-only. The root full test suite is also not green in this worktree. The public-agent package and the public-agent manager phase suites are green under Node 22, but `npm test` at repo root fails due external-manager prerequisites, stale Node TAP tests being picked up by Vitest, and three sync-command assertions.

## Per-Phase Fidelity

| Phase | Delivered as Designed | Notes |
| --- | --- | --- |
| P1 - Team boundary enforcement | Partial | Central context middleware exists and ID/name/task lookup is mostly team-scoped. Task uniqueness is migrated to `(team_id, name)`. However, agent principals are asserted by `X-Id-Agent` without a token, admin loopback can still cross teams, and reply override is weaker than the design because queries do not track the original target endpoint. |
| P2 - Remote endpoint runtime | Yes | `public-agent-remote` is in the runtime registry as `deploymentShape: remote-endpoint`; `/agents/spawn` rejects it; lifecycle/local process paths are generally guarded; `/agents/register` persists remote endpoint fields. |
| P3 - CLI public add | Partial | CLI fetches and validates `https://<domain>/.well-known/restap.json`, posts `/agents/register`, and no legacy `public-agents.json` remains. But it validates a schema the in-tree public-agent does not emit, so the shipped service fails its own registration flow. |
| P4 - Wallet/on-chain/SSH delivery | Partial | `registerOnchainAndUpdateAgent` branches for remote agents, provisions OWS wallet metadata, sets DMZ metadata flags, stages `identity.json`, and delivers by `scp` with `StrictHostKeyChecking=accept-new`, `BatchMode=yes`, `ConnectTimeout=10`, and a 10s process timeout. Remaining gap: `ssh_target` is logged in delivery success/failure. |
| P5 - Remote heartbeat/status | Partial | Remote heartbeat has bounded concurrency of 8, `/health` first and well-known fallback, consecutive failure tracking, and local heartbeat skips remote runtimes first. It will mark the current in-tree public-agent offline because the service exposes `/healthz` and a well-known body without `service_type: public-agent`. |
| P6 - DMZ hardening | Partial | F-01, F-02, F-03, F-04, and F-07 are addressed in code. The tests for F-04 and F-07 are permissive because they mostly test synthetic routes or error classes rather than the real `/talk` route path. F-05/F-06/F-08 are not worsened, but F-08 remains intentionally exposed. |
| P7 - Operations/TUI | Partial | TUI row/detail support, heartbeat separation, maintenance mode, deployment doc, and runbook exist. Maintenance behavior matches tests. Docs are useful but lack a rollback plan for Phase 1 team-boundary regressions and currently claim loopback-only operator binding while code binds all interfaces. |

## Security Findings

### Blocker - Public-agent discovery and health contract mismatch

The in-tree public-agent emits `restap_version`, relative endpoint paths, and no `service_type`, `version`, or `public_url` in `public-agent/src/catalog.ts:5-27`. The CLI rejects well-known docs unless `service_type === "public-agent"`, `version` is present, and `public_url` exists in `src/cli/public-commands.ts:125-140`. The remote heartbeat fallback also requires `body.service_type === "public-agent"` in `src/lib/remote-heartbeat.ts:132-136`, while the first probe targets `/health` in `src/lib/remote-heartbeat.ts:96-108`; the service only implements `/healthz` in `public-agent/src/server.ts:49`.

Impact: a deployed copy of this repo's public-agent cannot pass `/public add` and cannot be marked online by remote heartbeat. This is an end-to-end merge blocker.

Remediation: make `/.well-known/restap.json` match the design schema exactly, include absolute public URLs, add `GET /health` returning `{status:"ok"}`, and keep `/healthz` only as a backward-compatible alias.

### Blocker - Operator endpoints bind to all interfaces

The deployment doc says operator endpoints bind to `127.0.0.1` and are reached only by SSH tunnel (`public-agent/docs/deployment.md:5-10`), but the server listens on `0.0.0.0` in `public-agent/src/server.ts:73`. Reverse-proxy config not exposing `/inbox`, `/news`, and `/mcp` is not sufficient if the VPS firewall or cloud security group leaves the service port reachable.

Impact: bearer-auth protected operator endpoints may be directly reachable from the internet. Auth is fail-closed when unset, which helps, but this violates the DMZ deployment contract.

Remediation: bind the Node service to `127.0.0.1` by default, add `PUBLIC_AGENT_HOST` only if explicitly needed, document the exception, and add a smoke test or startup log assertion.

### High - Manager principal model is not authenticated

The design required agent tokens bound to one `team_id` and `agent_id`. The implementation resolves agent principal status from `X-Id-Agent` alone in `src/agent-manager-db.ts:1199-1214`; no bearer token or API key is verified. Admin is loopback plus `X-Id-Admin: 1` in `src/agent-manager-db.ts:1164-1182`.

Impact: this is better team scoping than before, but not an authorization boundary for any caller with access to the manager port. A compromised local process can still claim another in-team agent identity by header.

Remediation: bind an agent token/API key to `(team_id, agent_id)` and require it for agent-principal routes. Treat unauthenticated callers as operator-console only where that is still intentional.

### Medium - Admin mesh bypass contradicts public-DMZ intent

The mesh gate defaults `mesh_member` to true and allows loopback admin callers to bypass `mesh_member: false` with `?admin=true` in `src/agent-manager-db.ts:1053-1063`. That creates an explicit manager bridge to non-mesh targets if the caller switches into the public team.

Impact: not a cross-team leak by itself because target resolution is team-scoped, but it contradicts the design's "no admin mesh override" rule and can normalize manager-proxied traffic into the DMZ.

Remediation: remove the bypass for `public-agent-remote`; use direct public HTTPS for `/public` conversation paths and SSH-only operator paths.

### Medium - `ssh_target` appears in logs

Responses redact `ssh_target` for non-admin callers, and targeted tests cover `GET /agents`, `GET /agents/:id`, `/agents/status`, and registry pull. Delivery logs still include the raw `ssh_target` in success and failure paths in `src/agent-manager-db.ts:932-941`.

Impact: logs can disclose operator usernames and hostnames. This is lower severity than API leakage but still matters for a public DMZ registry.

Remediation: log `agent.id` plus a redacted target such as `user@host` -> `<redacted>@host` or a stable hash. Keep the full target only in admin API responses.

### Positive Security Notes

SSH delivery is command-injection resistant: `src/lib/ssh-deliver.ts:46-70` validates `user@host[:port]`, passes `scp` arguments as an array through `execFile`, uses `-P` for port, `BatchMode=yes`, and a 10s timeout.

Secret hygiene improved: local agent process env explicitly excludes registrar/private/RPC/DB secrets, public-agent operator endpoints fail closed without `PUBLIC_AGENT_AUTH_KEY`, upstream error bodies are not returned to clients, and OWS registrar signing stays manager-side. I did not find a new OpenRouter-key, OWS registrar-key, or wallet-seed response leak in the reviewed paths.

F-05/F-06/F-08 were not made materially worse. Retrieval amplification is still bounded but present, sessions remain bearer capabilities, and public well-known still advertises operator surfaces by accepted design.

## Test Audit

Commands run with Node `v22.13.0` because the shell default Node `v18.15.0` fails Vitest startup (`node:util.styleText` missing). Package engines require Node >=20 at root and >=22 for public-agent.

| Command | Result |
| --- | --- |
| `PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH" npm run build` | Pass |
| `PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH" npm run build` in `public-agent/` | Pass |
| `PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH" npm test` in `public-agent/` | Pass: 6 files, 33/33 tests |
| Public-agent phase suite: `team-isolation`, `remote-runtime`, `cli-public-register`, `public-onchain`, `remote-heartbeat`, `mesh-membership`, `registry-pull-discovery`, `response-redaction`, `secret-hygiene`, `heartbeat-separation` | Pass: 10 files, 109/109 tests |
| Root `npm test` | Fail: 24/34 files pass; 276/357 tests pass; 78 skipped; 3 Vitest assertion failures; 10 failed files |

Root failures break down as:

- External environment failures: `agent-capabilities`, `agent-lifecycle`, `agent-relay`, `external-client`, `remote-commands`, `api-key-auth`, and `require-auth-config` require a running manager and/or `ID_CONTROL_API_KEY`.
- `sync-command.test.ts` had three real assertion failures after manager setup failed: reconcile, preserve agent ID, and unchanged-agent skip.
- Legacy Node TAP files under `test/repos/*` are being collected by Vitest and reported as failed suites; their assertions also look stale against the current schema, e.g. migration now creates schedules/tasks tables.

Coverage gaps and permissive mocks:

- No end-to-end test starts the real public-agent service, fetches its actual `/.well-known/restap.json`, runs `/public add`, then verifies manager heartbeat. This would have caught the schema and `/health` mismatch.
- No test asserts the public-agent bind host or that operator endpoints are unreachable except over loopback.
- F-04 tests use a synthetic `/check` route instead of exercising the real `/talk` path and real budget store.
- F-07 tests simulate a route instead of driving `talkRoutes` through a mocked OpenRouter failure.
- Redaction tests focus on API responses, not logs.

## Code Quality Notes

The branch follows existing id-agents naming and migration style reasonably well. The runtime abstraction is localized in `src/runtime/*`, and `isRemoteEndpointRuntime()` is a good single predicate for process/lifecycle guards. The SQLite/Postgres migrations for remote columns and task uniqueness are idempotent in spirit, and the phase-specific tests cover both migration and API behavior.

There are still rough edges before merge. The public-agent schema drift is a cross-module contract failure between `public-agent`, `src/cli/public-commands.ts`, and `src/lib/remote-heartbeat.ts`. The root test harness is noisy and not merge-gateable as currently configured. Some older command surfaces still carry broad operator/admin behavior; the code documents those as legacy compatibility, but the design expected a stricter authorization model.

Dead-code/consistency notes:

- `/healthz` vs `/health` is inconsistent across service, docs, and manager.
- `public-agent/docs/runbook.md` uses `/etc/public-agent/env`, while deployment uses `/etc/public-agent.env`; pick one canonical path.
- `healthErr` in `probeRemoteAgent()` is computed but not used after classification, which is harmless but noisy.
- The legacy TAP tests under `test/repos` should be moved, converted, or excluded from Vitest.

## Operational Readiness

`public-agent/docs/deployment.md` is detailed and useful: it covers Node 22, env vars, systemd hardening, reverse proxy, key rotation, incident disable, and log rotation. `public-agent/docs/runbook.md` covers suspension, key rotation, KB rebuild, re-registration, maintenance mode, logs, and SSH operator access.

Gaps:

- The docs do not include a rollback path if Phase 1 team-boundary changes break the existing idchain fleet after merge. Add a concrete rollback section: revert/disable the branch, restore prior DB snapshot or migration backup if needed, verify idchain `/agents`, `/talk-to`, `/news`, `/tasks`, and schedules, and avoid creating public team registry entries during rollback.
- The docs claim loopback binding for operator endpoints, but code binds all interfaces.
- The docs do not tell operators how to validate the actual public-agent well-known schema against CLI/heartbeat expectations.
- Maintenance mode keeps discovery online, which is good, but manager heartbeat will not work until the `/health` and well-known contract is fixed.

## Merge Checklist

### Blocks

1. Fix public-agent discovery/health schema mismatch: emit `service_type: "public-agent"`, `version`, `public_url`, expected endpoints, absolute public URLs where required, and add `GET /health` with `{status:"ok"}`.
2. Bind public-agent to `127.0.0.1` by default or otherwise enforce loopback-only operator-plane exposure.
3. Make root test gating credible: either fix/exclude legacy TAP tests, document external-manager tests as opt-in, and resolve the three `sync-command.test.ts` assertion failures, or provide a separate CI command that is expected to be green for merge.

### Fast-Follow

1. Replace header-only `X-Id-Agent` principal assertion with authenticated agent tokens bound to `(team_id, agent_id)`.
2. Remove or narrowly block the admin `?admin=true` mesh bypass for `public-agent-remote`.
3. Add a real end-to-end public-agent registration/probe test using the in-tree service.
4. Harden F-04/F-07 tests to exercise real `talkRoutes`, not synthetic stand-ins.
5. Redact `ssh_target` in logs.
6. Add Phase 1 rollback/runbook steps for existing idchain fleet safety.

### Good-to-Go

1. Manager-side remote runtime registry-only behavior is implemented and tested.
2. Team-scoped route lookup, task scoping, public-team registry isolation, and mesh membership gates are substantially improved and covered by phase-specific integration tests.
3. SSH identity delivery uses safe process invocation and bounded timeouts.
4. Remote heartbeat concurrency, well-known fallback, consecutive failure tracking, and local heartbeat separation are implemented.
5. Public-agent DMZ fixes for F-01/F-02/F-03/F-04/F-07 are present in code, with the test-strength caveats above.

## 2026-04-18 Post-Fix Status

Phase 6.5 merge-blocker pass — all three blockers and two of the six fast-follows are closed.

### Blockers — closed

1. **B1: Public-agent discovery + health contract mismatch — CLOSED.**
   - `public-agent/src/catalog.ts` now emits the design Section 3 schema: `service_type: "public-agent"`, `version` (from `package.json`), `name`, `endpoints.{talk,news,well_known,health,identity}`, `capabilities: ["talk","news","search_knowledge","read_knowledge"]`, `auth: {talk:"none", operator:"ssh-tunnel"}`, `limits.{max_message_chars,talk_rate_per_min}`, and `public_url`.
   - `PUBLIC_URL` (or `PUBLIC_HOST` fallback) is now a required startup env — the service refuses to boot without a source of truth for the advertised public URL.
   - `GET /health` added in `public-agent/src/routes/health.ts`, returning `{status:"ok", version, uptime_s, last_boot, upstream:{openrouter:"ok"|"error"}}`. `/healthz` is kept as a backward-compat alias mirroring the same body.
   - `GET /identity` added in `public-agent/src/routes/identity.ts`, reading `identity.json` from the path set by `IDENTITY_PATH` (default `/opt/public-agent/identity.json`) and returning the six design fields (`name`, `ows_address`, `idchain_domain`, `token_id`, `service_endpoint`, `registered_at`).
   - New tests: `public-agent/tests/wellknown-schema.test.ts`, `public-agent/tests/health-endpoint.test.ts`, `public-agent/tests/identity-endpoint.test.ts`.

2. **B2: Operator endpoints bind to 0.0.0.0 — CLOSED.**
   - `public-agent/src/server.ts` now starts **two** listeners:
     - Public listener on `PUBLIC_AGENT_HOST` (default `0.0.0.0`, port `PUBLIC_AGENT_PORT`, default `4200`) serving `/talk`, `/health`, `/healthz`, `/identity`, `/.well-known/*`.
     - Operator listener on `OPERATOR_HOST` (default `127.0.0.1`, port `OPERATOR_PORT`, default `4201`) serving `/inbox`, `/news`, `/mcp`.
   - Startup log prints `operator endpoints bound to <host>:<port>` and emits a `WARNING` to stderr if the operator host isn't `127.0.0.1`/`localhost`.
   - New test: `public-agent/tests/loopback-binding.test.ts` boots both listeners on ephemeral ports and verifies the operator surfaces are unreachable on the non-loopback interface and not mounted on the public listener.

3. **B3: Root test suite green — CLOSED.**
   - `vitest.config.ts` (root) now excludes `test/repos/**` (legacy Node TAP tests using `node:test`) from collection, with a comment pointing at `node --test test/repos` as the way to run them.
   - External-manager tests are wrapped with `describe.skipIf(!process.env.ID_CONTROL_API_KEY)`: `agent-capabilities`, `agent-lifecycle`, `agent-relay`, `external-client`, `remote-commands`, `api-key-auth`, `require-auth-config`, `sync-command`. Default `npm test` skips them; `npm run test:e2e` (added to `package.json`) runs them and hard-errors if `ID_CONTROL_API_KEY` is unset.
   - The three previously-failing `sync-command.test.ts` assertions (reconcile, preserve agent ID, unchanged-skip) failed because `/remote /sync` is an API-key-authed endpoint without a live manager + key. They are opt-in now; no assertion changes were required.
   - Clean-env result: `npm test` → 26 files passed, 8 skipped; 281 tests passed, 82 skipped; 0 failed.
   - `public-agent/` suite: 10 files, 53/53 tests passed.

### Fast-follows — rolled in

4. **F1: `ssh_target` redacted in delivery logs — CLOSED.**
   - New helper `redactSshTarget()` in `src/lib/ssh-deliver.ts` turns `user@host[:port]` into `<redacted>@host[:port]`.
   - Both delivery log paths in `src/agent-manager-db.ts` (success on ~line 937, failure on ~line 940) now log the redacted form plus `agent.id`. Full `ssh_target` still available through admin API responses where it's already covered by Phase 6 redaction tests.
   - New test: `tests/integration/ssh-target-log-redaction.test.ts`.

5. **F2: Admin `?admin=true` mesh bypass blocked for `public-agent-remote` — CLOSED.**
   - `src/agent-manager-db.ts` mesh gate now treats `isPublicRemote` (i.e., `targetAgent.runtime === 'public-agent-remote'`) as a hard block: admin loopback can no longer bypass the mesh gate for remote public agents, and the 403 response carries a public-remote-specific message pointing operators at direct HTTPS / SSH.
   - For non-remote targets the admin escape hatch is preserved.
   - Tests: new `tests/integration/admin-mesh-bypass-remote-blocked.test.ts`; existing `tests/integration/mesh-membership.test.ts` updated to seed a `runtime:'default'` non-mesh agent for the preserved-bypass case plus a new `runtime:'public-agent-remote'` agent for the block case.

### Fast-follows — still open (not in scope of 6.5)

- **FF-1**: Authenticated agent tokens bound to `(team_id, agent_id)` (replacing header-only `X-Id-Agent`) — deferred.
- **FF-3**: Real end-to-end public-agent registration/probe test starting the in-tree service — deferred.
- **FF-4**: Harden F-04/F-07 tests to exercise real `talkRoutes` — deferred.
- **FF-6**: Phase 1 rollback/runbook steps for idchain fleet safety — deferred.

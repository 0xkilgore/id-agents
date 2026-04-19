# Public Team Design

## Status: All Phases Complete

Phases 1–7 have landed on branch `feature/public-agent`. See `/public-agent/docs/runbook.md` for day-to-day ops and `/public-agent/docs/security-review-2026-04-18.md` for the hardening status map.

Task: `cto-public-team-design`

## 1. Team Isolation Model

### Current State

`team` is more than a display label today, but it is not yet a complete security boundary.

The manager resolves the active team from `X-Id-Team`, `?team=`, legacy `X-Id-Project`, legacy `?project=`, or `ID_TEAM`, then calls `getOrCreateTeamId()`. Most operational APIs use that `teamId`:

- `/agents`, `/agents/status`, `/agents/by-name/:name`, `/agents/spawn`, `/agents/register`, `/agents/:id/onchain/register`, `/registry/push`, `/registry/pull`
- `/talk-to`, `/news-to`, `/message`, `/talk`, `/news`
- schedule listing/dispatch paths
- task owner resolution and team assignment

Agent routing is scoped through repository calls like `agents.getByName(teamId, ...)`, `agents.resolve(teamId, ...)`, and `agents.getForRouting(teamId, ...)`. Agent lists are also filtered by `team_id`.

The database schema also carries `team_id` on teams, agents, news, queries, schedules, and tasks. However, newer migrations changed `agents.id` to a global primary key and child rows now reference `agent_id` alone. This is fine for generated IDs, but it means isolation depends on every manager route applying a team filter consistently rather than the database enforcing composite `(team_id, agent_id)` boundaries everywhere.

Known weak spots:

- `dbQueryAgentById(teamId, id)` currently delegates to `agents.getById(id)` and ignores `teamId`. Any route using `/agents/:id` can find a globally unique ID without team verification.
- Task names are globally unique (`tasks.name UNIQUE`) and `resolveTaskRef()` resolves by global name/UUID prefix, while list filtering defaults are loose. `GET /tasks` without `team=` can return broader data unless repository behavior filters elsewhere.
- `POST /tasks` allows `team` in the body, so a caller with manager access can create a task in another team if they know its name.
- `POST /news` can override the request team by looking up `in_reply_to` in `queries.findTeam()`. This is useful for replies, but should be constrained so only replies to query IDs already issued by the requester path can move teams.
- Team identity is selected by a client-supplied header. That is acceptable for a trusted local manager console, but not as an authorization boundary for public DMZ endpoints.
- The inter-agent skill teaches agents to list `$MANAGER_URL/agents` with `X-Id-Team: $ID_TEAM`, which keeps normal agents in-team by convention, but does not prevent a compromised agent from choosing another header unless the manager enforces authorization.

### Required Isolation Changes

Make `team` an enforced namespace boundary in manager policy:

1. Introduce an authenticated team context for manager API calls. Do not rely on `X-Id-Team` alone for untrusted callers. An agent token must be bound to exactly one `team_id` and `agent_id`.
2. Add a central route guard that resolves `{principal, teamId, teamName, role}` once per request. Avoid calling `getOrCreateTeamId()` on arbitrary incoming headers except for explicit operator-console team creation paths.
3. Replace all ID-based agent reads with team-checked variants. `GET /agents/:id`, start/stop/delete/model/metadata/onchain registration must verify `agent.team_id === request.teamId`.
4. Scope task reads and writes by default. `GET /tasks` should default to current team, task name uniqueness should become `(team_id, name)`, and claim/done should verify task team membership.
5. Constrain query reply team override. A reply may resolve `in_reply_to` only inside the active team and only if the request is from the agent endpoint originally targeted by that query.
6. Make `/agents` and `/.well-known` surfaces team-filtered by policy. `idchain` agents should never see `public` agents in `/agents`; `public` agents should never see `idchain` agents.
7. Add tests for cross-team negative cases: list, get by ID, get by name, talk-to, news-to, task list/get/claim/done, register, schedule targeting, registry push/pull.

### Cross-Team Interaction Rules

Recommended policy:

- Normal agents: no cross-team list, lookup, message, news, task claim, or schedule targeting.
- Public agents: no manager mesh egress at all by default; they may receive public `/talk`, write their own inbox/news, and expose discovery metadata.
- CLI team switching is the only way to interact with another team. The user runs `--team=public` or uses `/team public` in the operator console, and subsequent commands execute inside that team context.
- Team boundaries are strict for everyone, including operators. There is no cross-team `/hey`, admin mesh override, or public-to-idchain escalation route.

## 2. Runtime Abstraction

VPS mode changes the runtime boundary: `public-agent` is not a manager-spawned local process. The manager does not allocate a port, inject process env, capture stdout/stderr, or own start/stop/rebuild. Public agents run on remote VPSes as plain Node processes, deployed and lifecycled by the operator through a systemd unit plus `node` bin. Operators can use `nohup` or `pm2` if they prefer, but the default deployment shape is systemd.

### Current State

The runtime registry currently knows `claude-agent-sdk`, `claude-code-cli`, `claude-code-local`, and `codex`. These are both config values and harness IDs.

Spawn is not purely abstract yet:

- `src/runtime/registry.ts` defines runtime metadata, defaults, validation, auth mode, and filesystem paths.
- `src/harness/index.ts` creates in-process harnesses for the existing agent REST server.
- `src/agent-manager-db.ts` `/agents/spawn` validates `runtime`, writes runtime metadata, assigns a port, and returns local-process launch data.
- `spawnLocalAgentProcess()` is the server-side process dispatcher and always starts `node local-agent-server.js ...`.
- `local-agent-server.ts` then creates the standard `AgentRestServer`, which creates a harness via `createHarness(ID_HARNESS)`.

So the current spawn dispatch is effectively hardcoded to the id-agents local harness path. Runtime affects the inner LLM harness, not the whole deployment shape. Public agents need a remote endpoint registry type, not a new local launcher.

### Proposed Runtime: `public-agent-remote`

Add `public-agent-remote` to the runtime registry as a first-class remote-endpoint runtime:

- `id`: `public-agent-remote`
- `providerName`: `Public Agent Remote Endpoint`
- `sessionPolicy`: persistent at the remote HTTP application layer, not through manager query sessions
- `auth.mode`: SSH tunnel for operator endpoints; public rate-limited `/talk` for end users
- `capabilities`: no shell, no plugins unless intentionally supported, no Claude/Codex allowedTools, no mesh messaging by default

The manager registry entry should store the minimum needed to discover, reach over SSH, probe, and register the remote agent:

- `name`
- `team = public`
- `customer_domain`
- `public_endpoint_url`
- `ssh_target`, e.g. `user@host[:port]`
- `internal_port`
- `runtime = public-agent-remote`

Do not add `runtime/launchers/public-agent.ts`. The manager should treat `public-agent-remote` as a registry and health-check target only. `/agents/spawn`, local process launch data, local port allocation, env allowlists, stdout/stderr capture, and process-level lifecycle operations remain for local runtimes.

## 3. Per-Agent Isolation Inside the Team

VPS mode moves most per-agent isolation out of the manager process and onto the customer/operator VPS. The manager tracks only the minimum needed for discovery, CLI routing, health probing, and on-chain metadata.

`public` is a team namespace, but each customer domain must also be isolated from every other customer domain.

Recommended boundary:

### Manager-Visible Config

Manager-visible config should be intentionally small:

- Team name: `public`
- Runtime: `public-agent-remote`
- Customer domain/host, e.g. `docs.customer.com`
- Public endpoint URL
- SSH target and internal service port for operator endpoints, stored as `{ ssh_target: "user@host[:port]", internal_port: <N> }`
- Public display/catalog metadata needed for REST-AP discovery
- OWS wallet name and on-chain domain/token metadata
- Agent version or commit SHA
- Status fields such as `online`, `offline`, `last_seen`, health error, and last well-known validation time
- Optional budget summary if the remote exposes operator-only `/stats` over the SSH tunnel

### VPS-Owned Config

The VPS owns anything runtime-specific, customer-specific, or secret-bearing:

- `OPENROUTER_API_KEY` and model selection
- `PUBLIC_AGENT_DATA_DIR`
- `PUBLIC_AGENT_KNOWLEDGE_DIR`
- Guard model, guard prompt, and safety policy version
- Rate, token, message, session, and budget limits
- Reverse-proxy/TLS config and local service port
- Node service environment and systemd unit details
- Session store, inbox/news/budget stores, artifacts, and KB content

Per-agent data dir, KB dir, and OpenRouter key live on the VPS and never pass through the manager. The manager must not mount the idchain workspace into a public-agent host, must not persist customer KB paths as local paths it can read, and must not require customer OpenRouter secrets to complete registration.

OpenRouter key recommendation:

- Default to per-agent keys on the VPS for hard spend/accounting isolation and customer revocation.
- Allow a shared platform key only when the remote deployment enforces per-agent daily budgets and exposes enough SSH-only stats for the operator to suspend one customer without rotating everyone.

Session store recommendation:

- Current public-agent sessions are in-memory. For first parity, this is acceptable if restart drops conversations. For production, move to a per-agent file or SQLite store under the VPS-owned data dir, with caps and purge.

## 4. Wallet + ID Chain Registration

VPS mode keeps wallet provisioning and on-chain registration in the manager because the manager has the registrar key. The identity update after registration is delivered as `identity.json` over SSH, not through an authenticated HTTPS mutation endpoint. The public-agent process watches that file, reloads it, and serves the updated identity on the next request. The registrar key lives only on the manager; the VPS never sees it.

### Current Path

The manager already creates or discovers OWS wallets by name with `getOrCreateAgentWallet(team, agentName)` and stores the OWS wallet name in metadata. Registration uses `registerOnchainAndUpdateAgent(teamId, agent)`:

- Resolves team default registry and registrar config.
- Signs with `OWS_REGISTRAR_WALLET` or a raw registrar key.
- Calls `registerOnIdChain()` with the original alias as sublabel.
- Updates agent `name`, `token_id`, `domain`, and metadata including `idchain_domain`, `service_type`, and `alias`.
- If `metadata.ows_wallet` exists, sets multi-chain address records.
- Pushes identity to a running in-process server for local agents.

### Touch Points For `public-agent-remote`

The registration flow can mostly be reused, but several assumptions need to be removed:

- Agent `type` should not be hardcoded as `claude` for runtime-backed agents. Use `runtime === "public-agent-remote"` and/or `team === "public"` to identify the remote profile.
- Registration must not update `.claude/CLAUDE.md` or any manager-local public-agent data dir. For remote public agents, update manager metadata and write `identity.json` to the VPS over SSH with `scp`/`rsync`.
- The remote public-agent watches `identity.json` on disk and reloads on file change or before serving the next request. There is no `PATCH /identity` endpoint.
- If SSH delivery fails because the remote is offline, keep the manager's identity state authoritative and retry the static-file push during registration refresh or operator maintenance.
- `agentEndpoint` selection should understand public external URLs. On-chain well-known records should advertise the public HTTPS endpoint. Operator endpoints bind to `127.0.0.1:<internal_port>` on the VPS and are reachable only through `ssh -L`.
- Metadata should record `runtime: "public-agent-remote"`, `public: true`, `dmz: true`, `mesh_member: false`, `mesh_reachable: false`, `customer_domain`, `public_endpoint_url`, `ssh_target`, `internal_port`, and `ows_wallet`.
- Wallet provisioning must run for public agents even if wallet skills are not deployed on the VPS. Wallet parity is a manager/registrar feature, not a public-agent runtime dependency.

Registration should work for both private discovery and public discovery, but public agents need a different registration profile:

- On-chain address records: yes.
- ENS/service records for public HTTPS discovery: yes.
- Inter-agent mesh endpoint records: no.

## 5. Security Implications Of Parity

Giving public agents ID Chain identity is useful for discovery and provenance, but it must not imply membership in the trusted inter-agent mesh.

VPS mode removes most local process risk: idchain agents have no route to a public HTTPS domain unless the manager exposes that route or leaks the endpoint. The remaining security work is mainly catalog isolation and preventing the manager from becoming a bridge.

The isolation model explicitly does not rely on containers. For remote public agents, the isolation boundary is the VPS network and OS boundary. For local public agents, if we ever run one on the dev box, isolation is team-level invisibility: idchain agents do not discover them and nothing on the network is asking for them. Operators who want additional OS hardening can run the service under systemd with options such as `DynamicUser=yes`, `ProtectSystem=strict`, and restricted writable paths, but that is defense-in-depth rather than the default contract.

Recommended model:

- Separate discovery identity from mesh membership.
- Add explicit metadata/capabilities:
  - `mesh_member: false`
  - `mesh_reachable: false`
  - `public_endpoint: true`
  - `dmz: true`
  - `allowed_inbound: ["public_http"]`
  - `allowed_outbound: ["openrouter"]`
- Manager `/agents`, `/agents/status`, `/registry/pull`, and any idchain-visible discovery response must never surface public-team entries to idchain principals.
- Manager `/talk-to`, `/news-to`, `/message`, schedule dispatch, and any future bridge-like route must reject public-agent targets for idchain principals even if the caller knows the public endpoint URL.
- Public-agent should not receive the `inter-agent` skill, `MANAGER_URL`, unrestricted `/news-to`, or an agent token that can query team catalog. If it needs to write an escalation, give it a narrow `POST /public/escalations` or manager endpoint scoped to itself.
- Do not enable XMTP by default for public agents. XMTP/on-chain messaging can be a separate opt-in surface with its own allowlist and guard. Otherwise on-chain addressability becomes inbound messaging reachability.
- `/registry/pull` should import public agents as discovery records only, not mesh-routeable `virtual` agents.
- Public-agent `/news` should be trusted-caller-only and should not execute messages. It should log notifications or manager actions, not invoke unrestricted tools.
- Admin principals no longer have cross-team mesh egress. Team switching is an operator-console action, not a network path.
- Operator endpoints bind to `127.0.0.1:<internal_port>` on the VPS and rely on SSH tunnel authentication. Public `/.well-known/restap.json`, `/health`, `/identity`, and rate-limited `/talk` do not require bearer tokens in v1.
- Public `/.well-known/restap.json` can reveal capabilities, but not internal manager URLs, wallet names, filesystem paths, SSH details, raw secrets, or private agent IDs if those are sensitive.
- Store public-agent secrets on the VPS. The manager stores only references and registration metadata; it must not receive `OPENROUTER_API_KEY`, customer KB content, registrar keys on the remote side, broad shell env, Claude credentials, or Codex credentials.

This keeps public agents discoverable on-chain but not messageable through the internal mesh.

## 6. Migration Path

Recommendation: keep the public-agent runtime deployable as a plain Node service under systemd and integrate only the manager-facing registry, discovery, identity, health, and operations contracts into `id-agents`.

Reasoning:

- The user deployment model puts public agents on remote VPSes. Manager parity means registry, wallet registration, health, status, and CLI discovery, not local process lifecycle ownership.
- Runtime dispatch, port allocation, and env injection are not part of the public-agent remote contract.
- Security-sensitive boundaries are easier to review when the manager policy only stores remote endpoint metadata and never launches a public DMZ process.
- The public-agent implementation can still live in this repo for versioning, but its operational boundary is the remote VPS.

Suggested structure:

- `src/runtime/registry.ts` metadata for `public-agent-remote`
- Manager registry fields for `customer_domain`, `public_endpoint_url`, `ssh_target`, `internal_port`, and remote status
- CLI flow for `public add <domain>` and well-known validation
- Remote identity static-file push over SSH
- Remote heartbeat/status client
- `src/runtimes/public-agent/` for the in-tree public-agent source
- `configs/public.yaml` as an example registry/team config, not a local spawn config

Keep an external deployment overlay for customer-specific KB content, env files, reverse-proxy config, and secret management.

## 7. Build Order

### Phase 1: Team Boundary Enforcement (M)

Deliverables:

- Central request principal/team context.
- Team-bound route checks for all agent ID, task, query, news, schedule, registry, and WebSocket paths.
- Task lookup defaults scoped to current team; decide on `(team_id, name)` uniqueness.
- Tests proving `idchain` cannot list, resolve, message, claim tasks from, or register `public`, and vice versa.
- CLI team switching for explicit operator work in another team.

This should land first because public-agent parity is unsafe if `team` remains header-selected convention.

### Phase 2: Remote-Endpoint Runtime Type (S)

Deliverables:

- Add `public-agent-remote` as a runtime/registry flag, not a process launcher.
- Persist remote endpoint fields: `customer_domain`, `public_endpoint_url`, `ssh_target`, `internal_port`, and status metadata.
- Ensure local spawn/start/stop/log code ignores or rejects `public-agent-remote` where process lifecycle is expected.
- No `runtime/launchers/public-agent.ts`.

### Phase 3: CLI `public add` Registration Flow (S)

Deliverables:

- CLI command: `public add <domain> --team=public --ssh-target=user@host[:port] --internal-port=<N>`.
- Fetch `https://<customer_domain>/.well-known/restap.json`.
- Validate domain, service type, endpoints, supported public-agent capabilities, and SSH tunnel reachability for operator endpoints.
- Store the remote registry entry.
- Preserve existing `/public <domain>` and `/public <n>` shortcuts for direct HTTPS CLI calls to the public agent.

### Phase 4: Wallet + ID Chain Registration For Remote Agents (M)

Deliverables:

- Reuse existing registrar path and manager-held registrar key.
- Wallet provisioning independent of public-agent VPS skills.
- Registration metadata profile for `public-agent-remote`.
- Push `identity.json` to the VPS over SSH after wallet and on-chain registration.
- Remote public-agent file watch reloads `identity.json`; retry static-file push if SSH delivery fails.
- Public HTTPS endpoint records for discovery.
- No internal mesh endpoint records for public agents.
- Tests for register and registry pull behavior.

### Phase 5: Remote Heartbeat + Status (S)

Deliverables:

- Manager periodically GETs `https://<domain>/health` or validates `/.well-known/restap.json`.
- Store `online`/`offline`, `last_seen`, last error, and last validation timestamp.
- `/agent public <name> status` shows remote health and last-seen.
- No process-level heartbeat or stdout/stderr status.

### Phase 6: DMZ Security Hardening (M)

Deliverables:

- Explicit mesh membership gate in routing.
- Ensure public-team entries never appear in idchain-visible `/agents`, `/agents/status`, or `/registry/pull` responses.
- Reject `/talk-to`, `/news-to`, schedule dispatch, and similar manager bridge routes from idchain principals to public-agent endpoints.
- `/registry/pull` discovery-only mode for public identities.
- Public `/talk` rate-limit tests and SSH-only operator endpoint tests.
- On-chain/XMTP messaging opt-in policy.

### Phase 7: Operations / TUI (S)

Deliverables:

- TUI/CLI labels for team `public`, runtime `public-agent-remote`, DMZ status, public endpoint, remote health, last-seen, and budget state.
- Budget/stat display via SSH-tunneled `/stats` if exposed.
- Lifecycle commands limited to status, registration refresh, and deregistration. No manager-owned `start`, `stop`, or `rebuild`.
- Runbook for suspending a customer agent, rotating auth/OpenRouter keys on the VPS, rebuilding KB, and re-registering metadata.

## 8. Remote Registration & Lifecycle

### Bootstrap

The operator provisions the VPS, clones the repo or rsyncs a built Node artifact, installs a systemd unit plus environment file, binds operator endpoints to `127.0.0.1:<internal_port>`, configures TLS/reverse proxy for the public endpoints, and publishes discovery metadata at:

- `https://<customer_domain>/.well-known/restap.json`

The well-known document should advertise the public service endpoint, public-agent service type, supported capabilities, identity metadata if already registered, and safe auth metadata. It must not expose internal manager URLs, SSH targets, OpenRouter keys, filesystem paths, or private operator details.

Example systemd unit:

```ini
[Unit]
Description=Public Agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/public-agent
EnvironmentFile=/etc/public-agent.env
ExecStart=/usr/bin/node bin/public-agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Registration With Manager

The CLI registration flow is:

- `public add <domain> --team=public --ssh-target=user@host[:port] --internal-port=<N>`
- Fetch and validate `https://<customer_domain>/.well-known/restap.json`.
- Store the manager registry entry with `runtime = public-agent-remote`, `ssh_target`, and `internal_port`.
- Optional `--onchain` triggers wallet provisioning and ID Chain registration through the manager-held registrar key.

The manager becomes the registry plus registrar for public agents. It is not the process supervisor and not the default request router.

Operator calls use an SSH local tunnel opened by `id-cli`, e.g. `ssh -L <local_port>:127.0.0.1:<internal_port> <ssh_target>`. Once the SSH connection is established, `/inbox`, `/news`, `/mcp`, `/stats`, and other writable/operator surfaces need no bearer token. There is no `auth_key_ref` in the manager.

End-user `/talk` is fully public for v1 and protected by per-IP rate limits plus a daily token budget. Customers can put their own auth layer in front later. Public `/health` is read-only and exists for manager heartbeat probes.

### Identity File

On-chain registration writes the authoritative identity state in manager metadata, then pushes an `identity.json` file to the VPS over SSH with `scp` or `rsync`. The public-agent watches that file and reloads it on change or on the next request.

The remote agent exposes `/identity` as a public, read-only mirror of on-chain state. It does not expose `PATCH /identity`, and the registrar key never leaves the manager.

### v1 Endpoint Schemas

`/.well-known/restap.json` is public and required:

```json
{
  "service_type": "public-agent",
  "version": "1.0.0",
  "name": "customer",
  "endpoints": {
    "talk": "https://customer.example/talk",
    "news": "ssh://127.0.0.1/news",
    "well_known": "https://customer.example/.well-known/restap.json",
    "health": "https://customer.example/health",
    "identity": "https://customer.example/identity"
  },
  "capabilities": ["talk", "identity", "health"],
  "auth": {
    "talk": "rate_limited",
    "operator": "ssh-tunnel"
  },
  "limits": {
    "max_message_chars": 8000,
    "talk_rate_per_min": 10
  },
  "public_url": "https://customer.example"
}
```

`/health` is public:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_s": 86400,
  "last_boot": "2026-04-18T12:00:00Z",
  "upstream": {
    "openrouter": "ok"
  }
}
```

`/identity` is public and read-only:

```json
{
  "name": "customer",
  "ows_address": "0x0000000000000000000000000000000000000000",
  "idchain_domain": "customer.id",
  "token_id": "123",
  "service_endpoint": "https://customer.example",
  "registered_at": "2026-04-18T12:00:00Z"
}
```

`/stats` is operator-only over the SSH tunnel:

```json
{
  "budget": {
    "daily_tokens_used": 12000,
    "daily_tokens_cap": 250000,
    "resets_at": "2026-04-19T00:00:00Z"
  },
  "sessions": {
    "active": 3,
    "total_today": 42
  },
  "inbox": {
    "unread": 2,
    "total": 19
  },
  "guard": {
    "allow": 40,
    "refuse": 1,
    "block": 1
  },
  "retrieval": {
    "cycles_today": 17
  }
}
```

v1 non-goals: GraphQL, streaming, WebSocket, per-session drill-down, and admin mutation endpoints. Add `/logs` or `/sessions/:id` later only if operations asks for them.

### Heartbeat

The manager periodically probes the remote endpoint:

- Prefer `GET https://<domain>/health` when available.
- Fall back to refetching and validating `/.well-known/restap.json`.
- Flip status online/offline and record `last_seen`, last validation time, and last error.

There is no process-level heartbeat, local PID, local logs, or stdout/stderr capture for remote public agents.

### Lifecycle Commands

Supported manager/CLI lifecycle surface:

- `/agent public <name> status` shows remote health, last-seen, endpoints, on-chain status, and optional budget/stat data.
- Registration refresh can refetch well-known metadata and retry the `identity.json` SSH push.
- Deregistration removes the manager registry entry.

Unsupported manager lifecycle surface:

- No `start`.
- No `stop`.
- No `rebuild`.
- No local log tailing unless the remote exposes an SSH-tunneled operational endpoint in a later design.

The operator owns lifecycle on the VPS.

### Deregister

Deregistering only removes the manager registry entry. The on-chain record remains intact permanently for provenance. There is no token burn ceremony and no CLI burn prompt in v1.

### CLI To Public Agent Path

CLI calls to public agents should use direct HTTPS:

- `/public <domain>`
- `/public <n>`

The manager resolves registry entries for convenience, but it should not proxy normal conversations to the public endpoint. Keeping the manager as registry plus registrar prevents it from accidentally becoming a bridge between idchain agents and the public DMZ.

## Decisions

The previous open questions are now closed:

- Auth model: SSH tunnel for operator endpoints, public rate-limited `/talk`, and public read-only `/health`.
- Identity updates: manager writes `identity.json` over SSH; public-agent watches and reloads it. No `PATCH /identity`.
- v1 schemas: `/.well-known/restap.json`, `/health`, `/identity`, and SSH-only `/stats` are the minimum contract.
- Deregister: remove only the manager registry entry; leave on-chain provenance intact.
- Cross-team operations: not supported. Operators switch teams with `--team=public` or `/team public`; there is no cross-team mesh path.

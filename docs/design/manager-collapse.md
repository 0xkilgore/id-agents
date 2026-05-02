# Manager Collapse Design

Task: `manager-collapse-design`
Branch: `refactor/manager-collapse-cli`
Base commit: `57da440`
Author: `cto`
Date: 2026-05-02

## Status: Implemented

This design has shipped on `refactor/manager-collapse-cli` (final commit `b1b5882`). The end state is now live:

- The daemon on `:4100` owns the manager identity, the manager inbox, and the REST-AP catalog at `/.well-known/restap.json`.
- The interactive CLI no longer binds `:4000`. It is purely a thin client over the daemon's `/manager/inbox/*` APIs.
- `workspace/manager/interactive-agent-identity.json` is no longer created or read.
- `InteractiveAgentServer` remains in the codebase only for the human-as-agent path (`src/human-agent-cli.ts`), where a human can be `alice` on `:4000`. It is no longer used by the manager CLI.

The rest of this document is preserved as historical design context. Tense and references to the "current" two-process state describe the pre-refactor world.

## Summary

Before this refactor, the system had two different things that both looked like "the manager":

- The daemon on `:4100` was the real control plane. It owned orchestration, `/remote`, task APIs, scheduler, checkins, health, and the actual write path for most manager inbox traffic.
- The interactive CLI on `:4000` also booted an `InteractiveAgentServer`, registered itself as an interactive `manager` agent, published a manager REST-AP catalog, kept a local identity file, and was the only place with a direct "respond to pending manager query" implementation.

That split was conceptually wrong. The system mostly already behaved as if the daemon was the manager, but it still carried a second process that impersonated the manager for discovery and human interaction. Collapsing it dropped complexity by making the CLI a pure HTTP/WebSocket client of the daemon.

Verdict (at the time): proceed with the refactor. Outcome: shipped.

## Current Inventory

### `:4100` daemon responsibilities

Primary code:

- `src/start-agent-manager.ts`
- `src/agent-manager-db.ts`
- `src/scheduling/*`
- `src/checkins/*`

Daemon-owned endpoints on `:4100` today:

- `GET /health`
- `GET /logs`
- `POST /remote`
- `GET /query/:id`
- `GET /news`
- `POST /news`
- `POST /talk`
- `POST /schedule`
- `POST /message`
- `POST /talk-to`
- `POST /news-to`
- `POST /news/archive`
- `GET /events`
- `GET /agents`
- `GET /agents/status`
- `GET /agents/:name/news`
- `POST /agents/:name/cancel`
- `GET /agents/resolve/:ref`
- `GET /agents/by-name/:name`
- `GET /agents/:id`
- `POST /agents/spawn`
- `POST /agents/register`
- `POST /agents/:id/metadata`
- `POST /agents/by-name/:name/metadata`
- `PATCH /agents/:id/metadata`
- `DELETE /agents/:id`
- `DELETE /agents/by-name/:name`
- `POST /agents/:id/onchain/register`
- `POST /agents/by-name/:name/onchain/register`
- `POST /agents/:id/onchain/redeliver-identity`
- `POST /agents/:id/model`
- `POST /agents/:id/probe`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:ref`
- `POST /tasks/:ref/claim`
- `POST /tasks/:ref/done`
- `DELETE /tasks/:ref`
- `GET /library/agents`
- `GET /library/agents/:name`
- `GET /library/skills`
- `GET /library/skills/:name`
- `GET /:tokenId`
- `ALL /:tokenId/*`
- `WS /ws`

Important daemon behavior already related to manager inbox:

- `POST /talk`, `POST /schedule`, `POST /news`, and `GET /news` already resolve the manager inbox through `resolveManagerInboxId(...)`.
- The daemon already auto-provisions a stub interactive row like `manager-<team>` when no CLI has registered yet.
- `agentToResponse(...)` already rewrites interactive manager URLs to `http://localhost:<managementPort>`, not `:4000`.
- WebSocket fanout for manager news already happens from the daemon on `/ws`.

Daemon in-memory state:

- `wsClients`
- `runningServers`
- `schedulerService`
- `queryWaiters`
- `queryStatusWaiters`
- `healthStatus`
- `logBuffer`
- background timers for health, remote probe, query sweeper, retention, checkins
- module-level REST-AP catalog cache

Daemon-owned durable state and files:

- DB-backed teams, agents, queries, news, schedules, tasks, events
- workspace team directories under `workspace/teams/*`
- public-agent identity staging under `workspace/public-agents/<agent-id>/staging/identity.json`

Important gap:

- The daemon does not currently serve root `/.well-known/restap.json` for the manager itself. Discovery at the daemon root is missing.

### `:4000` CLI responsibilities

Primary code:

- `src/interactive-agent-cli.ts`
- `src/interactive-agent-server.ts`

CLI-owned network surface on `:4000` today:

- `GET /.well-known/restap.json`
- `POST /talk` returning `410 Gone` with `Location: :4100/talk`
- `POST /schedule` returning `410 Gone` with `Location: :4100/schedule`
- `GET /news`
- `POST /news` returning `410 Gone` with `Location: :4100/news`

CLI responsibilities that are not network-serving and should stay local:

- terminal rendering and readline lifecycle
- prompt state
- command parsing for `/ask`, `/deploy`, `/task`, `/public`, `/team`, `/status`, etc.
- local macros
- confirmation prompts
- audio notification
- per-session state like `lastAskedAgent`, `agentSessions`, `publicSession`

CLI in-memory manager-related state today:

- `activeTeam`
- `activeServerName`
- `lastAskedAgent`
- `pendingOutgoingQueries`
- `displayedReplies`
- `managerWs`
- `wsReconnectTimer`
- `newsPollInterval`
- `lastNewsTimestamp`
- optional local DB handles for the interactive agent

CLI file state today:

- `workspace/manager/interactive-agent-identity.json`

What that file does:

- stores the stable id assigned when the CLI registers itself as the interactive `manager` agent for each team
- is written by `registerWithManager()`
- exists only to preserve the fiction that the CLI is a real networked manager agent

### Identity split today

Two different codepaths claim manager identity:

- daemon boot defaults `AGENT_ROLE=manager` in `src/start-agent-manager.ts`
- CLI hardcodes `const name = 'manager'` in `src/interactive-agent-cli.ts`

Operationally:

- peer dispatch and scheduler control go through `:4100`
- human/operator inbox semantics are still modeled through a CLI-side agent registration and local identity file

This is the root asymmetry.

## Target Architecture

### Principle

Single source of truth: the daemon is the manager.

Implications:

- only the daemon binds a manager network port
- only the daemon publishes the manager REST-AP catalog
- only the daemon owns manager inbox persistence and query completion
- the CLI is a client, not an agent

### End-state network surface

Manager daemon on `:4100` should own:

- `GET /.well-known/restap.json`
- `POST /talk`
- `POST /schedule`
- `GET /news`
- `POST /news`
- existing `/remote`, `/query/:id`, `/tasks/*`, `/agents/*`, `/events`, `/ws`

The CLI should bind no port at all.

### Manager REST-AP catalog at the daemon root

Add `GET /.well-known/restap.json` on `:4100` with:

- `agent.name = "manager"`
- `agent.description` describing the manager daemon as the team orchestration and inbox surface
- endpoints for `talk`, `schedule`, `news`, `news_post`
- capability entries for `POST /talk`, `POST /schedule`, `GET /news`, `POST /news`

Optional but useful:

- include non-REST-AP management endpoints in `capabilities` as extensions: `/remote`, `/query/:id`, `/tasks`, `/agents`, `/events`

### New daemon client API for the CLI

The CLI should stop relying on `InteractiveAgentServer` for pending manager work and responses. It needs explicit daemon APIs for the remaining manager-human loop.

Recommended additions:

- `GET /manager/inbox/pending`
  - returns pending manager queries and scheduled work for the active team
  - source of truth is the daemon DB, not CLI memory
- `POST /manager/inbox/respond`
  - body: `{ query_id, message, session_id? }`
  - marks the manager query complete and emits the same terminal events/news rows the current CLI-local `server.respond()` path emits
- `WS /ws`
  - keep the existing socket
  - add a dedicated event type for pending manager work if needed, or keep using `news` plus a separate `pending_count`/`pending_query` event

Alternative shape if you want to minimize endpoints:

- `GET /query/pending?owner=manager`
- `POST /query/:id/respond`

I prefer the explicit `/manager/inbox/*` shape because it makes the ownership clear and avoids pretending the CLI still owns a server-side agent implementation.

### What must stay process-local to the CLI

Keep in the CLI process:

- readline and terminal UI
- prompt history and last-target state
- local session continuity cache for `/ask`
- public-agent interactive chat session state
- macro expansion
- confirmation workflows
- sound/UX affordances
- optional convenience behavior that auto-starts the daemon if absent

Move out of the CLI:

- `InteractiveAgentServer` usage for manager
- manager agent registration
- `workspace/manager/interactive-agent-identity.json`
- local `/news` polling endpoint
- any manager discovery endpoint on `:4000`

### What can remain shared

The CLI should keep calling existing daemon APIs for:

- `/remote`
- `/agents*`
- `/tasks*`
- `/news`
- `/logs`
- `/teams*`
- `/registry*`
- `/public` backing APIs

The CLI is already mostly a daemon client. This change finishes that direction.

## Migration Plan

### Step 1: Add daemon-root manager discovery

Change:

- add `GET /.well-known/restap.json` to `src/agent-manager-db.ts`

Why first:

- it makes `:4100` discoverable as the manager before anything is removed from the CLI

Fallback:

- none needed beyond leaving `:4000` untouched for one release

Break risk:

- none if additive

### Step 2: Add daemon-owned manager inbox read/respond APIs

Change:

- add `GET /manager/inbox/pending`
- add `POST /manager/inbox/respond`
- wire them to the existing DB query/news model and wakeup events

Fallback:

- CLI can continue using `InteractiveAgentServer` until the client path is switched

Break risk:

- none if additive

### Step 3: Switch the CLI to client-only manager inbox handling

Change:

- remove `InteractiveAgentServer` from `interactive-agent-cli.ts` for manager mode
- replace pending-question polling with daemon API calls
- replace local `server.respond()` semantics with daemon `POST /manager/inbox/respond`
- keep WebSocket to `:4100/ws`

Fallback:

- short-lived feature flag only, for example `ID_MANAGER_LEGACY_REPL_SERVER=true`

Warning:

- do not keep this flag long-term; if both codepaths live indefinitely, complexity does not actually fall

Break risk:

- low for peer agents
- medium for operators if the daemon-side respond semantics are wrong

### Step 4: Stop CLI registration as interactive `manager`

Change:

- delete `registerWithManager()` behavior that registers the CLI as an interactive agent
- stop reading/writing `workspace/manager/interactive-agent-identity.json`
- stop using interactive rows as the preferred manager identity
- make the daemon's manager inbox id stable and daemon-owned

Recommendation:

- replace `resolveManagerInboxId()` preference order with a stable daemon-owned id first, for example `manager-<team>`

Fallback:

- one release only: daemon may continue to tolerate old interactive rows during lookup, but should stop creating new dependency on them

Break risk:

- medium if any code still assumes `findInteractive(team)` locates "the manager"

### Step 5: Stop binding `:4000`

Change:

- CLI becomes pure client, no Express server
- remove manager `:4000` start from docs and examples

Fallback:

- there is no transparent HTTP redirect fallback once the port is gone

Break risk:

- high for anything hardcoded to `:4000`
- this is the step that breaks direct REST-AP discovery for clients that cached the old port

### Step 6: Remove compatibility and dead code

Change:

- delete manager-specific `InteractiveAgentServer` path
- delete `interactive-agent-identity.json` plumbing
- update docs, skills, examples, tests

Fallback:

- none

Break risk:

- only if earlier steps left hidden dependencies behind

## Discovery and Cache Risk

This refactor breaks clients that directly target `:4000` once Step 5 lands.

Important nuance:

- peer agents using manager `/agents` responses are mostly already insulated, because `agentToResponse(...)` maps interactive manager URLs to `:4100`
- direct external tools and scripts are not insulated

Clients likely to break if they cached `:4000`:

- anything that stored `http://127.0.0.1:4000/.well-known/restap.json`
- anything that posts to `http://127.0.0.1:4000/talk`
- operator scripts using `REPL_URL`

Recommendation:

- announce the cut explicitly in changelog/docs
- make the CLI print a one-time migration warning in the release before `:4000` disappears
- do not rely on a redirect, because a non-listening port cannot redirect

## Blast Radius

### External clients or scripts hardcoded to `:4000`

Greppable hits that look operational, not just prose:

- `skills/idagents-admin-control/admin-session.js`
  - `REPL_URL` defaults to `http://127.0.0.1:4000`
  - posts to `${REPL_URL}/talk`
- `src/id-agents-cli.ts`
  - examples still say `id-agents register "manager" http://localhost:4000`

Likely low-risk but stale references:

- `scripts/test-longpoll.sh`
  - comments reference `:4000` history

### Tests that bind `:4000`

I did not find a direct current test binding of manager CLI port `4000`.

What I found instead:

- integration tests focus on daemon `:4100` and generic agent behavior
- no direct `InteractiveAgentServer(..., 4000)` usage in `tests/`

This is good news. The likely work is updating fixtures and assertions, not rewriting a big CLI-port test matrix.

### Docs and skills referencing `:4000`

Greppable references that need review or edits:

- `README.md`
- `QUICKSTART.md`
- `docs/reference/architecture.md`
- `docs/guides/interactive-agent.md`
- `skills/idagents-admin-control/SKILL.md`
- `CHANGELOG.md`

The docs currently describe a two-port mental model. Those explanations become wrong after collapse.

### Hetzner and public-agent paths

Hetzner docs are mostly already daemon-first:

- `docs/deployment/hetzner.md`
- `docs/deployment/hetzner-setup.md`
- `scripts/deploy-manager.sh`
- `scripts/setup-hetzner.sh`

Observed risk:

- these docs still tell operators to run `npm run id-agents`, which currently implies both daemon behavior and interactive CLI behavior
- after collapse, the CLI can still exist, but it must be described as a client to the already-running manager, not a second manager process

Public-agent code paths are largely unaffected mechanically because they already target daemon surfaces:

- `src/cli/public-commands.ts`
- `skills/idagents-register-public-agents/SKILL.md`
- `skills/idagents-admin-control/SKILL.md`
- `src/agent-manager-db.ts` public-agent registration and redelivery paths

The main public-agent impact is documentation clarity, not protocol rewiring.

## Honest Verdict

### Does complexity actually drop?

Yes, if the refactor is completed fully.

No, if the team stops halfway and keeps:

- CLI registration as interactive manager
- `workspace/manager/interactive-agent-identity.json`
- manager-only `InteractiveAgentServer`
- a compatibility flag that survives more than one release

### Quantified impact

Processes:

- `2` manager-shaped processes today
- `1` after collapse

Ports:

- `2` manager-facing ports today: `4000`, `4100`
- `1` after collapse: `4100`

Conceptual surfaces eliminated:

- "manager as daemon" vs "manager as CLI agent"
- CLI-local manager identity persistence
- manager port math (`MANAGER_PORT - 100`)
- partial REST-AP manager surface on `:4000`
- dead-end 410 shim endpoints on the CLI
- lookup preference for newest interactive manager row

Estimated code removal:

- `src/interactive-agent-server.ts`: `348` LoC total, though part may remain for `human-agent-cli.ts`
- manager-specific glue in `src/interactive-agent-cli.ts`: roughly `700-1000` LoC is tied to local manager server, manager registration, local identity persistence, pending-query handling, and manager WebSocket/polling orchestration
- net removal target: roughly `900-1300` LoC once compatibility is gone

Estimated code addition:

- daemon-root REST-AP catalog: small
- explicit daemon manager-inbox client endpoints: moderate, probably under `150-250` LoC if implemented cleanly against existing DB primitives

Net:

- likely a real reduction on the order of `600-1000` LoC
- one fewer long-running process
- one fewer bound port
- materially simpler mental model for operators and peer agents

### Recommendation

Proceed.

This refactor is justified because it removes a false boundary, not because it chases stylistic purity. The daemon already owns most of the real semantics. The remaining work is to stop pretending the CLI is a networked manager agent.

The one condition: do not preserve the old split behind permanent compatibility scaffolding. If the CLI still registers as manager or still needs `workspace/manager/interactive-agent-identity.json`, the refactor has failed and should be abandoned.

# Vetra Read-Side Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first Vetra read-side surface for the Phase 3 fleet cards: when `USE_VETRA_DISPATCHES=true`, each agent card's `current_task_title`, `current_task_started_at`, and `current_task_status` comes from the agent's most recent open Vetra dispatch; on any Vetra read failure, the dashboard silently falls back to SQLite and shows only a tiny degraded-source indicator.

**Architecture:** Keep the write path unchanged. In `id-agents`, add a manager-owned `AgentCurrentTaskReadModel` seam with two implementations: `SqliteCurrentTaskReadModel` and `VetraCurrentTaskReadModel`. Expose one manager route that returns a stable per-agent current-task contract. In `personal/dashboard`, stop reading dispatch state from SQLite directly; fetch roster from `/agents` and current-task snapshots from the new manager route, then render the same fleet cards with a tiny degraded dot when fallback occurs.

**Tech Stack:** TypeScript, Node.js, existing `Db` repository layer, manager Express routes in `src/agent-manager-db.ts`, global `fetch` for GraphQL, Next.js App Router in `personal/dashboard`, Vitest, React Testing Library.

**Spec:** `/Users/kilgore/Dropbox/Code/cane/id-agents-readside-spec/docs/superpowers/specs/2026-05-07-vetra-readside-dashboard-integration.md`

**Target build branch:** `vetra-beachhead-v0` follow-up after this plan is approved. This plan itself is saved on a separate plan branch off `main`.

---

## File Structure

### id-agents — new files

| Path | Responsibility |
|------|---------------|
| `src/dispatches/current-task-read-model.ts` | Shared read-model contract + snapshot types |
| `src/dispatches/current-task-title.ts` | Extract first meaningful card-safe title from dispatch markdown |
| `src/dispatches/sqlite-current-task-read-model.ts` | SQLite-backed `queued` / `in_flight` projection |
| `src/dispatches/vetra-current-task-read-model.ts` | Vetra/Switchboard-backed projection + fallback error classification |
| `src/vetra/switchboard-client.ts` | Narrow GraphQL client for dispatch document reads |
| `tests/dispatches/current-task-title.test.ts` | Pure title extraction tests |
| `tests/dispatches/sqlite-current-task-read-model.test.ts` | SQLite projection tests |
| `tests/dispatches/vetra-current-task-read-model.test.ts` | Vetra mapping + invalid-response tests |
| `tests/integration/dashboard-current-tasks-route.test.ts` | Manager route + feature-flag + fallback integration tests |

### id-agents — modified files

| Path | Change |
|------|--------|
| `src/db/db-service.ts` | Add one repo method for latest open dispatch lookup by agent |
| `src/db/repos/sqlite/dispatches-repo.ts` | Implement latest-open-dispatch query for SQLite |
| `src/db/repos/postgres/dispatches-repo.ts` | Implement latest-open-dispatch query for PostgreSQL |
| `src/agent-manager-db.ts` | Wire read-model selector, feature flag, logging, and `GET /dashboard/agents/current-tasks` |
| `.env.example` | Document `USE_VETRA_DISPATCHES=false` and Vetra read-side env names |
| `env.example` | Mirror the same Vetra read-side env docs if this file is still used in local setup |
| `README.md` | Short operator note: feature flag, fallback behavior, rollback |

### personal/dashboard — modified files

| Path | Change |
|------|--------|
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/route.ts` | Stop reading live dispatch state from SQLite; fetch manager current-task snapshots instead |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/projection.ts` | Merge roster + manager snapshots + news/health without parsing dispatch semantics locally |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts` | Add typed `current_task_status`, `degraded_source`, `current_task_source`, `verify_status`, `artifact_path` |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx` | Render tiny degraded-source dot on overview fleet cards |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/agents/AgentsView.tsx` | Render the same tiny degraded-source dot on the Agents page cards |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/__tests__/projection.test.ts` | Update projection expectations to use manager snapshots |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/agents-view.test.tsx` | New UI test for the degraded-source indicator |

---

## Phase 0 — Branch And Dependency Preflight

### Task 0: Start from a clean feature branch and verify the write-side beachhead exists

**Files:**
- No file changes in this task

- [ ] **Step 1: Create the implementation branch from `main` in `id-agents`**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git switch main
git pull --ff-only upstream main
git switch -c vetra-readside-dashboard
```

Expected: new branch off `main`, not a detached HEAD and not `main`.

- [ ] **Step 2: Verify the Vetra write-side prerequisite exists before touching read-side code**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
test -f src/db/repos/sqlite/dispatches-repo.ts
test -f src/db/repos/postgres/dispatches-repo.ts
test -f src/dispatches/dispatch-service.ts
rg -n "CREATE TABLE IF NOT EXISTS dispatches|CREATE TABLE dispatches" src/db/migrations
```

Expected: all files exist and the `dispatches` table migration is already present.

If any prerequisite is missing, stop the build branch immediately and merge or cherry-pick the write-side work from `vetra-beachhead-v0` first. Do not implement the read-side against the old pre-dispatch schema on `main`.

- [ ] **Step 3: Capture the red baseline tests before new work**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/integration/dashboard-current-tasks-route.test.ts
```

Expected: file missing or tests failing red, because the route does not exist yet.

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand app/api/agents/__tests__/projection.test.ts
```

Expected: current tests still pass against the pre-migration SQLite-direct behavior.

---

## Phase 1 — Manager Read-Model Contract And SQLite Baseline

### Task 1: Define the stable current-task contract and the pure title extraction rules

**Files:**
- Create: `src/dispatches/current-task-read-model.ts`
- Create: `src/dispatches/current-task-title.ts`
- Test: `tests/dispatches/current-task-title.test.ts`

- [ ] **Step 1: Write the failing title-extraction tests first**

Create `tests/dispatches/current-task-title.test.ts` covering:

- first non-empty line becomes the title
- markdown bullets such as `- build X` lose the bullet prefix
- headings such as `# Build X` lose heading markers
- titles are trimmed and truncated to a fixed card-safe max length
- empty / whitespace-only markdown returns `"Untitled dispatch"`

Run:

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/current-task-title.test.ts
```

Expected: red, because the helper does not exist yet.

- [ ] **Step 2: Add the shared snapshot types**

Create `src/dispatches/current-task-read-model.ts` with:

```ts
export type DispatchCardSource = "sqlite" | "vetra";

export type CurrentTaskStatus = "queued" | "in_flight";

export type AgentCurrentTaskSnapshot = {
  agent_id: string;
  current_task: {
    source: DispatchCardSource;
    dispatch_id: string | number;
    query_id: string | null;
    title: string;
    started_at: string;
    status: CurrentTaskStatus;
    waiting_on_human: boolean;
    verify_status: string | null;
    artifact_path: string | null;
  } | null;
  degraded_source: boolean;
};

export interface AgentCurrentTaskReadModel {
  getCurrentTaskByAgent(agentIds: string[]): Promise<AgentCurrentTaskSnapshot[]>;
}
```

- [ ] **Step 3: Implement the pure title helper**

Create `src/dispatches/current-task-title.ts` with a single exported function:

```ts
export function extractCurrentTaskTitle(bodyMarkdown: string, maxLen = 120): string
```

Rules:

- split by newline
- keep the first non-empty line
- strip leading markdown punctuation (`#`, `-`, `*`, ordered-list prefix)
- trim
- default to `"Untitled dispatch"`
- truncate with ASCII ellipsis `...` once over `maxLen`

- [ ] **Step 4: Re-run the pure tests**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/current-task-title.test.ts
```

Expected: green.

- [ ] **Step 5: Commit the pure contract and helper**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add src/dispatches/current-task-read-model.ts src/dispatches/current-task-title.ts tests/dispatches/current-task-title.test.ts
git commit -m "Add current-task read-model contract and title helper"
```

---

### Task 2: Add the SQLite-backed current-task read model

**Files:**
- Modify: `src/db/db-service.ts`
- Modify: `src/db/repos/sqlite/dispatches-repo.ts`
- Modify: `src/db/repos/postgres/dispatches-repo.ts`
- Create: `src/dispatches/sqlite-current-task-read-model.ts`
- Test: `tests/dispatches/sqlite-current-task-read-model.test.ts`

- [ ] **Step 1: Write the failing SQLite projection tests**

Create `tests/dispatches/sqlite-current-task-read-model.test.ts` covering:

- chooses the most recent `queued` or `in_flight` dispatch per agent
- ignores terminal statuses `done`, `failed`, `timeout`, `wedged`
- returns `current_task: null` when an agent has no open dispatch
- maps `dispatched_at` to ISO `started_at`
- passes through `query_id`, `verify_status`, and first `artifact_path`

Run:

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/sqlite-current-task-read-model.test.ts
```

Expected: red.

- [ ] **Step 2: Extend the dispatches repository interface with one narrow method**

Modify `src/db/db-service.ts` to add:

```ts
listLatestOpenByAgents(agentIds: string[]): Promise<DispatchRow[]>;
```

This method must return at most one row per agent, already filtered to `status IN ('queued', 'in_flight')`, newest first within each agent.

- [ ] **Step 3: Implement the repo method in both dialects**

Modify:

- `src/db/repos/sqlite/dispatches-repo.ts`
- `src/db/repos/postgres/dispatches-repo.ts`

Implementation rules:

- input: array of agent names / ids used by the dispatch rows
- output: zero or one latest open row per agent
- no title parsing in SQL
- keep the status filter inside the repo, not in the manager route

- [ ] **Step 4: Implement the SQLite read model**

Create `src/dispatches/sqlite-current-task-read-model.ts`:

- inject the existing `Db`
- call `db.dispatches.listLatestOpenByAgents(agentIds)`
- map each row into `AgentCurrentTaskSnapshot`
- always emit every requested agent, even when `current_task` is `null`
- set `current_task.source = "sqlite"`
- set `degraded_source = false`
- use `extractCurrentTaskTitle()` for the title

- [ ] **Step 5: Run the new tests**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/sqlite-current-task-read-model.test.ts
```

Expected: green.

- [ ] **Step 6: Commit the SQLite baseline**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add src/db/db-service.ts src/db/repos/sqlite/dispatches-repo.ts src/db/repos/postgres/dispatches-repo.ts src/dispatches/sqlite-current-task-read-model.ts tests/dispatches/sqlite-current-task-read-model.test.ts
git commit -m "Add sqlite current-task read model"
```

---

## Phase 2 — Vetra/Switchboard Adapter And Fallback Logic

### Task 3: Add the Switchboard GraphQL client and Vetra current-task read model

**Files:**
- Create: `src/vetra/switchboard-client.ts`
- Create: `src/dispatches/vetra-current-task-read-model.ts`
- Test: `tests/dispatches/vetra-current-task-read-model.test.ts`
- Modify: `.env.example`
- Modify: `env.example`

- [ ] **Step 1: Write the failing Vetra read-model tests**

Create `tests/dispatches/vetra-current-task-read-model.test.ts` covering:

- GraphQL rows with `status` `QUEUED` or `IN_FLIGHT` map to lowercase dashboard enums
- rows sort by `dispatched_at DESC` and choose one open dispatch per agent
- malformed responses reject with a typed fallback-worthy error
- duplicate conflicting open documents for the same agent reject as invalid projection state
- empty Vetra results still produce snapshots with `current_task: null`

Run:

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/vetra-current-task-read-model.test.ts
```

Expected: red.

- [ ] **Step 2: Add the narrow Switchboard client**

Create `src/vetra/switchboard-client.ts` with:

- constructor args:
  - `graphqlUrl: string`
  - `accessToken: string | null`
  - injected `fetchImpl?: typeof fetch`
- one method:

```ts
queryOpenDispatches(agentIds: string[]): Promise<VetraDispatchDocument[]>
```

Client rules:

- POST GraphQL only
- 5s timeout via `AbortController`
- bearer auth only when token exists
- no retries in v1
- throw rich errors including HTTP status and a short response preview

- [ ] **Step 3: Implement the Vetra read model**

Create `src/dispatches/vetra-current-task-read-model.ts`:

- call `queryOpenDispatches(agentIds)`
- filter to open statuses `QUEUED` and `IN_FLIGHT`
- group by `to_agent`
- sort by `dispatched_at DESC`
- reject multiple top candidates with equal timestamps for the same agent as invalid state
- map to the shared snapshot contract
- set `current_task.source = "vetra"`
- set `degraded_source = false`

- [ ] **Step 4: Document the env flags**

Modify `.env.example` and `env.example` to add:

```bash
USE_VETRA_DISPATCHES=false
SWITCHBOARD_GRAPHQL_URL=
SWITCHBOARD_ACCESS_TOKEN=
```

Leave the values blank in the examples except the feature flag default. The local operator already owns the real endpoint and token; do not guess or hardcode a URL in the repo.

- [ ] **Step 5: Re-run the Vetra tests**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/dispatches/vetra-current-task-read-model.test.ts
```

Expected: green.

- [ ] **Step 6: Commit the Vetra adapter**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add src/vetra/switchboard-client.ts src/dispatches/vetra-current-task-read-model.ts tests/dispatches/vetra-current-task-read-model.test.ts .env.example env.example
git commit -m "Add vetra current-task read model"
```

---

## Phase 3 — Manager Route, Logging, And Rollback-Safe Selector

### Task 4: Expose the manager-owned current-task API and silent fallback behavior

**Files:**
- Modify: `src/agent-manager-db.ts`
- Test: `tests/integration/dashboard-current-tasks-route.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing manager route tests**

Create `tests/integration/dashboard-current-tasks-route.test.ts` covering:

- `USE_VETRA_DISPATCHES=false` returns SQLite snapshots with `degraded_source=false`
- `USE_VETRA_DISPATCHES=true` returns Vetra snapshots when the adapter succeeds
- Vetra timeout or malformed response falls back to SQLite and sets `degraded_source=true`
- response stays stable when some agents have no open dispatch
- route never leaks GraphQL/raw Vetra internals to the browser

Run:

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/integration/dashboard-current-tasks-route.test.ts
```

Expected: red.

- [ ] **Step 2: Wire the selector inside `agent-manager-db.ts`**

Add a small helper section near the other route helpers:

- `createCurrentTaskReadModel()`
- `getUseVetraDispatchesFlag()`
- `logCurrentTaskFallback(agentIds, reason, sqliteSucceeded)`

Implementation rules:

- when `USE_VETRA_DISPATCHES !== "true"`, use `SqliteCurrentTaskReadModel`
- when true, attempt `VetraCurrentTaskReadModel`
- on any Vetra read failure, log and immediately fall back to SQLite
- never let Vetra failure produce an empty-card regression when SQLite has data

- [ ] **Step 3: Add the route**

Add:

```ts
GET /dashboard/agents/current-tasks
```

Request shape:

- query param `agents=roger,cto,sentinel` optional
- if omitted, resolve the team roster from `db.agents.list(teamId, true)` and project all visible agents

Response shape:

```json
{
  "ok": true,
  "agents": [
    {
      "agent_id": "roger",
      "current_task": null,
      "degraded_source": false
    }
  ]
}
```

- [ ] **Step 4: Add the rollback/operator note**

Update `README.md` with one short section:

- flag: `USE_VETRA_DISPATCHES`
- healthy behavior: source becomes Vetra
- failure behavior: fallback to SQLite + tiny degraded indicator in UI
- rollback: set flag false and restart manager

- [ ] **Step 5: Run the route tests**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/integration/dashboard-current-tasks-route.test.ts
```

Expected: green.

- [ ] **Step 6: Commit the manager route**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add src/agent-manager-db.ts tests/integration/dashboard-current-tasks-route.test.ts README.md
git commit -m "Add dashboard current-task route with vetra fallback"
```

---

## Phase 4 — Dashboard Consumer Migration

### Task 5: Stop reading live dispatches from SQLite directly in `personal/dashboard`

**Files:**
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/route.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/projection.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`
- Test: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/__tests__/projection.test.ts`

- [ ] **Step 1: Write the failing dashboard API test expectations**

Update `app/api/agents/__tests__/projection.test.ts` so the projection consumes manager snapshots instead of inferring current work from local dispatch rows:

- `current_task_title` comes from the supplied snapshot
- `current_task_started_at` comes from the supplied snapshot
- `current_task_status`, `degraded_source`, `verify_status`, and `artifact_path` are preserved
- waiting/stale logic can still use health/news, but not dispatch-title parsing

Run:

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand app/api/agents/__tests__/projection.test.ts
```

Expected: red.

- [ ] **Step 2: Fetch the new manager route in the Next API layer**

Modify `app/api/agents/route.ts`:

- keep `fetchManagerRoster()`
- add `fetchCurrentTaskSnapshots()`
- stop querying the local SQLite `dispatches` table for live current-task state
- keep local SQLite reads only for the remaining historical/activity feed fields until a separate spec migrates them

Important: remove the live `dispatches` query from `queryDb()` entirely once the manager route supplies current-task state. The spec explicitly says the dashboard should not read SQLite directly for this surface anymore.

- [ ] **Step 3: Simplify the projection layer**

Modify `app/api/agents/projection.ts`:

- remove the current-dispatch selection logic from local dispatch rows
- accept a `currentTasksByAgent` map from the API route
- preserve health-driven `idle`/`stale` and news-driven `waiting_on_human`
- set `current_dispatch` and `current_task_title` from the manager snapshot only

- [ ] **Step 4: Update the shared types**

Modify `app/types.ts` so `AgentProgress` includes:

```ts
current_task_status?: "queued" | "in_flight" | null;
degraded_source?: boolean;
current_task_source?: "sqlite" | "vetra" | null;
verify_status?: string | null;
artifact_path?: string | null;
```

- [ ] **Step 5: Re-run the projection tests**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand app/api/agents/__tests__/projection.test.ts
```

Expected: green.

- [ ] **Step 6: Commit the dashboard API migration**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add app/api/agents/route.ts app/api/agents/projection.ts app/types.ts app/api/agents/__tests__/projection.test.ts
git commit -m "Use manager current-task snapshots for fleet cards"
```

---

### Task 6: Add the tiny degraded-source indicator to the fleet cards

**Files:**
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/agents/AgentsView.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/agents-view.test.tsx`

- [ ] **Step 1: Write the failing UI test**

Create `app/__tests__/agents-view.test.tsx` covering:

- no indicator when `degraded_source` is false
- tiny neutral indicator appears when `degraded_source` is true
- indicator copy is minimal and neutral, e.g. tooltip/title `fallback: SQLite`

Run:

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand app/__tests__/agents-view.test.tsx
```

Expected: red.

- [ ] **Step 2: Render the tiny degraded indicator on the overview fleet cards**

Modify `app/Dashboard.tsx`:

- place the dot in the card metadata row beside the current-task label, not as a banner
- use the existing muted palette, not red/yellow
- add `title="fallback: SQLite"`

- [ ] **Step 3: Mirror the same indicator on the Agents page cards**

Modify `app/agents/AgentsView.tsx` with the same visual treatment so both fleet surfaces behave consistently.

- [ ] **Step 4: Re-run the UI test**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand app/__tests__/agents-view.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit the UI indicator**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add app/Dashboard.tsx app/agents/AgentsView.tsx app/__tests__/agents-view.test.tsx
git commit -m "Add degraded-source indicator to fleet cards"
```

---

## Phase 5 — Verification, Demo, And Rollback

### Task 7: Verify the full story end to end before handing to Roger

**Files:**
- No required file changes in this task unless verification finds a bug

- [ ] **Step 1: Run the id-agents test slice**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run \
  tests/dispatches/current-task-title.test.ts \
  tests/dispatches/sqlite-current-task-read-model.test.ts \
  tests/dispatches/vetra-current-task-read-model.test.ts \
  tests/integration/dashboard-current-tasks-route.test.ts
```

Expected: all green.

- [ ] **Step 2: Run the dashboard test slice**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
npm test -- --runInBand \
  app/api/agents/__tests__/projection.test.ts \
  app/__tests__/agents-view.test.tsx
```

Expected: all green.

- [ ] **Step 3: Manual manager-route smoke with SQLite mode**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
USE_VETRA_DISPATCHES=false npm run start:manager
curl -s "http://127.0.0.1:4100/dashboard/agents/current-tasks?agents=roger,cto" | jq
```

Expected: stable snapshots, `degraded_source: false`, `source: "sqlite"` when `current_task` is present.

- [ ] **Step 4: Manual manager-route smoke with Vetra mode**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
USE_VETRA_DISPATCHES=true \
SWITCHBOARD_GRAPHQL_URL="$SWITCHBOARD_GRAPHQL_URL" \
SWITCHBOARD_ACCESS_TOKEN="$SWITCHBOARD_ACCESS_TOKEN" \
npm run start:manager
curl -s "http://127.0.0.1:4100/dashboard/agents/current-tasks?agents=roger,cto" | jq
```

Expected: healthy Vetra responses populate `source: "vetra"` and `degraded_source: false`.

- [ ] **Step 5: Force fallback once and verify the degraded dot**

Use one of:

- stop the local Switchboard endpoint, or
- point `SWITCHBOARD_GRAPHQL_URL` at an unused localhost port for one run

Then:

```bash
curl -s "http://127.0.0.1:4100/dashboard/agents/current-tasks?agents=roger,cto" | jq
```

Expected:

- route still returns snapshots from SQLite
- `degraded_source: true` on affected rows
- the dashboard fleet card renders the tiny neutral dot with tooltip `fallback: SQLite`

- [ ] **Step 6: Verify rollback in under five minutes**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
USE_VETRA_DISPATCHES=false npm run start:manager
curl -s "http://127.0.0.1:4100/dashboard/agents/current-tasks?agents=roger,cto" | jq
```

Expected: route returns SQLite snapshots only, degraded indicator gone, no code changes required.

---

## Acceptance Checklist

- [ ] With `USE_VETRA_DISPATCHES=false`, the fleet cards behave exactly as they do today.
- [ ] With `USE_VETRA_DISPATCHES=true`, the fleet cards source `current_task_title`, `current_task_started_at`, and `current_task_status` from Vetra-backed projection.
- [ ] On Vetra read failure, the manager falls back silently to SQLite and returns `degraded_source: true`.
- [ ] The dashboard no longer reads SQLite directly for the live fleet current-task surface.
- [ ] The UI shows only a tiny neutral degraded-source indicator, not a blocking banner.
- [ ] Rollback requires only `USE_VETRA_DISPATCHES=false` plus restart.
- [ ] Roger can start implementation on Monday, May 11, 2026, with a v1 demo path ready for mid-week May 13-15.

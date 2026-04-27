# DoD & Dispatch Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a typed Definition-of-Done contract embedded in dispatch protocol, a `dispatches` SQLite table as single source of truth for in-flight work, a primary HTML surface at `dashboard.caneyfork.dev/in-flight`, a Hybrid A+C liveness watchdog (process heartbeats + dispatch-stale watch), plus a Bash hard-timeout sidecar and Desk banner renderer fix.

**Architecture:** New `dispatches` table in `id-agents.db` with one row per dispatched unit of work. Manager grows two endpoints: `POST /dispatches` (called before `/talk`) and an extended `POST /agent-done` (existing endpoint at port 4239 on M1) that records dispatch closure plus runs server-side `verify_signal` checks. A new `verify-runner` module evaluates 5 typed check kinds. Sentinel grows a periodic re-verify job. Each agent's `local-agent-server.ts` writes a process-layer heartbeat file every 60s. A new dispatch-stale cron flips wedged rows. Bash-tool wrapper enforces a 30-min hard timeout per spawned child. Dashboard repo (separate, deployed via `vercel --prod`) gets a new `/in-flight` page reading from the manager API.

**Tech Stack:** TypeScript, Node, SQLite (better-sqlite3 via custom adapter), Vitest + node:test, Drizzle-style repository pattern, Next.js (dashboard), Python 3 (Sentinel + cron sidecars), launchd.

**Spec:** `docs/superpowers/specs/2026-04-27-dod-dispatch-observability-design.md`

**Roger spec wrapper:** Once this plan ships, dispatch to Roger as `roger-specs/053-dod-dispatch-observability.md` (a 1-page summary referencing this plan).

---

## File Structure

### New files

| Path | Responsibility |
|------|---------------|
| `src/db/repos/sqlite/dispatches-repo.ts` | CRUD for `dispatches` table |
| `src/verify/types.ts` | `VerifySignal` discriminated union + `VerifyResult` types |
| `src/verify/runner.ts` | Pure function `runVerifySignal(signal): Promise<VerifyResult>` |
| `src/verify/checks/http-get.ts` | One verify-check kind per file |
| `src/verify/checks/file-mtime.ts` | |
| `src/verify/checks/desk-tag.ts` | |
| `src/verify/checks/api-call.ts` | |
| `src/verify/checks/all.ts` | Composite, calls runner recursively |
| `src/dispatches/dispatch-service.ts` | Glue: create dispatch row, flip status, run verify on done |
| `src/watchdog/heartbeat-writer.ts` | 60s tick that touches `~/.id-agents/heartbeats/<agent>.heartbeat` from inside `local-agent-server.ts` |
| `scripts/dispatch-stale-watch.ts` | Cron entry — flips `in_flight` rows past threshold to `wedged` |
| `scripts/sentinel-reverify.ts` | Periodic — re-runs `verify_signal` for stale rows |
| `scripts/bash-timeout-wrapper.sh` | SIGTERM-after-N defense-in-depth wrapper around Bash spawns |
| `tests/verify/runner.test.ts` | Unit tests for verify checks |
| `tests/dispatches/dispatches-repo.test.ts` | Repo conformance tests |
| `tests/dispatches/dispatch-service.test.ts` | Glue tests |
| `tests/watchdog/dispatch-stale.test.ts` | Stale-watch cron tests |

### Modified files

| Path | Change |
|------|--------|
| `src/db/migrations/sqlite.ts` | Append `CREATE TABLE dispatches` + indexes |
| `src/db/types.ts` | Add `DispatchRow`, `VerifyStatus`, `DispatchStatus` |
| `src/db/db-service.ts` | Add `DispatchesRepository` interface + wire into `Db` aggregate |
| `src/db/index.ts` | Inject `dispatches` repo into the `Db` factory |
| `src/agent-manager-db.ts` | Add `POST /dispatches`, `POST /dispatches/:id/kill`, `POST /dispatches/:id/retry`, `GET /dispatches`, `GET /dispatches/:id` |
| `src/local-agent-server.ts` | Spawn `heartbeat-writer.ts` as child + thread `dispatch_id` through `/talk` payload |
| `src/scheduling/schedule-dispatcher.ts` | Call `POST /dispatches` before `/talk`/`/schedule` |
| `~/Dropbox/Code/cane/taskview/cane_routing.py` | Call `POST /dispatches` before `/talk` |
| `~/Dropbox/Code/cane/cane-agent-done/server.py` (or wherever the M1 `/agent-done` lives) | Accept `dispatch_id` + `verify_signal`, run server-side verify |
| All agent `CLAUDE.md` (cane, roger, sentinel, personal, pipeline, defi, finances, cleveland-park, trinity) | Add "Self-verify before /agent-done" instruction block |
| `~/Dropbox/Code/cane/taskview/dashboard_refresh.py` (or wherever Desk banner is rendered) | Compute age at render time from stored timestamp |
| Dashboard repo (separate) — `pages/in-flight.tsx` (or app router equivalent) | NEW page |

### New launchd / cron entries

| Path | Purpose |
|------|---------|
| `~/Library/LaunchAgents/com.kilgore.dispatch-stale-watch.plist` | 60s tick → `scripts/dispatch-stale-watch.ts` |
| `~/Library/LaunchAgents/com.kilgore.sentinel-reverify.plist` | 30-min tick → `scripts/sentinel-reverify.ts` |
| `~/Library/LaunchAgents/com.kilgore.<agent>-heartbeat.plist` × N | 60s tick per agent — fallback if `local-agent-server.ts` doesn't host the heartbeat writer in v1 |

---

## Phase 1 — Schema + dispatch protocol

### Task 1: Add `dispatches` migration

**Files:**
- Modify: `src/db/migrations/sqlite.ts:148` (append before final `\``)
- Modify: `src/db/types.ts` (append new types at bottom)
- Test: `tests/dispatches/dispatches-repo.test.ts` (new file, deferred to Task 3)

- [ ] **Step 1: Add migration SQL**

Modify `src/db/migrations/sqlite.ts` — append inside the `adapter.exec()` template literal block, just before the closing backtick on line 149:

```sql
    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      dispatched_at INTEGER NOT NULL,
      from_actor TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      query_id TEXT,
      status TEXT NOT NULL,
      responded_at INTEGER,
      response TEXT,
      artifact_path TEXT,
      verify_signal_json TEXT,
      verify_status TEXT,
      verify_last_checked INTEGER,
      verify_failures_json TEXT,
      parent_dispatch_id INTEGER REFERENCES dispatches(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS dispatches_status_idx ON dispatches(status, dispatched_at);
    CREATE INDEX IF NOT EXISTS dispatches_to_agent_idx ON dispatches(to_agent, status);
    CREATE INDEX IF NOT EXISTS dispatches_query_id_idx ON dispatches(query_id) WHERE query_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS dispatches_verify_idx ON dispatches(verify_status, verify_last_checked) WHERE verify_status IS NOT NULL;
```

- [ ] **Step 2: Add types**

Append to `src/db/types.ts`:

```typescript
export type DispatchStatus =
  | 'queued'
  | 'in_flight'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'wedged';

export type VerifyStatus = 'pending' | 'pass' | 'fail';

export interface DispatchRow {
  id: number;
  team_id: string | null;
  dispatched_at: number;
  from_actor: string;
  to_agent: string;
  channel: string;
  message: string;
  query_id: string | null;
  status: DispatchStatus;
  responded_at: number | null;
  response: string | null;
  artifact_path: string | null;
  verify_signal_json: string | null;
  verify_status: VerifyStatus | null;
  verify_last_checked: number | null;
  verify_failures_json: string | null;
  parent_dispatch_id: number | null;
}
```

- [ ] **Step 3: Run existing migration tests to verify no regressions**

Run: `cd /Users/kilgore/Dropbox/Code/cane/id-agents && npx vitest run test/repos/migration.test.ts`
Expected: PASS (existing tests unchanged)

- [ ] **Step 4: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add src/db/migrations/sqlite.ts src/db/types.ts
git commit -m "Add dispatches table migration and types (12070 phase 1)"
```

---

### Task 2: Add `DispatchesRepository` interface

**Files:**
- Modify: `src/db/db-service.ts`

- [ ] **Step 1: Add interface**

Append to `src/db/db-service.ts`:

```typescript
import type { DispatchRow, DispatchStatus, VerifyStatus } from './types.js';

export interface CreateDispatchInput {
  team_id: string | null;
  dispatched_at: number;
  from_actor: string;
  to_agent: string;
  channel: string;
  message: string;
  query_id: string | null;
  verify_signal_json: string | null;
  parent_dispatch_id: number | null;
}

export interface DispatchListFilters {
  status?: DispatchStatus | DispatchStatus[];
  to_agent?: string;
  from_actor?: string;
  verify_status?: VerifyStatus;
  since?: number;          // unix epoch ms
  limit?: number;
}

export interface DispatchesRepository {
  create(input: CreateDispatchInput): Promise<number>;
  getById(id: number): Promise<DispatchRow | null>;
  list(filters?: DispatchListFilters): Promise<DispatchRow[]>;
  setStatus(id: number, status: DispatchStatus): Promise<void>;
  recordDone(id: number, fields: {
    responded_at: number;
    response: string | null;
    artifact_path: string | null;
    verify_signal_json: string | null;
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void>;
  updateVerify(id: number, fields: {
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void>;
  /** Rows where status='in_flight' AND dispatched_at < cutoff */
  findStale(cutoff: number, perAgentThresholds?: Record<string, number>): Promise<DispatchRow[]>;
  /** Rows needing re-verify: pending OR pass-stale */
  findReverifyCandidates(now: number, staleAfterMs: number): Promise<DispatchRow[]>;
}
```

Then add `dispatches: DispatchesRepository;` to whatever aggregate `Db` interface exists in this file (the explorer noted the pattern is the same as `tasks`, `teams`, etc.).

- [ ] **Step 2: Commit**

```bash
git add src/db/db-service.ts
git commit -m "Add DispatchesRepository interface (12070 phase 1)"
```

---

### Task 3: Implement `SqliteDispatchesRepo`

**Files:**
- Create: `src/db/repos/sqlite/dispatches-repo.ts`
- Test: `tests/dispatches/dispatches-repo.test.ts`

Modeled exactly on `src/db/repos/sqlite/tasks-repo.ts`. Same constructor, same `DbAdapter` injection.

- [ ] **Step 1: Write the failing test — create + getById**

Create `tests/dispatches/dispatches-repo.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteDispatchesRepo } from '../../src/db/repos/sqlite/dispatches-repo.js';

function freshRepo() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return new SqliteDispatchesRepo(adapter);
}

describe('SqliteDispatchesRepo', () => {
  it('creates a dispatch row and returns its id', async () => {
    const repo = freshRepo();
    const id = await repo.create({
      team_id: null,
      dispatched_at: 1000,
      from_actor: 'manager',
      to_agent: 'personal',
      channel: 'talk',
      message: 'do the thing',
      query_id: 'q-1',
      verify_signal_json: null,
      parent_dispatch_id: null,
    });
    assert.equal(typeof id, 'number');
    const row = await repo.getById(id);
    assert.ok(row);
    assert.equal(row.from_actor, 'manager');
    assert.equal(row.to_agent, 'personal');
    assert.equal(row.status, 'queued');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/kilgore/Dropbox/Code/cane/id-agents && npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: FAIL with "Cannot find module '...dispatches-repo.js'".

- [ ] **Step 3: Implement minimal `create` + `getById`**

Create `src/db/repos/sqlite/dispatches-repo.ts`:

```typescript
import type { DbAdapter } from '../../db-adapter.js';
import type {
  CreateDispatchInput,
  DispatchListFilters,
  DispatchesRepository,
} from '../../db-service.js';
import type { DispatchRow, DispatchStatus, VerifyStatus } from '../../types.js';

export class SqliteDispatchesRepo implements DispatchesRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(input: CreateDispatchInput): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `INSERT INTO dispatches
         (team_id, dispatched_at, from_actor, to_agent, channel, message,
          query_id, status, verify_signal_json, parent_dispatch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
       RETURNING id`,
      [
        input.team_id,
        input.dispatched_at,
        input.from_actor,
        input.to_agent,
        input.channel,
        input.message,
        input.query_id,
        input.verify_signal_json,
        input.parent_dispatch_id,
      ],
    );
    return result.rows[0]!.id;
  }

  async getById(id: number): Promise<DispatchRow | null> {
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(_filters?: DispatchListFilters): Promise<DispatchRow[]> {
    throw new Error('not yet implemented');
  }
  async setStatus(_id: number, _status: DispatchStatus): Promise<void> {
    throw new Error('not yet implemented');
  }
  async recordDone(): Promise<void> { throw new Error('not yet implemented'); }
  async updateVerify(): Promise<void> { throw new Error('not yet implemented'); }
  async findStale(): Promise<DispatchRow[]> { throw new Error('not yet implemented'); }
  async findReverifyCandidates(): Promise<DispatchRow[]> { throw new Error('not yet implemented'); }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/sqlite/dispatches-repo.ts tests/dispatches/dispatches-repo.test.ts
git commit -m "Implement SqliteDispatchesRepo create/getById (12070 phase 1)"
```

- [ ] **Step 6: Add tests for `setStatus`**

Add to `tests/dispatches/dispatches-repo.test.ts`:

```typescript
  it('flips status from queued → in_flight → done', async () => {
    const repo = freshRepo();
    const id = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'x',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.setStatus(id, 'in_flight');
    let row = await repo.getById(id);
    assert.equal(row!.status, 'in_flight');
    await repo.setStatus(id, 'done');
    row = await repo.getById(id);
    assert.equal(row!.status, 'done');
  });
```

- [ ] **Step 7: Run test, verify it fails**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: FAIL with "not yet implemented".

- [ ] **Step 8: Implement `setStatus`**

Replace `setStatus` in `src/db/repos/sqlite/dispatches-repo.ts`:

```typescript
  async setStatus(id: number, status: DispatchStatus): Promise<void> {
    await this.db.query(
      `UPDATE dispatches SET status = ? WHERE id = ?`,
      [status, id],
    );
  }
```

- [ ] **Step 9: Run test, verify it passes**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add src/db/repos/sqlite/dispatches-repo.ts tests/dispatches/dispatches-repo.test.ts
git commit -m "Implement DispatchesRepo.setStatus (12070 phase 1)"
```

- [ ] **Step 11: Add test for `recordDone`**

Add to `tests/dispatches/dispatches-repo.test.ts`:

```typescript
  it('records done with verify fields', async () => {
    const repo = freshRepo();
    const id = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'x',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.recordDone(id, {
      responded_at: 2000,
      response: 'ok',
      artifact_path: '/tmp/out.md',
      verify_signal_json: '{"type":"desk_tag","artifact_path":"/tmp/out.md","within_hours":24}',
      verify_status: 'pass',
      verify_last_checked: 2000,
      verify_failures_json: null,
    });
    const row = await repo.getById(id);
    assert.equal(row!.status, 'done');
    assert.equal(row!.verify_status, 'pass');
    assert.equal(row!.artifact_path, '/tmp/out.md');
    assert.equal(row!.responded_at, 2000);
  });
```

- [ ] **Step 12: Run test, verify it fails**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: FAIL with "not yet implemented".

- [ ] **Step 13: Implement `recordDone`**

Replace `recordDone` in `src/db/repos/sqlite/dispatches-repo.ts`:

```typescript
  async recordDone(id: number, fields: {
    responded_at: number;
    response: string | null;
    artifact_path: string | null;
    verify_signal_json: string | null;
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE dispatches
       SET status = 'done',
           responded_at = ?,
           response = ?,
           artifact_path = ?,
           verify_signal_json = ?,
           verify_status = ?,
           verify_last_checked = ?,
           verify_failures_json = ?
       WHERE id = ?`,
      [
        fields.responded_at,
        fields.response,
        fields.artifact_path,
        fields.verify_signal_json,
        fields.verify_status,
        fields.verify_last_checked,
        fields.verify_failures_json,
        id,
      ],
    );
  }
```

- [ ] **Step 14: Run test, verify it passes**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 15: Commit**

```bash
git add src/db/repos/sqlite/dispatches-repo.ts tests/dispatches/dispatches-repo.test.ts
git commit -m "Implement DispatchesRepo.recordDone (12070 phase 1)"
```

- [ ] **Step 16: Add tests for `list`, `updateVerify`, `findStale`, `findReverifyCandidates`**

Add to `tests/dispatches/dispatches-repo.test.ts`:

```typescript
  it('lists rows by status filter', async () => {
    const repo = freshRepo();
    const a = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'a',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.create({
      team_id: null, dispatched_at: 2000, from_actor: 'manager',
      to_agent: 'sentinel', channel: 'talk', message: 'b',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.setStatus(a, 'in_flight');
    const inFlight = await repo.list({ status: 'in_flight' });
    assert.equal(inFlight.length, 1);
    assert.equal(inFlight[0].message, 'a');
    const queued = await repo.list({ status: 'queued' });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].message, 'b');
  });

  it('updateVerify changes verify_status without touching dispatch status', async () => {
    const repo = freshRepo();
    const id = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'x',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.setStatus(id, 'done');
    await repo.updateVerify(id, {
      verify_status: 'fail',
      verify_last_checked: 5000,
      verify_failures_json: '[{"check":"http_get","reason":"404"}]',
    });
    const row = await repo.getById(id);
    assert.equal(row!.status, 'done');
    assert.equal(row!.verify_status, 'fail');
    assert.equal(row!.verify_last_checked, 5000);
  });

  it('findStale returns rows in_flight past cutoff', async () => {
    const repo = freshRepo();
    const old = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'old',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    const fresh = await repo.create({
      team_id: null, dispatched_at: 9000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'fresh',
      query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.setStatus(old, 'in_flight');
    await repo.setStatus(fresh, 'in_flight');
    const stale = await repo.findStale(5000);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].message, 'old');
  });

  it('findReverifyCandidates returns pending or stale-pass rows', async () => {
    const repo = freshRepo();
    const idPending = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'pending',
      query_id: null, verify_signal_json: '{"type":"desk_tag","artifact_path":"x","within_hours":24}',
      parent_dispatch_id: null,
    });
    await repo.recordDone(idPending, {
      responded_at: 1500, response: null, artifact_path: null,
      verify_signal_json: '{"type":"desk_tag","artifact_path":"x","within_hours":24}',
      verify_status: 'pending', verify_last_checked: 1500,
      verify_failures_json: null,
    });
    const idStale = await repo.create({
      team_id: null, dispatched_at: 2000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'stale',
      query_id: null, verify_signal_json: '{"type":"desk_tag","artifact_path":"y","within_hours":24}',
      parent_dispatch_id: null,
    });
    await repo.recordDone(idStale, {
      responded_at: 2500, response: null, artifact_path: null,
      verify_signal_json: '{"type":"desk_tag","artifact_path":"y","within_hours":24}',
      verify_status: 'pass', verify_last_checked: 2500,
      verify_failures_json: null,
    });
    // now = 100000, staleAfterMs = 10000  → stale-pass row qualifies
    const candidates = await repo.findReverifyCandidates(100000, 10000);
    const messages = candidates.map(r => r.message).sort();
    assert.deepEqual(messages, ['pending', 'stale']);
  });
```

- [ ] **Step 17: Run tests, verify they fail**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: 4 NEW FAILS, 3 PASS.

- [ ] **Step 18: Implement remaining methods**

Replace the four `not yet implemented` stubs in `src/db/repos/sqlite/dispatches-repo.ts`:

```typescript
  async list(filters?: DispatchListFilters): Promise<DispatchRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filters?.to_agent) {
      clauses.push('to_agent = ?'); params.push(filters.to_agent);
    }
    if (filters?.from_actor) {
      clauses.push('from_actor = ?'); params.push(filters.from_actor);
    }
    if (filters?.verify_status) {
      clauses.push('verify_status = ?'); params.push(filters.verify_status);
    }
    if (filters?.since !== undefined) {
      clauses.push('dispatched_at >= ?'); params.push(filters.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters?.limit ? `LIMIT ${filters.limit}` : 'LIMIT 200';
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches ${where} ORDER BY dispatched_at DESC ${limit}`,
      params,
    );
    return rows;
  }

  async updateVerify(id: number, fields: {
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE dispatches
         SET verify_status = ?, verify_last_checked = ?, verify_failures_json = ?
       WHERE id = ?`,
      [fields.verify_status, fields.verify_last_checked, fields.verify_failures_json, id],
    );
  }

  async findStale(cutoff: number, _perAgentThresholds?: Record<string, number>): Promise<DispatchRow[]> {
    // v1: single global cutoff. Per-agent thresholds become a follow-up.
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches WHERE status = 'in_flight' AND dispatched_at < ? ORDER BY dispatched_at ASC`,
      [cutoff],
    );
    return rows;
  }

  async findReverifyCandidates(now: number, staleAfterMs: number): Promise<DispatchRow[]> {
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches
       WHERE status = 'done'
         AND verify_signal_json IS NOT NULL
         AND (
           verify_status = 'pending'
           OR (verify_status = 'pass' AND verify_last_checked < ?)
         )
       ORDER BY verify_last_checked ASC
       LIMIT 50`,
      [now - staleAfterMs],
    );
    return rows;
  }
```

- [ ] **Step 19: Run tests, verify all pass**

Run: `npx vitest run tests/dispatches/dispatches-repo.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 20: Commit**

```bash
git add src/db/repos/sqlite/dispatches-repo.ts tests/dispatches/dispatches-repo.test.ts
git commit -m "Implement DispatchesRepo list/updateVerify/findStale/findReverifyCandidates (12070 phase 1)"
```

---

### Task 4: Wire `dispatches` into the `Db` factory

**Files:**
- Modify: `src/db/index.ts`

- [ ] **Step 1: Inspect current factory**

Read `src/db/index.ts` to see how `tasks` is wired into the returned `Db` object.

- [ ] **Step 2: Add `dispatches` next to `tasks`**

In `src/db/index.ts`, alongside the existing `tasks: new SqliteTasksRepo(adapter)` line (or equivalent), add:

```typescript
import { SqliteDispatchesRepo } from './repos/sqlite/dispatches-repo.js';
// ...
return {
  // ...existing repos...
  dispatches: new SqliteDispatchesRepo(adapter),
};
```

(Match the local style — if the file uses an aggregate type, add the field there too.)

- [ ] **Step 3: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/index.ts
git commit -m "Wire dispatches repo into Db factory (12070 phase 1)"
```

---

### Task 5: Verify_signal types and runner skeleton

**Files:**
- Create: `src/verify/types.ts`
- Create: `src/verify/runner.ts`
- Test: `tests/verify/runner.test.ts`

- [ ] **Step 1: Create types**

Create `src/verify/types.ts`:

```typescript
export interface HttpGetCheck {
  type: 'http_get';
  url: string;
  must_contain?: string;
  status?: number;          // default 200
}

export interface FileMtimeCheck {
  type: 'file_mtime';
  path: string;
  after: number;            // unix epoch seconds
}

export interface DeskTagCheck {
  type: 'desk_tag';
  artifact_path: string;
  within_hours: number;
}

export interface ApiCallCheck {
  type: 'api_call';
  service: 'gmail' | 'resend' | 'telegram' | 'trello' | 'vercel_deploy';
  check: string;
  id: string;
}

export interface AllCheck {
  type: 'all';
  checks: VerifySignal[];
}

export type VerifySignal =
  | HttpGetCheck
  | FileMtimeCheck
  | DeskTagCheck
  | ApiCallCheck
  | AllCheck;

export interface VerifyFailure {
  check: VerifySignal;
  reason: string;
}

export interface VerifyResult {
  status: 'pass' | 'fail';
  failures: VerifyFailure[];
}

export interface VerifyContext {
  /** dispatched_at unix epoch ms — anchor for desk_tag windows */
  dispatched_at: number;
  /** Path to Desk.md — defaults to ~/Dropbox/Obsidian/Desk.md */
  desk_path?: string;
  /** Override for fetch (tests inject fakes) */
  fetch?: typeof fetch;
  /** Override for fs reads (tests inject fakes) */
  readFile?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ mtimeMs: number }>;
}
```

- [ ] **Step 2: Write the failing test for `runVerifySignal` with `desk_tag`**

Create `tests/verify/runner.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runVerifySignal } from '../../src/verify/runner.js';
import type { VerifyContext } from '../../src/verify/types.js';

describe('runVerifySignal', () => {
  it('passes desk_tag when artifact path is in Desk.md', async () => {
    const ctx: VerifyContext = {
      dispatched_at: 1000,
      readFile: async () => '# Desk\n\n- [foo](/path/to/artifact.md)\n',
    };
    const result = await runVerifySignal(
      { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      ctx,
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.failures.length, 0);
  });

  it('fails desk_tag when artifact path is missing from Desk.md', async () => {
    const ctx: VerifyContext = {
      dispatched_at: 1000,
      readFile: async () => '# Desk\n\nnothing relevant\n',
    };
    const result = await runVerifySignal(
      { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      ctx,
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.failures.length, 1);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd /Users/kilgore/Dropbox/Code/cane/id-agents && npx vitest run tests/verify/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement runner with desk_tag check**

Create `src/verify/runner.ts`:

```typescript
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  VerifySignal,
  VerifyResult,
  VerifyFailure,
  VerifyContext,
  DeskTagCheck,
} from './types.js';

const DEFAULT_DESK_PATH = join(homedir(), 'Dropbox/Obsidian/Desk.md');

export async function runVerifySignal(
  signal: VerifySignal,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];

  switch (signal.type) {
    case 'desk_tag': {
      const failure = await checkDeskTag(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
    case 'all': {
      for (const sub of signal.checks) {
        const subResult = await runVerifySignal(sub, ctx);
        failures.push(...subResult.failures);
      }
      break;
    }
    case 'http_get':
    case 'file_mtime':
    case 'api_call':
      failures.push({ check: signal, reason: `${signal.type} not yet implemented` });
      break;
  }

  return { status: failures.length ? 'fail' : 'pass', failures };
}

async function checkDeskTag(check: DeskTagCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const path = ctx.desk_path ?? DEFAULT_DESK_PATH;
  const reader = ctx.readFile ?? ((p: string) => fs.readFile(p, 'utf-8'));
  let content: string;
  try {
    content = await reader(path);
  } catch (err) {
    return { check, reason: `desk read failed: ${(err as Error).message}` };
  }
  if (!content.includes(check.artifact_path)) {
    return { check, reason: `artifact_path "${check.artifact_path}" not on Desk` };
  }
  // within_hours guard:
  // dispatched_at + within_hours*3600*1000 must be in the future, i.e. window still open.
  const windowEnd = ctx.dispatched_at + check.within_hours * 3600 * 1000;
  if (Date.now() > windowEnd) {
    return { check, reason: `desk_tag window of ${check.within_hours}h elapsed` };
  }
  return null;
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run tests/verify/runner.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/verify/types.ts src/verify/runner.ts tests/verify/runner.test.ts
git commit -m "Add verify_signal runner with desk_tag check (12070 phase 1)"
```

---

### Task 6: Implement `http_get` and `file_mtime` checks

**Files:**
- Modify: `src/verify/runner.ts`
- Modify: `tests/verify/runner.test.ts`

- [ ] **Step 1: Add tests for http_get**

Append to `tests/verify/runner.test.ts`:

```typescript
  it('passes http_get when fetch returns 200 + must_contain hits', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () => new Response('hello world', { status: 200 })) as typeof fetch,
    };
    const result = await runVerifySignal(
      { type: 'http_get', url: 'https://example.com', must_contain: 'hello' },
      ctx,
    );
    assert.equal(result.status, 'pass');
  });

  it('fails http_get when status mismatches', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
    };
    const result = await runVerifySignal(
      { type: 'http_get', url: 'https://example.com' },
      ctx,
    );
    assert.equal(result.status, 'fail');
  });

  it('fails http_get when must_contain misses', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () => new Response('goodbye', { status: 200 })) as typeof fetch,
    };
    const result = await runVerifySignal(
      { type: 'http_get', url: 'https://example.com', must_contain: 'hello' },
      ctx,
    );
    assert.equal(result.status, 'fail');
  });
```

- [ ] **Step 2: Add tests for file_mtime**

Append:

```typescript
  it('passes file_mtime when stat shows mtime after the threshold', async () => {
    const ctx: VerifyContext = {
      dispatched_at: 1000,
      statFile: async () => ({ mtimeMs: 5000 }),
    };
    const result = await runVerifySignal(
      { type: 'file_mtime', path: '/tmp/x', after: 4 },     // 4 seconds = 4000 ms
      ctx,
    );
    assert.equal(result.status, 'pass');
  });

  it('fails file_mtime when mtime predates the threshold', async () => {
    const ctx: VerifyContext = {
      dispatched_at: 1000,
      statFile: async () => ({ mtimeMs: 100 }),
    };
    const result = await runVerifySignal(
      { type: 'file_mtime', path: '/tmp/x', after: 4 },
      ctx,
    );
    assert.equal(result.status, 'fail');
  });
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npx vitest run tests/verify/runner.test.ts`
Expected: 5 fail (the 4 new ones + a regression in `all` if we re-run http_get/file_mtime sub-checks). 2 pass.

- [ ] **Step 4: Implement http_get + file_mtime in runner**

Modify `src/verify/runner.ts` — replace the `case 'http_get':` and `case 'file_mtime':` lines with full implementations:

```typescript
    case 'http_get': {
      const failure = await checkHttpGet(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
    case 'file_mtime': {
      const failure = await checkFileMtime(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
```

Then add helpers at the bottom of the file:

```typescript
import type { HttpGetCheck, FileMtimeCheck } from './types.js';

async function checkHttpGet(check: HttpGetCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const fetcher = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(check.url);
  } catch (err) {
    return { check, reason: `fetch failed: ${(err as Error).message}` };
  }
  const expected = check.status ?? 200;
  if (response.status !== expected) {
    return { check, reason: `status ${response.status} ≠ expected ${expected}` };
  }
  if (check.must_contain) {
    const text = await response.text();
    if (!text.includes(check.must_contain)) {
      return { check, reason: `body missing "${check.must_contain}"` };
    }
  }
  return null;
}

async function checkFileMtime(check: FileMtimeCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const stat = ctx.statFile ?? (async (p: string) => {
    const s = await fs.stat(p);
    return { mtimeMs: s.mtimeMs };
  });
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(check.path)).mtimeMs;
  } catch (err) {
    return { check, reason: `stat failed: ${(err as Error).message}` };
  }
  // `after` is unix epoch seconds per the spec
  if (mtimeMs / 1000 < check.after) {
    return { check, reason: `mtime ${new Date(mtimeMs).toISOString()} is before ${new Date(check.after * 1000).toISOString()}` };
  }
  return null;
}
```

(Hoist the type imports to the top of the file if not already there. Also keep the `fs` import.)

- [ ] **Step 5: Run tests, verify all pass**

Run: `npx vitest run tests/verify/runner.test.ts`
Expected: PASS (6 tests total at this point — `desk_tag pass/fail`, `http_get` 3, `file_mtime` 2; if you also wrote an `all` test earlier, it counts here).

- [ ] **Step 6: Commit**

```bash
git add src/verify/runner.ts tests/verify/runner.test.ts
git commit -m "Implement http_get and file_mtime verify checks (12070 phase 1)"
```

---

### Task 7: Implement `api_call` check (Vercel deploy first)

The spec lists 5 services for `api_call`. v1 ships only `vercel_deploy` because it's the immediate motivator (health.caneyfork.dev). The other 4 ship as follow-up specs.

**Files:**
- Modify: `src/verify/runner.ts`
- Modify: `tests/verify/runner.test.ts`

- [ ] **Step 1: Add test for vercel_deploy**

Append to `tests/verify/runner.test.ts`:

```typescript
  it('passes api_call vercel_deploy when state is READY', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () => new Response(JSON.stringify({ readyState: 'READY' }), { status: 200 })) as typeof fetch,
    };
    const result = await runVerifySignal(
      { type: 'api_call', service: 'vercel_deploy', check: 'deployment_ready', id: 'dpl_xyz' },
      ctx,
    );
    assert.equal(result.status, 'pass');
  });

  it('fails api_call vercel_deploy when state is ERROR', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () => new Response(JSON.stringify({ readyState: 'ERROR' }), { status: 200 })) as typeof fetch,
    };
    const result = await runVerifySignal(
      { type: 'api_call', service: 'vercel_deploy', check: 'deployment_ready', id: 'dpl_xyz' },
      ctx,
    );
    assert.equal(result.status, 'fail');
  });

  it('fails unimplemented api_call services with a clear reason', async () => {
    const ctx: VerifyContext = { dispatched_at: Date.now() };
    const result = await runVerifySignal(
      { type: 'api_call', service: 'gmail', check: 'sent', id: 'm-1' },
      ctx,
    );
    assert.equal(result.status, 'fail');
    assert.match(result.failures[0].reason, /not yet implemented/);
  });
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npx vitest run tests/verify/runner.test.ts`
Expected: 3 NEW FAILS.

- [ ] **Step 3: Implement vercel_deploy check**

Replace the `case 'api_call':` block in `src/verify/runner.ts`:

```typescript
    case 'api_call': {
      const failure = await checkApiCall(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
```

Add helper:

```typescript
import type { ApiCallCheck } from './types.js';

async function checkApiCall(check: ApiCallCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  if (check.service !== 'vercel_deploy') {
    return { check, reason: `api_call service "${check.service}" not yet implemented (file separate spec)` };
  }
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return { check, reason: 'VERCEL_TOKEN env var not set' };
  }
  const fetcher = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`https://api.vercel.com/v13/deployments/${check.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { check, reason: `vercel api fetch failed: ${(err as Error).message}` };
  }
  if (response.status !== 200) {
    return { check, reason: `vercel api returned ${response.status}` };
  }
  const body = await response.json() as { readyState?: string };
  if (body.readyState !== 'READY') {
    return { check, reason: `deployment readyState=${body.readyState ?? 'unknown'}` };
  }
  return null;
}
```

(Hoist `ApiCallCheck` import; in the test injection above no `VERCEL_TOKEN` env is needed because we replace `fetch` directly — but the implementation reads it. Update the first two test cases to pre-set `process.env.VERCEL_TOKEN = 'fake'` in a `before` hook OR refactor `checkApiCall` to skip the token check when `ctx.fetch` is injected. Simpler: read token AFTER the fetcher override — if `ctx.fetch` is provided, skip the token gate.)

Adjust the helper to:

```typescript
async function checkApiCall(check: ApiCallCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  if (check.service !== 'vercel_deploy') {
    return { check, reason: `api_call service "${check.service}" not yet implemented (file separate spec)` };
  }
  const fetcher = ctx.fetch;
  if (!fetcher && !process.env.VERCEL_TOKEN) {
    return { check, reason: 'VERCEL_TOKEN env var not set' };
  }
  const f = fetcher ?? fetch;
  const headers: Record<string, string> = {};
  if (process.env.VERCEL_TOKEN) headers.Authorization = `Bearer ${process.env.VERCEL_TOKEN}`;
  // ...rest as before, using `f` and `headers`
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/verify/runner.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/verify/runner.ts tests/verify/runner.test.ts
git commit -m "Implement vercel_deploy api_call verify check (12070 phase 1)"
```

---

### Task 8: Add `POST /dispatches` endpoint to manager

**Files:**
- Modify: `src/agent-manager-db.ts` (after the existing `/tasks` POST handler around line 2711)
- Test: extend an existing manager-route test or add `tests/manager/dispatches-endpoint.test.ts`

- [ ] **Step 1: Inspect how the existing `POST /tasks` handler is structured**

Read `src/agent-manager-db.ts` lines 2700–2900 to learn the routing pattern (Express? Hono? raw http?). Match it exactly.

- [ ] **Step 2: Write the failing test**

Create `tests/manager/dispatches-endpoint.test.ts`. Use whatever harness the existing manager tests use (look in `test/` for an existing route test as the template). The test should:

```typescript
// Pseudocode — adapt to actual harness style.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestManager } from '../helpers/test-manager.js';  // or inline

describe('POST /dispatches', () => {
  it('creates a queued dispatch and returns its id', async () => {
    const { url, db, stop } = await startTestManager();
    try {
      const res = await fetch(`${url}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_actor: 'manager',
          to_agent: 'personal',
          channel: 'talk',
          message: 'do x',
          query_id: 'q-1',
          verify_signal: { type: 'desk_tag', artifact_path: '/x.md', within_hours: 24 },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.dispatch_id, 'number');
      assert.equal(body.status, 'queued');
      const row = await db.dispatches.getById(body.dispatch_id);
      assert.equal(row!.from_actor, 'manager');
      assert.equal(row!.verify_signal_json, JSON.stringify({
        type: 'desk_tag', artifact_path: '/x.md', within_hours: 24,
      }));
    } finally {
      await stop();
    }
  });

  it('applies default DoD when verify_signal is omitted', async () => {
    const { url, db, stop } = await startTestManager();
    try {
      const res = await fetch(`${url}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_actor: 'cane',
          to_agent: 'personal',
          channel: 'talk',
          message: 'newsletter draft',
          query_id: 'q-2',
        }),
      });
      const body = await res.json();
      const row = await db.dispatches.getById(body.dispatch_id);
      const signal = JSON.parse(row!.verify_signal_json!);
      assert.equal(signal.type, 'desk_tag');
      assert.equal(signal.within_hours, 24);
      assert.equal(signal.artifact_path, '<TBD by agent>');
    } finally {
      await stop();
    }
  });
});
```

If `startTestManager` doesn't exist as a helper, write the simplest possible one in `tests/helpers/test-manager.ts` that boots `AgentManagerDb` against `:memory:` on an ephemeral port. Match the style of the existing test that boots the manager (find it via `grep -rn 'AgentManagerDb' test/`).

- [ ] **Step 3: Run test, verify it fails**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: FAIL with 404 or "endpoint not found".

- [ ] **Step 4: Add the handler in `agent-manager-db.ts`**

Find the POST /tasks handler (around line 2711). Add a sibling handler:

```typescript
// POST /dispatches — record a dispatch row before /talk fires.
// Response: { dispatch_id, status }
this.app.post('/dispatches', async (req, res) => {
  const body = req.body as {
    from_actor?: string;
    to_agent?: string;
    channel?: string;
    message?: string;
    query_id?: string | null;
    verify_signal?: unknown;
    parent_dispatch_id?: number | null;
  };
  if (!body.from_actor || !body.to_agent || !body.channel || !body.message) {
    return res.status(400).json({ error: 'from_actor, to_agent, channel, message required' });
  }
  // Default DoD = desk_tag within 24h, artifact_path filled in at /agent-done.
  const signal = body.verify_signal ?? {
    type: 'desk_tag',
    artifact_path: '<TBD by agent>',
    within_hours: 24,
  };
  const id = await this.db.dispatches.create({
    team_id: null,                 // future: derive from body or auth
    dispatched_at: Date.now(),
    from_actor: body.from_actor,
    to_agent: body.to_agent,
    channel: body.channel,
    message: body.message,
    query_id: body.query_id ?? null,
    verify_signal_json: JSON.stringify(signal),
    parent_dispatch_id: body.parent_dispatch_id ?? null,
  });
  res.json({ dispatch_id: id, status: 'queued' });
});
```

(Adapt method calls — `req.body`, `res.json`, etc. — to whatever framework the file actually uses. The existing `/tasks` handler is the model.)

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent-manager-db.ts tests/manager/dispatches-endpoint.test.ts tests/helpers/test-manager.ts
git commit -m "Add POST /dispatches manager endpoint with default DoD (12070 phase 1)"
```

---

### Task 9: Auto-flip `queued → in_flight` after `/talk` succeeds

**Files:**
- Modify: `src/agent-manager-db.ts` (whatever code dispatches `/talk` after a `POST /dispatches` — or, for v1, the dispatchers do this themselves with a separate endpoint)

For v1 simplicity: add a `POST /dispatches/:id/in-flight` endpoint dispatchers can call after their `/talk` returns 2xx. Don't entangle the manager `/talk` handler.

- [ ] **Step 1: Add test**

Append to `tests/manager/dispatches-endpoint.test.ts`:

```typescript
  it('flips status to in_flight on POST /dispatches/:id/in-flight', async () => {
    const { url, db, stop } = await startTestManager();
    try {
      const create = await fetch(`${url}/dispatches`, { /* same as test 1 */ });
      const { dispatch_id } = await create.json();
      const flip = await fetch(`${url}/dispatches/${dispatch_id}/in-flight`, { method: 'POST' });
      assert.equal(flip.status, 200);
      const row = await db.dispatches.getById(dispatch_id);
      assert.equal(row!.status, 'in_flight');
    } finally { await stop(); }
  });
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add handler**

Add to `src/agent-manager-db.ts`:

```typescript
this.app.post('/dispatches/:id/in-flight', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  await this.db.dispatches.setStatus(id, 'in_flight');
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent-manager-db.ts tests/manager/dispatches-endpoint.test.ts
git commit -m "Add POST /dispatches/:id/in-flight handler (12070 phase 1)"
```

---

### Task 10: Extend `/agent-done` (M1 service) to accept `dispatch_id` + `verify_signal`

The `/agent-done` endpoint runs as a **separate service on M1 port 4239**, not in `agent-manager-db.ts`. Per `~/Dropbox/Code/cane/CLAUDE.md` lines 70–90 (Spec 048).

**Files:**
- Modify: the M1 `/agent-done` server source. Locate via:

  ```bash
  ssh chrispowers@tsharkz 'launchctl list | grep cane-agent-done && cat ~/Library/LaunchAgents/com.kilgore.cane-agent-done.plist | grep -A1 ProgramArguments'
  ```

  Likely path: `~/Dropbox/Code/cane/cane-agent-done/server.py` or similar.

- [ ] **Step 1: Locate the source file**

Run the SSH commands above. Note the path. Pull the file into context.

- [ ] **Step 2: Add a test for the new payload fields**

Add a test in the same style as the existing tests in that repo. The test must:
- POST `/agent-done` with `dispatch_id` and `verify_signal`
- Assert that the dispatches row (in `id-agents.db`) flips to `done` with the verify result populated.

(Path TBD by Roger after locating source.)

- [ ] **Step 3: Modify the handler**

The handler today flips the inbox row. New behavior on top:

1. If `dispatch_id` is present, look it up in `id-agents.db` (this service may currently only know about a different DB — if so, add a read connection to `id-agents.db`).
2. If `verify_signal` is present, run the runner (`src/verify/runner.ts` — published as a small npm package or copied into this service; if the service is Python, port the runner — see Task 10b).
3. Call `dispatchesRepo.recordDone(dispatch_id, { responded_at, response, artifact_path, verify_signal_json, verify_status, verify_last_checked: now, verify_failures_json })`.

- [ ] **Step 4: Decide runner port — Python or shared TS**

Two options:

**Option A** (recommended): Move `/agent-done` into the manager process at port 4100 by mounting a new route. Reuses the TS runner. Removes one moving part. Keeps the M1 service as a thin proxy that forwards to the manager.

**Option B**: Port the verify runner to Python in the existing M1 service. Slower, more code to maintain, but no reorg.

Pick A unless there's a reason the M1 service must remain canonical. Document the choice in a one-paragraph commit message.

- [ ] **Step 5: Implement the chosen option**

For Option A:
- Add `POST /agent-done` to `src/agent-manager-db.ts` next to the dispatches handlers.
- Update the existing M1 service to forward incoming requests to `http://localhost:4100/agent-done` (or the manager URL the M1 box can reach).
- Both endpoints accept the same payload shape so existing callers don't break.

```typescript
this.app.post('/agent-done', async (req, res) => {
  const body = req.body as {
    query_id?: string;
    dispatch_id?: number;
    agent?: string;
    artifact_path?: string;
    tl_dr?: string;
    urgency?: string;
    response?: string;
    verify_signal?: unknown;
  };
  const dispatchId = body.dispatch_id ?? null;
  let verifyResult: VerifyResult = { status: 'pass', failures: [] };
  let signalJson: string | null = null;
  if (body.verify_signal && dispatchId) {
    signalJson = JSON.stringify(body.verify_signal);
    const dispatch = await this.db.dispatches.getById(dispatchId);
    if (dispatch) {
      verifyResult = await runVerifySignal(body.verify_signal as VerifySignal, {
        dispatched_at: dispatch.dispatched_at,
      });
    }
  }
  if (dispatchId) {
    await this.db.dispatches.recordDone(dispatchId, {
      responded_at: Date.now(),
      response: body.response ?? null,
      artifact_path: body.artifact_path ?? null,
      verify_signal_json: signalJson,
      verify_status: verifyResult.status,
      verify_last_checked: Date.now(),
      verify_failures_json: verifyResult.failures.length
        ? JSON.stringify(verifyResult.failures)
        : null,
    });
  }
  // Existing inbox-flip behavior — preserve. Move from M1 service or call out to it.
  // ...

  res.json({
    ok: true,
    dispatch_id: dispatchId,
    verify_status: verifyResult.status,
    verify_failures: verifyResult.failures,
  });
});
```

- [ ] **Step 6: Add test**

```typescript
it('extended /agent-done flips dispatch row and records verify result', async () => {
  const { url, db, stop } = await startTestManager();
  try {
    const create = await fetch(`${url}/dispatches`, { /* ... with desk_tag verify_signal ... */ });
    const { dispatch_id } = await create.json();
    // Stub Desk.md fetch by writing a temp file the runner can read,
    // OR inject ctx.readFile via a manager-test override hook.
    const done = await fetch(`${url}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id,
        agent: 'personal',
        artifact_path: '/path/to/artifact.md',
        verify_signal: { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      }),
    });
    const body = await done.json();
    assert.equal(body.ok, true);
    const row = await db.dispatches.getById(dispatch_id);
    assert.equal(row!.status, 'done');
    assert.ok(row!.verify_status === 'pass' || row!.verify_status === 'fail');
  } finally { await stop(); }
});
```

(May need to add a `desk_path` parameter to manager so tests can override.)

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agent-manager-db.ts tests/
git commit -m "Move /agent-done to manager, run verify_signal server-side (12070 phase 1)"
```

- [ ] **Step 9: Update M1 service to forward to manager**

Edit the M1 `cane-agent-done/server.py` (or wherever) to forward POSTs to `http://<manager-host>:4100/agent-done`. Keep the same response contract so existing callers don't notice.

- [ ] **Step 10: Restart M1 service and smoke-test**

```bash
ssh chrispowers@tsharkz 'launchctl unload ~/Library/LaunchAgents/com.kilgore.cane-agent-done.plist && launchctl load ~/Library/LaunchAgents/com.kilgore.cane-agent-done.plist'
# Smoke:
curl -s -X POST http://m1:4239/agent-done \
  -H 'Content-Type: application/json' \
  -d '{"agent":"smoke","artifact_path":"/tmp/x","tl_dr":"smoke test"}'
# Expect: {"ok":true,...}
```

- [ ] **Step 11: Commit M1 service change**

```bash
# In whatever repo cane-agent-done lives in
git add server.py
git commit -m "Forward /agent-done to manager for dispatch + verify (12070 phase 1)"
```

---

### Task 11: Integration test — manager dispatch end-to-end with personal agent

**Files:**
- Update: `~/Dropbox/Code/personal/CLAUDE.md` (add the `dispatch_id` thread-through and self-verify reminder — minimal first cut, refined in Phase 2)
- Manual: dispatch a real workload to verify wiring

- [ ] **Step 1: Add minimal CLAUDE.md instruction for personal agent**

Append to `~/Dropbox/Code/personal/CLAUDE.md`, under the existing health-import Definition-of-Done block:

```markdown
### Reporting done — dispatch protocol

If your /talk payload contains `dispatch_id`, include it in your /agent-done call:

```json
{
  "query_id": "...",
  "dispatch_id": 4173,
  "agent": "personal",
  "artifact_path": "...",
  "tl_dr": "...",
  "verify_signal": { "type": "all", "checks": [...] }
}
```

Construct `verify_signal` to match the work you actually did. For health imports
that's `{ "type": "http_get", "url": "https://health.caneyfork.dev/run/<date>", "must_contain": "<distance>" }` plus a desk_tag.

Run the verify checks yourself **before** posting /agent-done. If a check fails,
fix it (re-deploy, re-tag) and only then report done. The manager runs the same
checks server-side; reporting done with a failing self-check is a bug.
```

- [ ] **Step 2: Dispatch a real test**

Manually (you, reading this plan) invoke:

```bash
DISPATCH_ID=$(curl -s -X POST http://localhost:4100/dispatches \
  -H 'Content-Type: application/json' \
  -d '{
    "from_actor":"manager",
    "to_agent":"personal",
    "channel":"talk",
    "message":"smoke test: write /tmp/12070-smoke.md and tag the desk",
    "query_id":"smoke-12070",
    "verify_signal":{"type":"file_mtime","path":"/tmp/12070-smoke.md","after":'$(date +%s)'}
  }' | jq -r .dispatch_id)
echo "dispatch_id=$DISPATCH_ID"

curl -s -X POST http://localhost:4122/talk \
  -H 'Content-Type: application/json' \
  -d "{\"query_id\":\"smoke-12070\",\"dispatch_id\":$DISPATCH_ID,\"message\":\"...\"}"

curl -s -X POST http://localhost:4100/dispatches/$DISPATCH_ID/in-flight
# Wait for personal agent to finish.
sqlite3 ~/.id-agents/id-agents.db "SELECT id, status, verify_status FROM dispatches WHERE id = $DISPATCH_ID"
# Expect: id=$DISPATCH_ID | done | pass
```

- [ ] **Step 3: Commit personal CLAUDE.md change**

```bash
cd ~/Dropbox/Code/personal && git add CLAUDE.md && git commit -m "Personal agent: include dispatch_id + verify_signal in /agent-done (12070)"
```

**Phase 1 ships when this end-to-end test passes.**

---

## Phase 2 — Agent rollout

### Task 12: Roll the CLAUDE.md instruction to all agents

**Files:**
- Modify each: `~/Dropbox/Code/cane/CLAUDE.md`, `~/Dropbox/Code/roger/CLAUDE.md`, `~/Dropbox/Code/sentinel/CLAUDE.md`, `~/Dropbox/Code/cleveland-park/CLAUDE.md`, `~/Dropbox/Code/defi/CLAUDE.md`, `~/Dropbox/Code/finances/CLAUDE.md`, `~/Dropbox/Code/pipeline/CLAUDE.md`, `~/Dropbox/Code/trinity/CLAUDE.md`

- [ ] **Step 1: Author one canonical block**

Save as `~/Dropbox/Code/cane/id-agents/docs/agent-instructions/dispatch-protocol-v1.md`:

```markdown
## Dispatch protocol — closing the loop with verify_signal

If your `/talk` payload includes a `dispatch_id`, you MUST:

1. Do the work, write the artifact.
2. Construct a `verify_signal` describing what "done" means for this work.
3. Run the verify checks locally (curl, file stat, etc.). If any fails, fix it
   before reporting done.
4. POST to `/agent-done` with both `dispatch_id` and `verify_signal`.

verify_signal shape — pick the type that fits:

```json
{ "type": "http_get", "url": "...", "must_contain": "..." }
{ "type": "file_mtime", "path": "...", "after": <unix-seconds> }
{ "type": "desk_tag", "artifact_path": "...", "within_hours": 24 }
{ "type": "api_call", "service": "vercel_deploy", "check": "deployment_ready", "id": "dpl_xyz" }
{ "type": "all", "checks": [ ... ] }
```

If you don't know what to use, default to `desk_tag` within 24h pointing at your
artifact. The manager applies this default when a dispatcher omits the field —
but you should still echo it in `/agent-done`.
```

- [ ] **Step 2: Append-include in each agent's CLAUDE.md**

For each agent file in the list, append:

```markdown
## Dispatch protocol — closing the loop

See [docs/agent-instructions/dispatch-protocol-v1.md](~/Dropbox/Code/cane/id-agents/docs/agent-instructions/dispatch-protocol-v1.md) for the v1 protocol. Summary: when /talk includes a `dispatch_id`, include it plus a `verify_signal` in your /agent-done. Self-verify before reporting done.
```

(Append rather than rewrite — these files have agent-specific content earlier.)

- [ ] **Step 3: Commit each repo separately**

```bash
for d in cane roger sentinel cleveland-park defi finances pipeline trinity; do
  cd ~/Dropbox/Code/$d
  git add CLAUDE.md
  git commit -m "Add dispatch protocol v1 self-verify instruction (12070 phase 2)"
done
```

---

### Task 13: Wire the cane poller to call `POST /dispatches`

**Files:**
- Modify: `~/Dropbox/Code/cane/taskview/cane_routing.py:294` (and surrounding `_dispatch_to_agent`)

- [ ] **Step 1: Read the existing dispatcher**

Pull `cane_routing.py` lines 269–315 into context.

- [ ] **Step 2: Add a `_register_dispatch` helper**

Insert above `_dispatch_to_agent`:

```python
def _register_dispatch(
    base_url: str,
    *,
    from_actor: str,
    to_agent: str,
    channel: str,
    message: str,
    query_id: Optional[str],
    verify_signal: Optional[dict],
) -> Optional[int]:
    """POST /dispatches and return the dispatch_id, or None on failure (non-fatal)."""
    try:
        resp = requests.post(
            f"{base_url}/dispatches",
            json={
                "from_actor": from_actor,
                "to_agent": to_agent,
                "channel": channel,
                "message": message,
                "query_id": query_id,
                "verify_signal": verify_signal,
            },
            timeout=5,
        )
        resp.raise_for_status()
        return int(resp.json().get("dispatch_id"))
    except Exception as e:
        print(f"[cane_routing] dispatch register failed (non-fatal): {e}", file=sys.stderr)
        return None
```

- [ ] **Step 3: Modify `_dispatch_to_agent` to call the helper first**

In the body of `_dispatch_to_agent` (around line 269), before the existing `requests.post(f"{base_url}/talk", ...)`:

```python
dispatch_id = _register_dispatch(
    base_url,
    from_actor='cane',
    to_agent=agent_name,
    channel='talk',
    message=message_text,           # use whatever variable holds the prompt
    query_id=query_id,
    verify_signal=None,             # let manager apply default DoD
)
talk_payload = {
    'query_id': query_id,
    'message': message_text,
    'dispatch_id': dispatch_id,     # threaded through
}
talk_resp = requests.post(f"{base_url}/talk", json=talk_payload, timeout=10)
talk_resp.raise_for_status()
if dispatch_id is not None:
    try:
        requests.post(f"{base_url}/dispatches/{dispatch_id}/in-flight", timeout=5)
    except Exception:
        pass
```

(Adapt variable names to the actual code — pull lines 269–310 to confirm. Don't break existing behavior; the dispatch_id thread-through is additive.)

- [ ] **Step 4: Smoke-test by sending a fake email**

Send `cane@caneyfork.dev` an email that triggers a dispatch. Then:

```bash
sqlite3 ~/.id-agents/id-agents.db "SELECT id, from_actor, to_agent, status FROM dispatches ORDER BY id DESC LIMIT 3"
# Expect: most recent row from_actor='cane', status='in_flight' (or 'done' if agent finished)
```

- [ ] **Step 5: Commit**

```bash
cd ~/Dropbox/Code/cane/taskview
git add cane_routing.py
git commit -m "Cane poller registers dispatch row before /talk (12070 phase 2)"
```

---

### Task 14: Wire the scheduler to call `POST /dispatches`

**Files:**
- Modify: `src/scheduling/schedule-dispatcher.ts:10-77`

- [ ] **Step 1: Read the existing dispatcher**

Pull `src/scheduling/schedule-dispatcher.ts` 1–100. Identify the function that POSTs `/talk` or `/schedule`.

- [ ] **Step 2: Add a `registerDispatch` call before the POST**

Pseudo-diff:

```typescript
// Before the existing fetch(`${agentUrl}/talk`, …):
const registerResp = await fetch(`${this.managerUrl}/dispatches`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_actor: 'scheduler',
    to_agent: target.agentName,
    channel: deliveryMode,                  // 'talk' | 'schedule'
    message: schedule.message,
    query_id: scheduledKey,
    verify_signal: null,                    // default DoD
  }),
});
const dispatchId: number | null = registerResp.ok ? (await registerResp.json()).dispatch_id : null;

// Augment talk payload:
const talkPayload = { ...existingPayload, dispatch_id: dispatchId };

// After /talk succeeds:
if (dispatchId !== null) {
  await fetch(`${this.managerUrl}/dispatches/${dispatchId}/in-flight`, { method: 'POST' });
}
```

- [ ] **Step 3: Add a unit test that asserts the scheduler hits `/dispatches`**

Use the existing scheduler test harness pattern (look for `tests/scheduling/*.test.ts`). Inject a fake fetch that records the URLs hit. Assert one of them is `POST /dispatches`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/scheduling/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduling/schedule-dispatcher.ts tests/scheduling/
git commit -m "Scheduler registers dispatch row before /talk (12070 phase 2)"
```

---

### Task 15: Wire agent→agent dispatch to call `POST /dispatches`

**Files:**
- Modify: `src/inter-agent-skill.ts` — update the skill instructions
- The actual dispatch happens via the manager `/message` or `/talk-to` endpoint. Update those handlers in `agent-manager-db.ts` to register a dispatch row before forwarding.

- [ ] **Step 1: Locate the `/message` handler**

`grep -n 'app.post.*message' src/agent-manager-db.ts`

- [ ] **Step 2: Add registration**

In the `/message` handler, before forwarding to the target agent, call the same internal dispatch-create logic used by `POST /dispatches` (refactor that into a shared private method `createDispatchRow(input)` if not already).

- [ ] **Step 3: Update the inter-agent skill instructions**

In `src/inter-agent-skill.ts`, both lightweight and full versions: mention that dispatches are auto-registered when using `/message` and that the receiving agent must thread `dispatch_id` into its eventual `/agent-done`.

- [ ] **Step 4: Test**

Add a test that posts to `/message` and asserts a dispatch row appears with `from_actor` set to the calling agent.

- [ ] **Step 5: Commit**

```bash
git add src/agent-manager-db.ts src/inter-agent-skill.ts tests/
git commit -m "Agent→agent dispatches register a dispatch row (12070 phase 2)"
```

**Phase 2 ships when every dispatcher writes a row and every agent CLAUDE.md has the protocol block.**

---

## Phase 3 — Sentinel re-verify + liveness

### Task 16: Sentinel re-verify periodic job

**Files:**
- Create: `scripts/sentinel-reverify.ts`
- Create: `~/Library/LaunchAgents/com.kilgore.sentinel-reverify.plist`

- [ ] **Step 1: Write the script**

Create `scripts/sentinel-reverify.ts`:

```typescript
#!/usr/bin/env node
import { createDb } from '../src/db/index.js';
import { runVerifySignal } from '../src/verify/runner.js';
import type { VerifySignal } from '../src/verify/types.js';

const STALE_AFTER_HOURS = 12;       // re-check passes older than this
const BATCH_LIMIT = 50;

async function main() {
  const db = createDb(process.env.SQLITE_PATH);
  const now = Date.now();
  const candidates = await db.dispatches.findReverifyCandidates(now, STALE_AFTER_HOURS * 3600 * 1000);
  let flipped = 0;
  for (const row of candidates.slice(0, BATCH_LIMIT)) {
    if (!row.verify_signal_json) continue;
    let signal: VerifySignal;
    try {
      signal = JSON.parse(row.verify_signal_json);
    } catch {
      continue;
    }
    const result = await runVerifySignal(signal, { dispatched_at: row.dispatched_at });
    const newStatus = result.status;
    if (newStatus !== row.verify_status) flipped++;
    await db.dispatches.updateVerify(row.id, {
      verify_status: newStatus,
      verify_last_checked: Date.now(),
      verify_failures_json: result.failures.length ? JSON.stringify(result.failures) : null,
    });
  }
  console.log(JSON.stringify({ checked: candidates.length, flipped, ts: new Date().toISOString() }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Test with one passing + one failing row in a temp DB**

```bash
SQLITE_PATH=/tmp/test-12070.db npx tsx scripts/sentinel-reverify.ts
```

(Pre-seed `/tmp/test-12070.db` with two dispatches — one whose desk_tag passes, one that fails. Run script. Confirm flipped count.)

- [ ] **Step 3: Wire as launchd job**

Create `~/Library/LaunchAgents/com.kilgore.sentinel-reverify.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kilgore.sentinel-reverify</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/kilgore/Dropbox/Code/cane/id-agents/dist/scripts/sentinel-reverify.js</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>   <!-- 30 min -->
  <key>StandardOutPath</key><string>/tmp/sentinel-reverify.log</string>
  <key>StandardErrorPath</key><string>/tmp/sentinel-reverify.err</string>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SQLITE_PATH</key><string>/Users/kilgore/.id-agents/id-agents.db</string>
  </dict>
</dict>
</plist>
```

(Path to node may differ — `which node` on M4.)

- [ ] **Step 4: Build + load**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents && pnpm build
launchctl load ~/Library/LaunchAgents/com.kilgore.sentinel-reverify.plist
launchctl list | grep sentinel-reverify
tail -f /tmp/sentinel-reverify.log
```

Expect a JSON line every 30 min.

- [ ] **Step 5: Commit**

```bash
git add scripts/sentinel-reverify.ts
# plist lives in ~/Library/LaunchAgents — separate; do NOT commit secrets
git commit -m "Add sentinel re-verify periodic job (12070 phase 3)"
```

---

### Task 17: Heartbeat writer in `local-agent-server.ts`

**Files:**
- Create: `src/watchdog/heartbeat-writer.ts`
- Modify: `src/local-agent-server.ts`

- [ ] **Step 1: Implement writer module**

Create `src/watchdog/heartbeat-writer.ts`:

```typescript
import * as fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HEARTBEAT_DIR = join(homedir(), '.id-agents', 'heartbeats');
const TICK_MS = 60_000;

export function startHeartbeat(agentName: string): NodeJS.Timeout {
  mkdirSync(HEARTBEAT_DIR, { recursive: true });
  const path = join(HEARTBEAT_DIR, `${agentName}.heartbeat`);
  const tick = async () => {
    const now = Date.now();
    try {
      // Touch — write the timestamp string for inspection
      await fs.writeFile(path, `${now}\n`);
    } catch (err) {
      // Best-effort; don't crash the agent
      console.error(`[heartbeat] write failed for ${agentName}:`, err);
    }
  };
  void tick();                                     // immediate write
  return setInterval(tick, TICK_MS);
}
```

- [ ] **Step 2: Call it from `local-agent-server.ts` startup**

In `src/local-agent-server.ts`, in the agent boot path (around line 70–100 where the agent registers with the manager and binds its port), add:

```typescript
import { startHeartbeat } from './watchdog/heartbeat-writer.js';
// ... after agent name is known:
const heartbeatTimer = startHeartbeat(agentName);
process.on('SIGTERM', () => clearInterval(heartbeatTimer));
process.on('SIGINT', () => clearInterval(heartbeatTimer));
```

- [ ] **Step 3: Add a test**

Create `tests/watchdog/heartbeat-writer.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startHeartbeat } from '../../src/watchdog/heartbeat-writer.js';

describe('startHeartbeat', () => {
  it('writes the heartbeat file immediately on startup', async () => {
    const timer = startHeartbeat('test-agent-12070');
    // Allow the immediate void tick() to settle
    await new Promise(r => setTimeout(r, 50));
    const path = join(homedir(), '.id-agents/heartbeats/test-agent-12070.heartbeat');
    const content = await fs.readFile(path, 'utf-8');
    assert.match(content, /^\d+\n$/);
    clearInterval(timer);
    await fs.unlink(path);
  });
});
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run tests/watchdog/heartbeat-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watchdog/heartbeat-writer.ts src/local-agent-server.ts tests/watchdog/heartbeat-writer.test.ts
git commit -m "Add process-layer heartbeat writer in local-agent-server (12070 phase 3)"
```

- [ ] **Step 6: Restart all agents to pick up heartbeats**

```bash
# Per agent: launchctl unload + load. Or:
~/Dropbox/Code/cane/id-agents/start.sh restart
ls -la ~/.id-agents/heartbeats/
# Expect: one file per agent, mtime within last 60s.
```

---

### Task 18: Dispatch-stale watch cron

**Files:**
- Create: `scripts/dispatch-stale-watch.ts`
- Create: `~/Library/LaunchAgents/com.kilgore.dispatch-stale-watch.plist`

- [ ] **Step 1: Write the script**

Create `scripts/dispatch-stale-watch.ts`:

```typescript
#!/usr/bin/env node
import { createDb } from '../src/db/index.js';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_THRESHOLD_MS = 60 * 60 * 1000;   // 60 min
const PER_AGENT_THRESHOLD_MS: Record<string, number> = {
  sentinel: 30 * 60 * 1000,                     // 30 min
};
const HEARTBEAT_DIR = join(homedir(), '.id-agents', 'heartbeats');
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;       // heartbeat older than this = process_dead

async function main() {
  const db = createDb(process.env.SQLITE_PATH);
  const now = Date.now();
  // 1) Stale dispatches → wedged
  const stale = await db.dispatches.findStale(now - DEFAULT_THRESHOLD_MS);
  for (const row of stale) {
    const threshold = PER_AGENT_THRESHOLD_MS[row.to_agent] ?? DEFAULT_THRESHOLD_MS;
    if (now - row.dispatched_at < threshold) continue;
    await db.dispatches.setStatus(row.id, 'wedged');
    console.log(JSON.stringify({ event: 'wedged', dispatch_id: row.id, to_agent: row.to_agent, age_ms: now - row.dispatched_at }));
  }
  // 2) Heartbeat staleness check (informational — flag agents whose process is dead)
  try {
    const files = await fs.readdir(HEARTBEAT_DIR);
    for (const f of files) {
      if (!f.endsWith('.heartbeat')) continue;
      const stat = await fs.stat(join(HEARTBEAT_DIR, f));
      const age = now - stat.mtimeMs;
      if (age > HEARTBEAT_STALE_MS) {
        const agent = f.replace(/\.heartbeat$/, '');
        console.log(JSON.stringify({ event: 'process_dead', agent, age_ms: age }));
        // For now: log only. Future: post to a manager endpoint to flag.
      }
    }
  } catch {
    // Heartbeat dir may not exist yet — fine.
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add test for stale flip**

Create `tests/watchdog/dispatch-stale.test.ts` mocking the DB. Easier: write an integration test that uses an in-memory DB.

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteDispatchesRepo } from '../../src/db/repos/sqlite/dispatches-repo.js';

describe('dispatch-stale flip', () => {
  it('flips in_flight rows older than threshold to wedged', async () => {
    const adapter = new SqliteAdapter(':memory:');
    migrateSqlite(adapter);
    const repo = new SqliteDispatchesRepo(adapter);
    const now = Date.now();
    const oldId = await repo.create({
      team_id: null, dispatched_at: now - 70 * 60 * 1000,
      from_actor: 'manager', to_agent: 'personal', channel: 'talk',
      message: 'old', query_id: null, verify_signal_json: null, parent_dispatch_id: null,
    });
    await repo.setStatus(oldId, 'in_flight');
    // Inline the flip logic that the script also performs:
    const stale = await repo.findStale(now - 60 * 60 * 1000);
    for (const row of stale) await repo.setStatus(row.id, 'wedged');
    const after = await repo.getById(oldId);
    assert.equal(after!.status, 'wedged');
  });
});
```

- [ ] **Step 3: Run test, verify pass**

Run: `npx vitest run tests/watchdog/dispatch-stale.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire as launchd**

Create `~/Library/LaunchAgents/com.kilgore.dispatch-stale-watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kilgore.dispatch-stale-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/kilgore/Dropbox/Code/cane/id-agents/dist/scripts/dispatch-stale-watch.js</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/tmp/dispatch-stale-watch.log</string>
  <key>StandardErrorPath</key><string>/tmp/dispatch-stale-watch.err</string>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SQLITE_PATH</key><string>/Users/kilgore/.id-agents/id-agents.db</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 5: Build, load, smoke**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents && pnpm build
launchctl load ~/Library/LaunchAgents/com.kilgore.dispatch-stale-watch.plist
sleep 65
tail /tmp/dispatch-stale-watch.log
```

- [ ] **Step 6: Commit**

```bash
git add scripts/dispatch-stale-watch.ts tests/watchdog/dispatch-stale.test.ts
git commit -m "Add dispatch-stale watch cron with heartbeat staleness probe (12070 phase 3)"
```

**Phase 3 ships when wedged dispatches surface within 60 minutes and heartbeats are written by every running agent.**

---

## Phase 4 — Surfaces

### Task 19: Manager `GET /dispatches` and `GET /dispatches/:id`

**Files:**
- Modify: `src/agent-manager-db.ts`
- Test: extend `tests/manager/dispatches-endpoint.test.ts`

- [ ] **Step 1: Write tests**

Append to `tests/manager/dispatches-endpoint.test.ts`:

```typescript
  it('GET /dispatches returns recent rows with filters', async () => {
    const { url, db, stop } = await startTestManager();
    try {
      await db.dispatches.create({
        team_id: null, dispatched_at: Date.now() - 10000,
        from_actor: 'manager', to_agent: 'personal', channel: 'talk',
        message: 'a', query_id: null, verify_signal_json: null, parent_dispatch_id: null,
      });
      await db.dispatches.create({
        team_id: null, dispatched_at: Date.now(),
        from_actor: 'cane', to_agent: 'personal', channel: 'talk',
        message: 'b', query_id: null, verify_signal_json: null, parent_dispatch_id: null,
      });
      const res = await fetch(`${url}/dispatches?limit=10`);
      const body = await res.json() as { dispatches: any[] };
      assert.equal(body.dispatches.length, 2);
      assert.equal(body.dispatches[0].message, 'b');                 // most recent first
      const filtered = await fetch(`${url}/dispatches?from_actor=cane`);
      const fb = await filtered.json() as { dispatches: any[] };
      assert.equal(fb.dispatches.length, 1);
    } finally { await stop(); }
  });

  it('GET /dispatches/:id returns single row or 404', async () => {
    const { url, db, stop } = await startTestManager();
    try {
      const id = await db.dispatches.create({
        team_id: null, dispatched_at: Date.now(),
        from_actor: 'manager', to_agent: 'personal', channel: 'talk',
        message: 'x', query_id: null, verify_signal_json: null, parent_dispatch_id: null,
      });
      const res = await fetch(`${url}/dispatches/${id}`);
      assert.equal(res.status, 200);
      const not = await fetch(`${url}/dispatches/99999`);
      assert.equal(not.status, 404);
    } finally { await stop(); }
  });
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: 2 NEW FAILS.

- [ ] **Step 3: Add handlers**

In `src/agent-manager-db.ts`:

```typescript
this.app.get('/dispatches', async (req, res) => {
  const filters = {
    status: req.query.status ? String(req.query.status).split(',') as DispatchStatus[] : undefined,
    to_agent: req.query.to_agent ? String(req.query.to_agent) : undefined,
    from_actor: req.query.from_actor ? String(req.query.from_actor) : undefined,
    verify_status: req.query.verify_status ? String(req.query.verify_status) as VerifyStatus : undefined,
    since: req.query.since ? Number(req.query.since) : undefined,
    limit: req.query.limit ? Math.min(Number(req.query.limit), 200) : 50,
  };
  const dispatches = await this.db.dispatches.list(filters);
  res.json({ dispatches });
});

this.app.get('/dispatches/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = await this.db.dispatches.getById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/manager/dispatches-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-manager-db.ts tests/manager/dispatches-endpoint.test.ts
git commit -m "Add GET /dispatches and GET /dispatches/:id (12070 phase 4)"
```

---

### Task 20: Manager kill / retry endpoints

**Files:**
- Modify: `src/agent-manager-db.ts`

- [ ] **Step 1: Tests**

```typescript
it('POST /dispatches/:id/kill flips wedged → failed and logs', async () => { /* ... */ });
it('POST /dispatches/:id/retry creates a new dispatch with parent_dispatch_id set', async () => { /* ... */ });
```

- [ ] **Step 2: Implement**

```typescript
this.app.post('/dispatches/:id/kill', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = await this.db.dispatches.getById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await this.db.dispatches.setStatus(id, 'failed');
  // Future: also send SIGTERM to the agent process — defer to v2.
  res.json({ ok: true });
});

this.app.post('/dispatches/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  const row = await this.db.dispatches.getById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const newId = await this.db.dispatches.create({
    team_id: row.team_id,
    dispatched_at: Date.now(),
    from_actor: row.from_actor,
    to_agent: row.to_agent,
    channel: row.channel,
    message: row.message,
    query_id: row.query_id,
    verify_signal_json: row.verify_signal_json,
    parent_dispatch_id: row.id,
  });
  // Don't actually re-dispatch /talk here in v1 — the dashboard's retry
  // button generates the row and the operator (or scheduler) re-fires.
  // Mark behavior in the response.
  res.json({ dispatch_id: newId, status: 'queued', note: 'row created — caller must POST /talk' });
});
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/agent-manager-db.ts tests/manager/dispatches-endpoint.test.ts
git commit -m "Add /dispatches/:id/kill and /retry (12070 phase 4)"
```

---

### Task 21: Dashboard `/in-flight` page

**Files:**
- The `dashboard.caneyfork.dev` repo location must be confirmed by Roger. Per spec `docs/superpowers/specs/2026-04-27-...md` §6.10, it's a Next.js app, deploys via `vercel --prod`. Likely at `~/Dropbox/Code/cane/dashboard` or `~/Dropbox/Code/dashboard`.

- [ ] **Step 1: Locate the dashboard repo**

```bash
find ~/Dropbox/Code -maxdepth 3 -type f -name 'next.config.*' 2>/dev/null
find ~/Dropbox/Code -maxdepth 3 -type d -name 'dashboard' 2>/dev/null
```

If not found, ask the operator (Chris) for the path. Document in `docs/dashboard-repo-location.md`.

- [ ] **Step 2: Add a page route**

Create `pages/in-flight.tsx` (Pages router) or `app/in-flight/page.tsx` (App router):

```tsx
'use client';
import { useEffect, useState } from 'react';

type Dispatch = {
  id: number;
  dispatched_at: number;
  from_actor: string;
  to_agent: string;
  message: string;
  status: string;
  responded_at: number | null;
  artifact_path: string | null;
  verify_status: string | null;
  verify_failures_json: string | null;
};

export default function InFlight() {
  const [rows, setRows] = useState<Dispatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(process.env.NEXT_PUBLIC_MANAGER_URL + '/dispatches?limit=100');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (alive) setRows(body.dispatches);
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) return <div>Error: {error}</div>;
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>🚀 In Flight — Dispatches</h1>
      <Stats rows={rows} />
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Time</th><th>From</th><th>To</th><th>Message</th>
            <th>Status</th><th>Verify</th><th>Duration</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => <Row key={r.id} dispatch={r} />)}
        </tbody>
      </table>
    </main>
  );
}

function Stats({ rows }: { rows: Dispatch[] }) {
  const inFlight = rows.filter(r => r.status === 'in_flight').length;
  const wedged = rows.filter(r => r.status === 'wedged').length;
  const verifyFailed = rows.filter(r => r.verify_status === 'fail').length;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 16 }}>
      <Stat n={inFlight} label="In flight" />
      <Stat n={wedged} label="Wedged" color="#ff8888" />
      <Stat n={verifyFailed} label="Verify failed" color="#d4b87a" />
      <Stat n={rows.filter(r => r.status === 'done').length} label="Closed (recent)" color="#8bcd8b" />
    </div>
  );
}
function Stat({ n, label, color = '#5fb3e0' }: { n: number; label: string; color?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: 12, border: '1px solid #ddd', borderRadius: 6 }}>
      <div style={{ fontSize: 28, color }}>{n}</div>
      <div style={{ fontSize: 12, color: '#888' }}>{label}</div>
    </div>
  );
}

function Row({ dispatch }: { dispatch: Dispatch }) {
  const dur = dispatch.responded_at
    ? formatMs(dispatch.responded_at - dispatch.dispatched_at)
    : formatMs(Date.now() - dispatch.dispatched_at);
  const bg = dispatch.status === 'wedged' ? 'rgba(255,80,80,0.05)' :
             dispatch.status === 'in_flight' ? 'rgba(95,179,224,0.05)' :
             dispatch.verify_status === 'fail' ? 'rgba(212,184,122,0.06)' : 'transparent';
  return (
    <tr style={{ background: bg, borderBottom: '1px solid #eee' }}>
      <td>{new Date(dispatch.dispatched_at).toLocaleTimeString()}</td>
      <td>{dispatch.from_actor}</td>
      <td><strong>{dispatch.to_agent}</strong></td>
      <td style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dispatch.message}</td>
      <td><StatusPill status={dispatch.status} /></td>
      <td>{dispatch.verify_status ?? '—'}</td>
      <td>{dur}</td>
      <td>{actionFor(dispatch)}</td>
    </tr>
  );
}
function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    in_flight: '#5fb3e0', done: '#3a6e3a', wedged: '#ff6666',
    failed: '#a87a1f', timeout: '#a87a1f', queued: '#888',
  };
  return <span style={{ background: map[status] ?? '#888', color: '#fff', padding: '2px 8px', borderRadius: 10, fontSize: 11 }}>{status.toUpperCase()}</span>;
}
function actionFor(d: Dispatch) {
  if (d.status === 'wedged' || d.status === 'failed') return <button onClick={() => kill(d.id)}>Kill</button>;
  if (d.verify_status === 'fail') return <button onClick={() => retry(d.id)}>Retry</button>;
  return null;
}
async function kill(id: number) {
  await fetch(process.env.NEXT_PUBLIC_MANAGER_URL + `/dispatches/${id}/kill`, { method: 'POST' });
}
async function retry(id: number) {
  await fetch(process.env.NEXT_PUBLIC_MANAGER_URL + `/dispatches/${id}/retry`, { method: 'POST' });
}
function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}
```

- [ ] **Step 3: Add `NEXT_PUBLIC_MANAGER_URL` env var**

Add to dashboard repo `.env.local`:

```
NEXT_PUBLIC_MANAGER_URL=https://api.caneyfork.dev
```

(Adjust to whatever public URL fronts the manager — likely the existing CF tunnel.)

- [ ] **Step 4: Local smoke**

```bash
cd <dashboard-repo>
pnpm dev
# Open http://localhost:3000/in-flight
# Confirm rows render. Mark Kill/Retry on a test row.
```

- [ ] **Step 5: Deploy and verify live**

```bash
vercel --prod --yes
# Wait for deploy ID, then:
curl -sS https://dashboard.caneyfork.dev/in-flight | grep -i 'in flight'
# Expect: HTML contains "In Flight — Dispatches"
```

- [ ] **Step 6: Commit dashboard repo**

```bash
git add pages/in-flight.tsx .env.local
git commit -m "Add /in-flight dashboard page reading from manager (12070 phase 4)"
```

---

### Task 22: Desk "🚀 In flight" section

**Files:**
- Modify: the script that generates Desk.md. Per the codebase explorer, it might be `~/Dropbox/Code/cane/taskview/dashboard_refresh.py` (referenced but doesn't yet exist) or another script. Locate via:

```bash
grep -rln '🔥 Right now\|Last refreshed' ~/Dropbox/Code/cane/ ~/Dropbox/Code/ 2>/dev/null | head
```

- [ ] **Step 1: Locate the desk-refresh script**

Run grep above. If no script found, the Desk file is hand-edited — coordinate with Chris before adding automation.

- [ ] **Step 2: Add the section generator**

Add a function that queries the manager:

```python
import requests
def render_in_flight_section(manager_url: str) -> str:
    try:
        r = requests.get(f"{manager_url}/dispatches?status=in_flight,wedged&limit=20", timeout=5)
        r.raise_for_status()
        rows = r.json()['dispatches']
    except Exception as e:
        return f"## 🚀 In flight\n\n_(unable to reach manager: {e})_\n\n"
    if not rows:
        return "## 🚀 In flight\n\n_(nothing in flight)_\n\n"
    in_flight = [r for r in rows if r['status'] == 'in_flight']
    wedged = [r for r in rows if r['status'] == 'wedged']
    lines = [f"## 🚀 In flight  ·  {len(in_flight)} dispatches  ·  {len(wedged)} wedged\n"]
    for r in wedged:
        lines.append(f"- ⚠️ **{r['to_agent']}** · {format_age(r['dispatched_at'])} · {r['message'][:80]}")
    for r in in_flight:
        lines.append(f"- 🟦 **{r['to_agent']}** · {format_age(r['dispatched_at'])} · {r['message'][:80]}")
    lines.append("")
    lines.append("→ [Full dashboard](https://dashboard.caneyfork.dev/in-flight)")
    lines.append("")
    return "\n".join(lines)

def format_age(dispatched_at_ms: int) -> str:
    age_ms = int(time.time() * 1000) - dispatched_at_ms
    if age_ms < 60_000: return f"{age_ms // 1000}s"
    if age_ms < 3600_000: return f"{age_ms // 60_000}m"
    return f"{age_ms / 3600_000:.1f}h"
```

Wire this into the existing Desk render flow (after `## 🔥 Right now`, before `**Overdue / due today**`).

- [ ] **Step 3: Smoke-test**

Trigger a desk refresh. Check Desk.md visually — section should render.

- [ ] **Step 4: Commit**

```bash
cd <wherever-script-lives>
git add <script>
git commit -m "Add Desk 🚀 In flight section reading from manager (12070 phase 4)"
```

**Phase 4 ships when `dashboard.caneyfork.dev/in-flight` shows live data and Desk has a current `🚀 In flight` block.**

---

## Phase 5 — Defense-in-depth

### Task 23: Bash hard timeout wrapper

This is a sidecar shell script that wraps `claude-agent-sdk` Bash spawns with a hard wall-clock timeout. The model emits a Bash command; the SDK passes it to `bash`; we replace that path with `bash-timeout-wrapper.sh`.

**Files:**
- Create: `scripts/bash-timeout-wrapper.sh`
- Modify: agent runtime config — wherever the SDK looks up `bash` for its Bash tool

- [ ] **Step 1: Write the wrapper**

Create `scripts/bash-timeout-wrapper.sh`:

```bash
#!/usr/bin/env bash
# Hard wall-clock timeout for Bash-tool spawns.
# Usage: bash-timeout-wrapper.sh -c "<command>"
set -uo pipefail

TIMEOUT_SEC="${BASH_HARD_TIMEOUT_SEC:-1800}"  # 30 min default
TERM_WAIT_SEC=30                                # SIGKILL grace

# Use `timeout` if available; else implement minimal fallback.
if command -v timeout >/dev/null 2>&1; then
  exec timeout --signal=TERM --kill-after="${TERM_WAIT_SEC}s" "${TIMEOUT_SEC}s" /bin/bash "$@"
fi

# Fallback (macOS may need brew install coreutils for `timeout`)
/bin/bash "$@" &
PID=$!
( sleep "$TIMEOUT_SEC" && kill -TERM "$PID" 2>/dev/null && sleep "$TERM_WAIT_SEC" && kill -KILL "$PID" 2>/dev/null ) &
WATCHER=$!
wait "$PID"
EXIT=$?
kill "$WATCHER" 2>/dev/null
exit $EXIT
```

```bash
chmod +x scripts/bash-timeout-wrapper.sh
```

- [ ] **Step 2: Test the wrapper standalone**

```bash
BASH_HARD_TIMEOUT_SEC=2 ./scripts/bash-timeout-wrapper.sh -c 'sleep 5; echo done'
# Expect: returns ~2s, no "done" output, exit code 124 (timeout) or 143 (SIGTERM)

BASH_HARD_TIMEOUT_SEC=2 ./scripts/bash-timeout-wrapper.sh -c 'echo hi'
# Expect: prints "hi", exit 0
```

- [ ] **Step 3: Wire into agent runtime**

Per the spec §9 ("Filed for Prem"), the v1 wiring is a **sidecar**: invoke this wrapper from inside the agent's `local-agent-server.ts` when it forwards Bash-tool calls. If the SDK doesn't surface a hook, this becomes a Prem feedback item — file it.

Concrete v1: set the agent's launchd `EnvironmentVariables` to include `PATH` with `scripts/` first, and rename `scripts/bash-timeout-wrapper.sh` → `scripts/bash` so it shadows `/bin/bash` for that process. (Heavy-handed; iterate.)

If neither approach works without SDK changes, **stop here, file feedback to Prem, and keep §6.7b (dispatch-stale watch) as the v1 backstop.** Document the gap in `~/Dropbox/Obsidian/id-agents/structural-issues-log.md`.

- [ ] **Step 4: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
git add scripts/bash-timeout-wrapper.sh
git commit -m "Add Bash hard-timeout wrapper sidecar (12070 phase 5)"
```

---

### Task 24: Banner renderer fix

The Desk banner shows a stale string like `"3.0h"` because it stores the formatted age instead of the timestamp.

**Files:**
- The renderer location must be confirmed. Per the explorer: candidates include `~/Dropbox/Code/cane/taskview/cane.py:342` ("Print last-refreshed timestamp + staleness") and an as-yet-unbuilt `dashboard_refresh.py`.

- [ ] **Step 1: Locate the renderer**

```bash
grep -rn "stale\|3\.0h\|h since last" ~/Dropbox/Code/cane/ 2>/dev/null | grep -v node_modules | head
```

- [ ] **Step 2: Identify the storage shape**

Check whether the file stores `last_event_at` as a timestamp (good) or as a formatted string (the bug).

- [ ] **Step 3: Refactor to compute age at render time**

Change the storage shape (if needed) to a unix epoch ms. Render with this helper:

```python
def format_age(now_ms: int, then_ms: int) -> str:
    age_ms = now_ms - then_ms
    if age_ms < 60_000: return f"{age_ms // 1000}s"
    if age_ms < 3600_000: return f"{age_ms // 60_000}m"
    if age_ms < 86_400_000: return f"{age_ms / 3600_000:.1f}h"
    return f"{age_ms / 86_400_000:.1f}d"
```

- [ ] **Step 4: Add a test**

Whatever test framework that codebase uses (likely `pytest`). Pre-set a fixed timestamp, advance "now," confirm the rendered string changes.

- [ ] **Step 5: Commit**

```bash
cd <renderer-repo>
git add <files>
git commit -m "Fix banner age renderer — compute at render time (12070 phase 5)"
```

**Phase 5 ships when banner age stays accurate over time and Bash spawns can't run unbounded.**

---

## Cross-cutting

### Test suite green

- [ ] **Step 1: Full test run**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run
```

Expected: all green, including the new dispatches/verify/watchdog tests.

- [ ] **Step 2: TypeScript build**

```bash
pnpm build
```

Expected: no errors.

- [ ] **Step 3: Manager restart**

```bash
~/Dropbox/Code/cane/id-agents/start.sh restart manager
curl -s http://localhost:4100/dispatches | jq .
# Expect: { "dispatches": [...] }
```

---

## Out of scope (parking lot)

These appear in the spec as deferred and are **not** to be implemented in this plan:

- gmail / resend / telegram / trello `api_call` checks (file separate specs as workflows demand)
- screenshot-diff verify
- LLM-judge verify
- Cross-agent dependency graphs
- Cost / token accounting per dispatch
- Slack / PagerDuty escalation
- Multi-user auth on dashboard
- Migration of historical dispatches into the new table

---

## Self-review notes

**Spec coverage check (against `2026-04-27-dod-dispatch-observability-design.md`):**

| Spec § | Plan task |
|--------|-----------|
| 6.1 dispatches table | Task 1 |
| 6.2 POST /dispatches | Tasks 2, 3, 4, 8 |
| 6.3 extended /agent-done | Task 10 |
| 6.4 verify_signal types | Tasks 5, 6, 7 |
| 6.5 agent self-verify | Tasks 11, 12 |
| 6.6 sentinel re-verify | Task 16 |
| 6.7a heartbeats | Task 17 |
| 6.7b dispatch-stale watch | Task 18 |
| 6.8 Bash hard timeout | Task 23 |
| 6.9 banner renderer | Task 24 |
| 6.10 dashboard /in-flight | Tasks 19, 20, 21 |
| 6.11 Desk in-flight section | Task 22 |
| §13 Q1 (DB migration) | Answered: same migration runner pattern as existing tables |
| §13 Q2 (heartbeat path) | Answered: `~/.id-agents/heartbeats/<agent>.heartbeat` |
| §13 Q3 (sentinel schedule) | Answered: launchd, 30 min interval |
| §13 Q4 (dashboard auth) | Answered in Task 21 (env-var manager URL; same auth as rest of dashboard) |
| §13 Q5 (retry semantics) | Answered: new row with `parent_dispatch_id` (Task 20) |

All spec components map to a task. Default DoD applied in Task 8. All 5 verify-signal types covered, with `api_call` shipping vercel_deploy only and other services parked.

**Type consistency check:**
- `DispatchRow` defined in Task 1, referenced consistently in Tasks 2, 3, 8, 10, 16, 18, 19, 20, 21
- `VerifySignal` defined in Task 5, used in Tasks 7, 10, 16
- `verify_status` enum is `'pending' | 'pass' | 'fail'` everywhere
- Status enum is `'queued' | 'in_flight' | 'done' | 'failed' | 'timeout' | 'wedged'` everywhere
- Method names match — `recordDone`, `setStatus`, `updateVerify`, `findStale`, `findReverifyCandidates` are stable across tasks

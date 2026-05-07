// SPDX-License-Identifier: MIT
//
// Spec 053 Phase 1, Task 3 — SqliteDispatchesRepo conformance tests.

import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteDispatchesRepo } from '../../src/db/repos/sqlite/dispatches-repo.js';

const assert = {
  equal<T>(actual: T, expected: T) { expect(actual).toBe(expected); },
  ok<T>(value: T) { expect(value).toBeTruthy(); },
  deepEqual<T>(actual: T, expected: T) { expect(actual).toEqual(expected); },
};

async function freshRepo() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return new SqliteDispatchesRepo(adapter);
}

describe('SqliteDispatchesRepo', () => {
  it('creates a dispatch row and returns its id', async () => {
    const repo = await freshRepo();
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
    assert.equal(row!.from_actor, 'manager');
    assert.equal(row!.to_agent, 'personal');
    assert.equal(row!.status, 'queued');
  });

  it('flips status from queued -> in_flight -> done', async () => {
    const repo = await freshRepo();
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

  it('records done with verify fields', async () => {
    const repo = await freshRepo();
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

  it('lists rows by status filter', async () => {
    const repo = await freshRepo();
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
    const repo = await freshRepo();
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
    const repo = await freshRepo();
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
    const repo = await freshRepo();
    const idPending = await repo.create({
      team_id: null, dispatched_at: 1000, from_actor: 'manager',
      to_agent: 'personal', channel: 'talk', message: 'pending',
      query_id: null,
      verify_signal_json: '{"type":"desk_tag","artifact_path":"x","within_hours":24}',
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
      query_id: null,
      verify_signal_json: '{"type":"desk_tag","artifact_path":"y","within_hours":24}',
      parent_dispatch_id: null,
    });
    await repo.recordDone(idStale, {
      responded_at: 2500, response: null, artifact_path: null,
      verify_signal_json: '{"type":"desk_tag","artifact_path":"y","within_hours":24}',
      verify_status: 'pass', verify_last_checked: 2500,
      verify_failures_json: null,
    });
    // now = 100000, staleAfterMs = 10000  -> stale-pass row qualifies
    const candidates = await repo.findReverifyCandidates(100000, 10000);
    const messages = candidates.map(r => r.message).sort();
    assert.deepEqual(messages, ['pending', 'stale']);
  });
});

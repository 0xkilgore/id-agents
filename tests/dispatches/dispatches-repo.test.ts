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
});

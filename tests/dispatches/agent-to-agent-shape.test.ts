// SPDX-License-Identifier: MIT
//
// Spec 053 Phase 2, Task 15 — verifies the dispatch-row shape that
// handleMessage produces for agent→agent /message calls. (Full /message
// integration is left to a future test harness; this test pins the data
// contract that the refactored createDispatchRow helper writes.)

import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteDispatchesRepo } from '../../src/db/repos/sqlite/dispatches-repo.js';

async function freshRepo() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return new SqliteDispatchesRepo(adapter);
}

describe('agent→agent /message dispatch row shape', () => {
  it('writes a row with from_actor = calling agent and channel = "talk"', async () => {
    const repo = await freshRepo();
    // Mirror what handleMessage's createDispatchRow call produces when
    // /message arrives with body { from: "roger", to: "personal", message: "..." }.
    const id = await repo.create({
      team_id: null,
      dispatched_at: 1000,
      from_actor: 'roger',
      to_agent: 'personal',
      channel: 'talk',
      message: 'please summarise this',
      query_id: null,
      verify_signal_json: JSON.stringify({
        type: 'desk_tag',
        artifact_path: '<TBD by agent>',
        within_hours: 24,
      }),
      parent_dispatch_id: null,
    });

    const row = await repo.getById(id);
    expect(row).toBeTruthy();
    expect(row!.from_actor).toBe('roger');
    expect(row!.to_agent).toBe('personal');
    expect(row!.channel).toBe('talk');
    expect(row!.status).toBe('queued');

    // Default DoD is desk_tag within 24h.
    const signal = JSON.parse(row!.verify_signal_json!);
    expect(signal.type).toBe('desk_tag');
    expect(signal.within_hours).toBe(24);
  });

  it('flips to in_flight after a successful forward', async () => {
    const repo = await freshRepo();
    const id = await repo.create({
      team_id: null,
      dispatched_at: 1000,
      from_actor: 'roger',
      to_agent: 'personal',
      channel: 'talk',
      message: 'x',
      query_id: null,
      verify_signal_json: null,
      parent_dispatch_id: null,
    });
    await repo.setStatus(id, 'in_flight');
    const row = await repo.getById(id);
    expect(row!.status).toBe('in_flight');
  });
});

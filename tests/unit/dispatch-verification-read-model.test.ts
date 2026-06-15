// SPDX-License-Identifier: MIT
/**
 * Tests for the pure read-model builders that shape the Agents
 * effectiveness/dispatches endpoint responses. The critical invariant under
 * test is reconciliation: fleet totals are the exact sum of the per-agent
 * rollups.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentsEffectiveness,
  buildAgentDispatches,
} from '../../src/dispatch-verification/read-model.js';
import {
  DISPATCH_VERIFICATION_FAILURE_TYPES,
  type DispatchVerification,
  type DispatchVerificationFailureType,
} from '../../src/dispatch-verification/types.js';

const GENERATED_AT = '2026-06-15T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

/** Build a full DispatchVerification row with overrides. */
function makeRow(overrides: Partial<DispatchVerification> = {}): DispatchVerification {
  return {
    schema_version: 'dispatch-verification.v1',
    team_id: 'team-1',
    dispatch_id: 'phid:disp-' + Math.random().toString(36).slice(2),
    query_id: 'query_1',
    agent_name: 'finances',
    status: 'verified',
    verified: true,
    failure_type: null,
    failure_detail: null,
    artifact_path: '/abs/report.md',
    artifact_exists: true,
    artifact_mtime: '2026-06-15T11:00:00.000Z',
    delivery_window_start: null,
    delivery_window_end: null,
    promotion_required: false,
    promotion_verified: null,
    promotion_failure_detail: null,
    dispatch_status: 'done',
    dispatch_created_at: '2026-06-15T10:00:00.000Z',
    dispatch_started_at: '2026-06-15T10:01:00.000Z',
    dispatch_completed_at: '2026-06-15T11:00:00.000Z',
    result_success: true,
    tl_dr: 'did the thing',
    kind: 'report',
    checked_at: GENERATED_AT,
    source_metadata: { source: 'dispatch_scheduler_queue', result_source: 'artifact_path' },
    ...overrides,
  };
}

const ROSTER = [
  { name: 'finances', status: 'idle', in_flight_dispatch_id: null },
  { name: 'personal', status: 'busy', in_flight_dispatch_id: 'phid:disp-inflight' },
];

describe('buildAgentsEffectiveness', () => {
  it('reconciles fleet totals as the exact sum of per-agent rollups', () => {
    const rows: DispatchVerification[] = [
      // finances: 1 verified, 1 expired failure, 1 artifact_missing failure
      makeRow({ agent_name: 'finances', status: 'verified', verified: true, failure_type: null }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'expired' }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'artifact_missing' }),
      // personal: 2 verified, 1 expired failure
      makeRow({ agent_name: 'personal', status: 'verified', verified: true, failure_type: null }),
      makeRow({ agent_name: 'personal', status: 'verified', verified: true, failure_type: null }),
      makeRow({ agent_name: 'personal', status: 'unverified', verified: false, failure_type: 'expired' }),
      // pending row — must NOT count as completed
      makeRow({ agent_name: 'finances', status: 'pending', verified: false, failure_type: null }),
    ];

    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);

    const sumCompleted = res.agents.reduce((a, x) => a + x.dispatches_completed, 0);
    const sumVerified = res.agents.reduce((a, x) => a + x.verified_landings, 0);

    expect(res.fleet.dispatches_completed).toBe(sumCompleted);
    expect(res.fleet.verified_landings).toBe(sumVerified);

    // Exact expected fleet numbers: 6 completed (pending excluded), 3 verified.
    expect(res.fleet.dispatches_completed).toBe(6);
    expect(res.fleet.verified_landings).toBe(3);

    // failure_breakdown reconciles per type.
    for (const ft of DISPATCH_VERIFICATION_FAILURE_TYPES) {
      const perAgentSum = res.agents.reduce((acc, agent) => {
        // re-derive each agent's count of ft from the source rows
        const c = rows.filter((r) => r.agent_name === agent.name && r.failure_type === ft).length;
        return acc + c;
      }, 0);
      expect(res.fleet.failure_breakdown[ft]).toBe(perAgentSum);
    }
    expect(res.fleet.failure_breakdown.expired).toBe(2);
    expect(res.fleet.failure_breakdown.artifact_missing).toBe(1);
  });

  it('computes verified_landing_rate and is 0-denominator safe', () => {
    const rows: DispatchVerification[] = [
      makeRow({ agent_name: 'finances', status: 'verified', verified: true }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'expired' }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'expired' }),
    ];
    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    const finances = res.agents.find((a) => a.name === 'finances')!;
    expect(finances.verified_landing_rate).toBe(0.3333); // 1/3 rounded to 4dp
    expect(res.fleet.verified_landing_rate).toBe(0.3333);

    // personal has no rows -> 0-denominator safe, no NaN
    const personal = res.agents.find((a) => a.name === 'personal')!;
    expect(personal.dispatches_completed).toBe(0);
    expect(personal.verified_landing_rate).toBe(0);
  });

  it('emits failure_breakdown with every enum key present', () => {
    const res = buildAgentsEffectiveness([], ROSTER, '7d', GENERATED_AT);
    for (const ft of DISPATCH_VERIFICATION_FAILURE_TYPES) {
      expect(res.fleet.failure_breakdown[ft]).toBe(0);
    }
    expect(Object.keys(res.fleet.failure_breakdown).sort()).toEqual(
      [...DISPATCH_VERIFICATION_FAILURE_TYPES].sort(),
    );
  });

  it('buckets verified landings into trend_4w by dispatch_completed_at (oldest first)', () => {
    const gen = Date.parse(GENERATED_AT);
    const week = 7 * DAY;
    // Bucket i covers [gen-(4-i)*7d, gen-(3-i)*7d). Place a row mid-bucket.
    const mid = (i: number) => new Date(gen - (4 - i) * week + 3 * DAY).toISOString();
    const rows: DispatchVerification[] = [
      // bucket 0: 1 verified
      makeRow({ verified: true, dispatch_completed_at: mid(0) }),
      // bucket 1: 2 verified
      makeRow({ verified: true, dispatch_completed_at: mid(1) }),
      makeRow({ verified: true, dispatch_completed_at: mid(1) }),
      // bucket 2: 0
      // bucket 3: 3 verified
      makeRow({ verified: true, dispatch_completed_at: mid(3) }),
      makeRow({ verified: true, dispatch_completed_at: mid(3) }),
      makeRow({ verified: true, dispatch_completed_at: mid(3) }),
      // unverified in bucket 3 — must not count
      makeRow({ verified: false, failure_type: 'expired', dispatch_completed_at: mid(3) }),
    ];
    const res = buildAgentsEffectiveness(rows, [], '30d', GENERATED_AT);
    expect(res.fleet.trend_4w).toEqual([1, 2, 0, 3]);
  });

  it('includes roster agents with zero dispatches as zeros + null landing', () => {
    const rows: DispatchVerification[] = [
      makeRow({ agent_name: 'finances', status: 'verified', verified: true }),
    ];
    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    const personal = res.agents.find((a) => a.name === 'personal')!;
    expect(personal.status).toBe('busy');
    expect(personal.dispatches_completed).toBe(0);
    expect(personal.verified_landings).toBe(0);
    expect(personal.verified_landing_rate).toBe(0);
    expect(personal.throughput).toBe(0);
    expect(personal.top_failure_type).toBeNull();
    expect(personal.last_verified_landing).toBeNull();
    expect(personal.in_flight_dispatch_id).toBe('phid:disp-inflight');
  });

  it('includes agents present in rows but missing from roster as status unknown, sorted by name', () => {
    const rows: DispatchVerification[] = [
      makeRow({ agent_name: 'zeta', status: 'verified', verified: true }),
    ];
    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    const zeta = res.agents.find((a) => a.name === 'zeta')!;
    expect(zeta.status).toBe('unknown');
    expect(res.agents.map((a) => a.name)).toEqual(['finances', 'personal', 'zeta']);
  });

  it('tie-breaks top_failure_type by enum order (earlier wins)', () => {
    // artifact_stale (idx 2) and dispatch_not_found (idx 3) tied at 2 each.
    const rows: DispatchVerification[] = [
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'dispatch_not_found' }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'dispatch_not_found' }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'artifact_stale' }),
      makeRow({ agent_name: 'finances', status: 'unverified', verified: false, failure_type: 'artifact_stale' }),
    ];
    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    const finances = res.agents.find((a) => a.name === 'finances')!;
    expect(finances.top_failure_type).toBe('artifact_stale');
  });

  it('last_verified_landing picks the latest verified row with an artifact_path', () => {
    const rows: DispatchVerification[] = [
      makeRow({
        agent_name: 'finances',
        verified: true,
        artifact_path: '/abs/old.md',
        dispatch_completed_at: '2026-06-10T00:00:00.000Z',
        tl_dr: 'old',
      }),
      makeRow({
        agent_name: 'finances',
        verified: true,
        artifact_path: '/abs/new.md',
        dispatch_completed_at: '2026-06-14T00:00:00.000Z',
        tl_dr: 'new',
        kind: 'data',
      }),
      // newer but verified row has NO artifact_path -> must be ignored
      makeRow({
        agent_name: 'finances',
        verified: true,
        artifact_path: null,
        dispatch_completed_at: '2026-06-15T00:00:00.000Z',
      }),
    ];
    const res = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    const finances = res.agents.find((a) => a.name === 'finances')!;
    expect(finances.last_verified_landing).toEqual({
      timestamp: '2026-06-14T00:00:00.000Z',
      artifact_path: '/abs/new.md',
      tl_dr: 'new',
      kind: 'data',
    });
  });

  it('computes throughput_per_week from verified landings and window days', () => {
    const rows: DispatchVerification[] = [
      makeRow({ agent_name: 'finances', verified: true }),
      makeRow({ agent_name: 'finances', verified: true }),
    ];
    // window 7d: 2 verified / 7 * 7 = 2
    const res7 = buildAgentsEffectiveness(rows, ROSTER, '7d', GENERATED_AT);
    expect(res7.fleet.throughput_per_week).toBe(2);
    // window 24h (1 day): 2 / 1 * 7 = 14
    const res24 = buildAgentsEffectiveness(rows, ROSTER, '24h', GENERATED_AT);
    expect(res24.fleet.throughput_per_week).toBe(14);
  });
});

describe('buildAgentDispatches', () => {
  it('sorts DESC by completed_at, applies limit, and maps item shape', () => {
    const rows: DispatchVerification[] = [
      makeRow({ dispatch_id: 'd-a', dispatch_completed_at: '2026-06-10T00:00:00.000Z', tl_dr: 'a' }),
      makeRow({ dispatch_id: 'd-b', dispatch_completed_at: '2026-06-14T00:00:00.000Z', tl_dr: 'b' }),
      makeRow({ dispatch_id: 'd-c', dispatch_completed_at: '2026-06-12T00:00:00.000Z', tl_dr: 'c' }),
    ];
    const res = buildAgentDispatches(rows, 'finances', '7d', 2, GENERATED_AT);
    expect(res.schema_version).toBe('agents.dispatches.v1');
    expect(res.agent_name).toBe('finances');
    expect(res.items).toHaveLength(2);
    expect(res.items.map((i) => i.dispatch_id)).toEqual(['d-b', 'd-c']);

    const first = res.items[0];
    expect(first.time).toBe('2026-06-14T00:00:00.000Z');
    expect(first.subject).toBe('b');
    expect(first.verification_status).toBe('verified');
    expect(first.kind).toBe('report');
    expect(first.artifact_path).toBe('/abs/report.md');
  });

  it('falls back to dispatch_created_at when completed_at is null for time + ordering', () => {
    const rows: DispatchVerification[] = [
      makeRow({
        dispatch_id: 'd-null',
        dispatch_completed_at: null,
        dispatch_created_at: '2026-06-13T00:00:00.000Z',
        tl_dr: null,
      }),
    ];
    const res = buildAgentDispatches(rows, 'finances', '7d', 10, GENERATED_AT);
    expect(res.items[0].time).toBe('2026-06-13T00:00:00.000Z');
    expect(res.items[0].subject).toBe('');
  });

  it('prefers an enriched subject field over tl_dr when present', () => {
    const row = makeRow({ tl_dr: 'fallback' });
    (row as { subject?: string }).subject = 'enriched subject';
    const res = buildAgentDispatches([row], 'finances', '7d', 10, GENERATED_AT);
    expect(res.items[0].subject).toBe('enriched subject');
  });
});

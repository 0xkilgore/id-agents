// SPDX-License-Identifier: MIT
/**
 * DispatchRetryWatcher — auto-retry CTO dispatches that produce no /news
 * after 5 min, surface to Chris when the retry budget is exhausted.
 *
 * Per to-do.md (2026-05-04 Decision 3.2): "When manager dispatches to CTO
 * and no items appear in /news after 5 min, auto-retry once. Hide from
 * Chris unless retry budget is exhausted (then surface)."
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  DispatchRetryWatcher,
  type DispatchJob,
} from '../../src/dispatch-retry-watcher.js';

interface Harness {
  advance: (ms: number) => void;
  pending: Set<string>;
  redispatched: DispatchJob[];
  surfaced: DispatchJob[];
  logs: string[];
  watcher: DispatchRetryWatcher;
}

function makeHarness(overrides: Partial<{
  retryAfterMs: number;
  surfaceAfterMs: number;
  watchAgents: string[];
  failRedispatch: boolean;
}> = {}): Harness {
  let now = 1_700_000_000_000;
  const pending = new Set<string>();
  const redispatched: DispatchJob[] = [];
  const surfaced: DispatchJob[] = [];
  const logs: string[] = [];
  const watcher = new DispatchRetryWatcher({
    now: () => now,
    isPending: async (qid) => pending.has(qid),
    redispatch: async (job) => {
      if (overrides.failRedispatch) throw new Error('redispatch boom');
      redispatched.push({ ...job });
    },
    surface: async (job) => { surfaced.push({ ...job }); },
    log: (m) => logs.push(m),
    retryAfterMs: overrides.retryAfterMs ?? 5 * 60 * 1000,
    surfaceAfterMs: overrides.surfaceAfterMs ?? 10 * 60 * 1000,
    watchAgents: overrides.watchAgents ?? ['cto'],
  });
  return {
    advance: (ms) => { now += ms; },
    pending,
    redispatched,
    surfaced,
    logs,
    watcher,
  };
}

function baseJob(overrides: Partial<DispatchJob> = {}): Omit<DispatchJob, 'retried' | 'surfaced'> {
  return {
    queryId: 'q-1',
    teamId: 't-1',
    agentName: 'cto',
    targetAgentId: 'agent_cto_x',
    targetUrl: 'http://127.0.0.1:5001',
    message: 'plan the thing',
    from: 'manager',
    sessionId: undefined,
    dispatchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('DispatchRetryWatcher', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('only watches dispatches to configured agents (CTO by default)', () => {
    h.watcher.register(baseJob({ agentName: 'walker' }));
    expect(h.watcher.size()).toBe(0);
    h.watcher.register(baseJob({ agentName: 'CTO' }));  // case-insensitive
    expect(h.watcher.size()).toBe(1);
  });

  it('does nothing if reply arrives before retryAfterMs', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(4 * 60 * 1000);  // 4 min
    await h.watcher.tick();
    expect(h.redispatched).toEqual([]);
    expect(h.surfaced).toEqual([]);
    expect(h.watcher.size()).toBe(1);
  });

  it('drops the job from tracking when reply arrives (clear)', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.watcher.clear('q-1');
    expect(h.watcher.size()).toBe(0);
  });

  it('drops the job during tick when query is no longer pending', async () => {
    h.watcher.register(baseJob());
    // not in `pending` set → completed already
    h.advance(6 * 60 * 1000);
    await h.watcher.tick();
    expect(h.redispatched).toEqual([]);
    expect(h.watcher.size()).toBe(0);
  });

  it('retries exactly once after retryAfterMs has elapsed', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(5 * 60 * 1000 + 1_000);  // just past 5 min
    await h.watcher.tick();
    expect(h.redispatched.length).toBe(1);
    expect(h.redispatched[0].queryId).toBe('q-1');
    expect(h.redispatched[0].agentName.toLowerCase()).toBe('cto');
    // tick again immediately — must not re-retry
    await h.watcher.tick();
    expect(h.redispatched.length).toBe(1);
  });

  it('does NOT surface to Chris if only the first retry has happened', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(5 * 60 * 1000 + 1_000);
    await h.watcher.tick();
    expect(h.surfaced).toEqual([]);
  });

  it('surfaces to Chris once retry budget is exhausted (after surfaceAfterMs)', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    // Tick 1 — retry triggers
    h.advance(5 * 60 * 1000 + 1_000);
    await h.watcher.tick();
    expect(h.redispatched.length).toBe(1);
    expect(h.surfaced).toEqual([]);
    // Tick 2 — past surfaceAfterMs (10 min total), still no reply → surface
    h.advance(5 * 60 * 1000);
    await h.watcher.tick();
    expect(h.surfaced.length).toBe(1);
    expect(h.surfaced[0].queryId).toBe('q-1');
    // After surfacing, job is removed
    expect(h.watcher.size()).toBe(0);
    // Idempotent
    await h.watcher.tick();
    expect(h.surfaced.length).toBe(1);
  });

  it('does not retry again after surface even if tick runs again', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(11 * 60 * 1000);  // past both thresholds in one jump
    await h.watcher.tick();   // tick 1: retries
    await h.watcher.tick();   // tick 2: surfaces
    expect(h.redispatched.length).toBe(1);
    expect(h.surfaced.length).toBe(1);
    expect(h.watcher.size()).toBe(0);
  });

  it('logs the retry as an internal manager log line, not a news surface', async () => {
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(5 * 60 * 1000 + 1_000);
    await h.watcher.tick();
    expect(h.logs.some((l) => l.includes('Auto-retry') && l.includes('q-1'))).toBe(true);
    expect(h.surfaced).toEqual([]);
  });

  it('keeps the job tracked if redispatch throws (retries on next tick)', async () => {
    h = makeHarness({ failRedispatch: true });
    h.pending.add('q-1');
    h.watcher.register(baseJob());
    h.advance(5 * 60 * 1000 + 1_000);
    await h.watcher.tick();
    expect(h.redispatched).toEqual([]);  // failed
    expect(h.watcher.size()).toBe(1);
    expect(h.watcher.getJob('q-1')?.retried).toBe(false);
  });
});

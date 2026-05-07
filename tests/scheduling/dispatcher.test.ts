// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ScheduleDispatcher } from '../../src/scheduling/schedule-dispatcher.js';
import type { ScheduleDefinitionRow } from '../../src/db/types.js';
import type { DispatchTarget } from '../../src/scheduling/schedule-types.js';

const def: ScheduleDefinitionRow = {
  id: 'sched-1',
  kind: 'heartbeat',
  title: 'test schedule',
  description: null,
  active: true,
  message: 'do the thing',
  sender: 'schedule',
  delivery_mode: 'talk',
  timezone: null,
  catch_up_policy: 'skip',
  dedupe_window_seconds: 0,
  interval_seconds: 60,
  anchor_at: null,
  max_runs: null,
  expires_at: null,
  local_time_seconds: null,
  local_date: null,
  days_of_week: null,
  source_type: 'manual',
  source_key: null,
  created_at: 0,
  updated_at: 0,
};

const target: DispatchTarget = {
  id: 'agent-1',
  name: 'roger',
  endpoint: 'http://127.0.0.1:9999',
  talkPath: '/talk',
  schedulePath: '/schedule',
  status: 'running',
};

describe('ScheduleDispatcher', () => {
  let calls: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({ url: u, init });
        if (u.endsWith('/dispatches')) {
          return new Response(JSON.stringify({ dispatch_id: 42, status: 'queued' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs /dispatches to the manager before /talk', async () => {
    const d = new ScheduleDispatcher({ managerUrl: 'http://manager.test' });
    const result = await d.dispatch(def, target, 'interval:123', undefined);

    expect(result.success).toBe(true);

    const urls = calls.map((c) => c.url);
    expect(urls).toContain('http://manager.test/dispatches');

    const dispatchIdx = urls.indexOf('http://manager.test/dispatches');
    const talkIdx = urls.findIndex((u) => u.endsWith('/talk'));
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(talkIdx).toBeGreaterThan(dispatchIdx);

    const dispatchBody = JSON.parse(calls[dispatchIdx].init!.body as string);
    expect(dispatchBody.from_actor).toBe('scheduler');
    expect(dispatchBody.to_agent).toBe('roger');
    expect(dispatchBody.channel).toBe('talk');
    expect(dispatchBody.query_id).toBe('interval:123');

    const talkBody = JSON.parse(calls[talkIdx].init!.body as string);
    expect(talkBody.dispatch_id).toBe(42);
  });

  it('flips dispatch to in-flight after a successful /talk', async () => {
    const d = new ScheduleDispatcher({ managerUrl: 'http://manager.test' });
    await d.dispatch(def, target, 'interval:123', undefined);

    const urls = calls.map((c) => c.url);
    expect(urls).toContain('http://manager.test/dispatches/42/in-flight');
  });

  it('still completes /talk if /dispatches register fails', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.endsWith('/dispatches')) {
          return new Response('boom', { status: 500 });
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const d = new ScheduleDispatcher({ managerUrl: 'http://manager.test' });
    const result = await d.dispatch(def, target, 'interval:123', undefined);
    expect(result.success).toBe(true);
  });
});

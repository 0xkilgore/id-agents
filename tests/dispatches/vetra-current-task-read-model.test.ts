// SPDX-License-Identifier: MIT
/**
 * VetraCurrentTaskReadModel — Phase 2 / Task 3.
 *
 * Maps Switchboard GraphQL dispatch documents into the shared
 * AgentCurrentTaskSnapshot contract. Rejects malformed responses and
 * impossible projection states (multiple conflicting open documents for
 * the same agent) with a typed fallback-worthy error so the manager
 * route can fall back to SQLite silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { SwitchboardClient } from '../../src/vetra/switchboard-client.js';
import {
  VetraCurrentTaskReadModel,
  VetraReadFallbackError,
} from '../../src/dispatches/vetra-current-task-read-model.js';

interface FakeResp {
  ok?: boolean;
  status?: number;
  body: unknown;
}

function fakeFetch(resp: FakeResp): typeof fetch {
  return (async (_url: any, _init?: any) => {
    return new Response(JSON.stringify(resp.body), {
      status: resp.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function makeModel(fetchImpl: typeof fetch): VetraCurrentTaskReadModel {
  const client = new SwitchboardClient({
    graphqlUrl: 'http://test.local/graphql',
    accessToken: 'tok',
    fetchImpl,
  });
  return new VetraCurrentTaskReadModel(client);
}

describe('VetraCurrentTaskReadModel', () => {
  it('returns snapshots with current_task: null when Vetra has no open documents', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [] } } }));
    const snaps = await model.getCurrentTaskByAgent(['roger', 'cto']);
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.current_task === null)).toBe(true);
    expect(snaps.every((s) => s.degraded_source === false)).toBe(true);
  });

  it('maps QUEUED/IN_FLIGHT GraphQL statuses to lowercase dashboard enums', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '7', to_agent: 'roger', dispatched_at: '2026-05-08T13:00:00.000Z',
        status: 'QUEUED', body_markdown: '# build read-side', query_id: 'q-1',
        verify_status: null, artifacts: [] },
      { dispatch_id: '8', to_agent: 'cto', dispatched_at: '2026-05-08T13:30:00.000Z',
        status: 'IN_FLIGHT', body_markdown: '# review PR', query_id: null,
        verify_status: 'PASS', artifacts: [{ path: '/tmp/a.md' }] },
    ] } } }));
    const snaps = await model.getCurrentTaskByAgent(['roger', 'cto']);
    const byAgent = Object.fromEntries(snaps.map((s) => [s.agent_id, s]));
    expect(byAgent.roger.current_task!.status).toBe('queued');
    expect(byAgent.roger.current_task!.title).toBe('build read-side');
    expect(byAgent.roger.current_task!.source).toBe('vetra');
    expect(byAgent.cto.current_task!.status).toBe('in_flight');
    expect(byAgent.cto.current_task!.verify_status).toBe('pass');
    expect(byAgent.cto.current_task!.artifact_path).toBe('/tmp/a.md');
  });

  it('chooses the most recent open dispatch per agent (sort by dispatched_at DESC)', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '1', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
        status: 'IN_FLIGHT', body_markdown: 'older', query_id: null, verify_status: null, artifacts: [] },
      { dispatch_id: '2', to_agent: 'roger', dispatched_at: '2026-05-08T11:00:00.000Z',
        status: 'QUEUED', body_markdown: 'newer', query_id: null, verify_status: null, artifacts: [] },
    ] } } }));
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task!.title).toBe('newer');
    expect(snap.current_task!.dispatch_id).toBe('2');
  });

  it('emits a snapshot for every requested agent even when Vetra returned none', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '1', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
        status: 'QUEUED', body_markdown: 'roger task', query_id: null, verify_status: null, artifacts: [] },
    ] } } }));
    const snaps = await model.getCurrentTaskByAgent(['roger', 'sentinel', 'cto']);
    const byAgent = Object.fromEntries(snaps.map((s) => [s.agent_id, s]));
    expect(byAgent.roger.current_task).not.toBeNull();
    expect(byAgent.sentinel.current_task).toBeNull();
    expect(byAgent.cto.current_task).toBeNull();
  });

  it('throws VetraReadFallbackError on malformed (missing data) response', async () => {
    const model = makeModel(fakeFetch({ body: { errors: [{ message: 'kaboom' }] } }));
    await expect(model.getCurrentTaskByAgent(['roger'])).rejects.toBeInstanceOf(VetraReadFallbackError);
  });

  it('throws VetraReadFallbackError on a row missing required fields', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '1', to_agent: 'roger' /* missing dispatched_at + status */ },
    ] } } }));
    await expect(model.getCurrentTaskByAgent(['roger'])).rejects.toBeInstanceOf(VetraReadFallbackError);
  });

  it('rejects two open documents with identical timestamps for the same agent as invalid state', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '1', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
        status: 'QUEUED', body_markdown: 'a', query_id: null, verify_status: null, artifacts: [] },
      { dispatch_id: '2', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
        status: 'IN_FLIGHT', body_markdown: 'b', query_id: null, verify_status: null, artifacts: [] },
    ] } } }));
    await expect(model.getCurrentTaskByAgent(['roger'])).rejects.toBeInstanceOf(VetraReadFallbackError);
  });

  it('throws VetraReadFallbackError when the HTTP layer fails', async () => {
    const model = makeModel((async () => { throw new Error('connect refused'); }) as unknown as typeof fetch);
    await expect(model.getCurrentTaskByAgent(['roger'])).rejects.toBeInstanceOf(VetraReadFallbackError);
  });

  it('ignores non-open Vetra statuses (DONE, FAILED, ...) in case the server returns extras', async () => {
    const model = makeModel(fakeFetch({ body: { data: { openDispatches: [
      { dispatch_id: '1', to_agent: 'roger', dispatched_at: '2026-05-08T11:00:00.000Z',
        status: 'DONE', body_markdown: 'closed', query_id: null, verify_status: null, artifacts: [] },
      { dispatch_id: '2', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
        status: 'QUEUED', body_markdown: 'open', query_id: null, verify_status: null, artifacts: [] },
    ] } } }));
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task!.title).toBe('open');
  });
});

describe('SwitchboardClient', () => {
  it('passes Authorization header when accessToken is set', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { openDispatches: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test.local/graphql',
      accessToken: 'sekrit',
      fetchImpl,
    });
    await client.queryOpenDispatches(['roger']);
    expect(calls).toHaveLength(1);
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sekrit');
  });

  it('omits Authorization header when token is null', async () => {
    const calls: { init: RequestInit }[] = [];
    const fetchImpl = (async (_url: any, init?: any) => {
      calls.push({ init });
      return new Response(JSON.stringify({ data: { openDispatches: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test.local/graphql',
      accessToken: null,
      fetchImpl,
    });
    await client.queryOpenDispatches(['roger']);
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('throws on non-2xx status with status + preview', async () => {
    const fetchImpl = (async () => new Response('Internal Server Error', { status: 500 })) as unknown as typeof fetch;
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test.local/graphql',
      accessToken: null,
      fetchImpl,
    });
    await expect(client.queryOpenDispatches(['roger'])).rejects.toThrow(/500/);
  });

  it('aborts requests after the timeout', async () => {
    const fetchImpl = ((_url: any, init?: any) => new Promise((_resolve, reject) => {
      // Use the AbortSignal to reject when aborted
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test.local/graphql',
      accessToken: null,
      fetchImpl,
      timeoutMs: 25,
    });
    await expect(client.queryOpenDispatches(['roger'])).rejects.toThrow(/abort|timeout/i);
  });
});

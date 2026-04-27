// SPDX-License-Identifier: MIT
//
// Spec 053 — runVerifySignal conformance tests. Tests inject fakes via
// VerifyContext so checks run hermetically (no real HTTP / FS / Vercel).

import { describe, it, expect } from 'vitest';
import { runVerifySignal } from '../../src/verify/runner.js';
import type { VerifyContext } from '../../src/verify/types.js';

const assert = {
  equal<T>(actual: T, expected: T) { expect(actual).toBe(expected); },
};

describe('runVerifySignal', () => {
  it('passes desk_tag when artifact path is in Desk.md', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
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
      dispatched_at: Date.now(),
      readFile: async () => '# Desk\n\nnothing relevant\n',
    };
    const result = await runVerifySignal(
      { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      ctx,
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.failures.length, 1);
  });

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

  it('passes file_mtime when stat shows mtime after the threshold', async () => {
    const ctx: VerifyContext = {
      dispatched_at: 1000,
      statFile: async () => ({ mtimeMs: 5000 }),
    };
    const result = await runVerifySignal(
      { type: 'file_mtime', path: '/tmp/x', after: 4 }, // 4 seconds = 4000 ms
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

  it('passes api_call vercel_deploy when state is READY', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      fetch: (async () =>
        new Response(JSON.stringify({ readyState: 'READY' }), { status: 200 })) as typeof fetch,
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
      fetch: (async () =>
        new Response(JSON.stringify({ readyState: 'ERROR' }), { status: 200 })) as typeof fetch,
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
    expect(result.failures[0].reason).toMatch(/not yet implemented/);
  });
});

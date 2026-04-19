/**
 * GET /health contract test — per design Section 3:
 *   { status: "ok", version, uptime_s, last_boot, upstream: { openrouter: "ok"|"error" } }
 *
 * /healthz is kept as a backward-compat alias returning the same body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { healthRoutes } from '../src/routes/health.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

describe('GET /health', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 200 with status=ok and all required keys', async () => {
    const env = makeEnv({ version: '1.2.3', bootTimeMs: Date.now() - 5000 });
    const app = new Hono().route('/', healthRoutes(env));

    const res = await req(app, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(typeof body.uptime_s).toBe('number');
    expect(body.uptime_s as number).toBeGreaterThanOrEqual(0);
    expect(typeof body.last_boot).toBe('string');
    expect(() => new Date(body.last_boot as string)).not.toThrow();
    const upstream = body.upstream as Record<string, unknown>;
    expect(upstream.openrouter).toBe('ok');
  });

  it('reports upstream.openrouter=error when the probe fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network');
    }) as any;
    const env = makeEnv();
    const app = new Hono().route('/', healthRoutes(env));

    const res = await req(app, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const upstream = body.upstream as Record<string, unknown>;
    expect(upstream.openrouter).toBe('error');
  });

  it('/healthz backward-compat alias returns the same shape', async () => {
    const env = makeEnv({ version: '1.2.3' });
    const app = new Hono().route('/', healthRoutes(env));

    const res = await req(app, 'GET', '/healthz');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
  });
});

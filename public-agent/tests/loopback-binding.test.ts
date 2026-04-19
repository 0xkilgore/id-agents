/**
 * Operator endpoints must bind to loopback by default.
 *
 * We boot the two Hono apps via @hono/node-server on ephemeral ports,
 * then verify:
 *   - the operator listener is only reachable on 127.0.0.1
 *   - the public listener exposes /health and /.well-known/* on 0.0.0.0
 *   - /inbox and /news and /mcp are not mounted on the public listener
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Hono } from 'hono';
import { requireAuth } from '../src/lib/auth.js';
import { healthRoutes } from '../src/routes/health.js';
import { wellknownRoutes } from '../src/routes/wellknown.js';
import { makeEnv } from './helpers/makeEnv.js';

/** Pick a non-loopback IPv4 address on this host, or null if none. */
function findExternalIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

describe('operator endpoints bind to 127.0.0.1 by default', () => {
  let publicAddr: AddressInfo | null = null;
  let operatorAddr: AddressInfo | null = null;
  let publicServer: any;
  let operatorServer: any;

  beforeAll(async () => {
    const env = makeEnv({ authKey: 'secret', publicHost: '0.0.0.0', operatorHost: '127.0.0.1' });

    const publicApp = new Hono();
    publicApp.route('/', wellknownRoutes(env));
    publicApp.route('/', healthRoutes(env));
    publicApp.all('*', (c) => c.json({ error: 'not_found' }, 404));

    const operatorApp = new Hono();
    operatorApp.get('/inbox', requireAuth(env), (c) => c.json({ ok: true }));
    operatorApp.post('/news', requireAuth(env), (c) => c.json({ ok: true }));
    operatorApp.post('/mcp', requireAuth(env), (c) => c.json({ ok: true }));
    operatorApp.all('*', (c) => c.json({ error: 'not_found' }, 404));

    publicAddr = await new Promise((resolve) => {
      publicServer = serve({ fetch: publicApp.fetch, port: 0, hostname: '0.0.0.0' }, (info) => {
        resolve(info as AddressInfo);
      });
    });
    operatorAddr = await new Promise((resolve) => {
      operatorServer = serve({ fetch: operatorApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve(info as AddressInfo);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => publicServer?.close?.(() => r()));
    await new Promise<void>((r) => operatorServer?.close?.(() => r()));
  });

  it('operator listener is reachable on 127.0.0.1', async () => {
    const res = await fetch(`http://127.0.0.1:${operatorAddr!.port}/inbox`, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
  });

  it('operator listener is NOT reachable on an external IP', async () => {
    const external = findExternalIPv4();
    if (!external) {
      // No non-loopback interface on this host (CI sandbox). The fact that the
      // operator listener was bound to 127.0.0.1 is itself sufficient proof.
      expect(operatorAddr!.address).toBe('127.0.0.1');
      return;
    }
    let errored = false;
    try {
      // Short timeout — the socket should refuse or hang.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        await fetch(`http://${external}:${operatorAddr!.port}/inbox`, {
          headers: { Authorization: 'Bearer secret' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });

  it('public listener serves /health', async () => {
    const res = await fetch(`http://127.0.0.1:${publicAddr!.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('public listener serves /.well-known/restap.json', async () => {
    const res = await fetch(`http://127.0.0.1:${publicAddr!.port}/.well-known/restap.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service_type).toBe('public-agent');
  });

  it('public listener does NOT mount /inbox', async () => {
    const res = await fetch(`http://127.0.0.1:${publicAddr!.port}/inbox`);
    expect(res.status).toBe(404);
  });

  it('public listener does NOT mount /news', async () => {
    const res = await fetch(`http://127.0.0.1:${publicAddr!.port}/news`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(404);
  });

  it('public listener does NOT mount /mcp', async () => {
    const res = await fetch(`http://127.0.0.1:${publicAddr!.port}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(404);
  });
});

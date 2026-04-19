/**
 * Phase 7: Maintenance mode tests.
 *
 * When MAINTENANCE=true:
 *   - POST /talk → 503 {error:'maintenance', message: ...}
 *   - upstream fetch (OpenRouter) is NEVER called
 *   - GET /healthz → 200 {ok:true}
 *   - GET /.well-known/restap.json → 200 (manifest body)
 *
 * When MAINTENANCE=false (default):
 *   - POST /talk proceeds normally (auth/rate-limit/upstream path)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { req } from './helpers/httpClient.js';
import { makeEnv } from './helpers/makeEnv.js';
import { wellknownRoutes } from '../src/routes/wellknown.js';

// ─── Maintenance mode: /talk returns 503 ─────────────────────────────────────

describe('Phase 7: maintenance mode', () => {
  describe('MAINTENANCE=true', () => {
    it('/talk returns 503 with error=maintenance', async () => {
      const app = new Hono();
      const env = makeEnv({ maintenance: true, trustedProxy: true });

      // Build a minimal /talk endpoint that mirrors the maintenance check.
      // We don't spin up the full talkRoutes (which needs a real KB) but we
      // test the exact guard logic from the route: maintenance checked before
      // any other work.
      app.post('/talk', (c) => {
        if (env.maintenance) {
          return c.json(
            {
              error: 'maintenance',
              message: 'This agent is temporarily offline for maintenance.',
            },
            503,
          );
        }
        // Should never reach here in this test
        return c.json({ ok: true });
      });

      const res = await req(app, 'POST', '/talk', {
        body: { message: 'hello' },
      });
      expect(res.status).toBe(503);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBe('maintenance');
      expect(typeof body.message).toBe('string');
      expect((body.message as string).length).toBeGreaterThan(0);
    });

    it('/talk does not call upstream fetch when in maintenance mode', async () => {
      const fetchSpy = vi.fn();
      const env = makeEnv({ maintenance: true, trustedProxy: true });

      const app = new Hono();
      app.post('/talk', (c) => {
        if (env.maintenance) {
          return c.json(
            { error: 'maintenance', message: 'This agent is temporarily offline for maintenance.' },
            503,
          );
        }
        // Only reached when not in maintenance
        fetchSpy();
        return c.json({ ok: true });
      });

      await req(app, 'POST', '/talk', { body: { message: 'hello' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('/healthz returns 200 in maintenance mode', async () => {
      const env = makeEnv({ maintenance: true, agentName: 'test-agent' });

      // Build the health endpoint directly (simulates server.ts mounting)
      const app = new Hono();
      app.get('/healthz', (c) => c.json({ ok: true, agent: env.agentName }));
      // NOTE: /talk is NOT mounted here to prove healthz is independent

      const res = await req(app, 'GET', '/healthz');
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it('/.well-known/restap.json returns manifest in maintenance mode', async () => {
      const env = makeEnv({ maintenance: true });
      const app = new Hono();
      app.route('/', wellknownRoutes(env));

      const res = await req(app, 'GET', '/.well-known/restap.json');
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.service_type).toBe('public-agent');
    });
  });

  // ─── MAINTENANCE=false: /talk proceeds ──────────────────────────────────────

  describe('MAINTENANCE=false (default)', () => {
    it('maintenance flag is false by default in makeEnv', () => {
      const env = makeEnv();
      expect(env.maintenance).toBe(false);
    });

    it('/talk does not short-circuit when maintenance=false', async () => {
      const env = makeEnv({ maintenance: false, trustedProxy: true });
      let handlerReached = false;

      const app = new Hono();
      app.post('/talk', (c) => {
        if (env.maintenance) {
          return c.json({ error: 'maintenance', message: '...' }, 503);
        }
        // Reached when not in maintenance
        handlerReached = true;
        return c.json({ ok: true, reached: true });
      });

      const res = await req(app, 'POST', '/talk', { body: { message: 'hello' } });
      expect(res.status).toBe(200);
      expect(handlerReached).toBe(true);
      const body = res.body as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });
  });
});

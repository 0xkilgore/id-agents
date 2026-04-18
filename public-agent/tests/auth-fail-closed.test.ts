/**
 * F-01: requireAuth fails closed when PUBLIC_AGENT_AUTH_KEY is unset.
 *
 * Tests:
 * - No key + no dev flag: operator endpoints (inbox/news/mcp) return 401.
 * - Key set: wrong/missing bearer → 401.
 * - No key + ALLOW_PUBLIC_UNAUTHENTICATED=true: endpoints work without bearer.
 * - /talk with no key + no dev flag: still accepts calls (public by design).
 * - /.well-known/restap.json and /healthz: always public.
 */
import { describe, it, expect } from 'vitest';
import { makeEnv, makeOperatorApp, makeTalkApp } from './helpers/makeApp.js';
import { req } from './helpers/httpClient.js';

describe('F-01: requireAuth fail-closed', () => {
  describe('no auth key, no dev flag → operator endpoints 401', () => {
    const env = makeEnv({ authKey: null, allowPublicUnauthenticated: false });
    const app = makeOperatorApp(env);

    it('GET /inbox → 401 auth_required', async () => {
      const res = await req(app, 'GET', '/inbox');
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe('auth_required');
    });

    it('POST /news → 401 auth_required', async () => {
      const res = await req(app, 'POST', '/news', { body: {} });
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe('auth_required');
    });

    it('POST /mcp → 401 auth_required', async () => {
      const res = await req(app, 'POST', '/mcp', { body: {} });
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe('auth_required');
    });
  });

  describe('auth key set → wrong/missing bearer → 401', () => {
    const env = makeEnv({ authKey: 'secret123', allowPublicUnauthenticated: false });
    const app = makeOperatorApp(env);

    it('GET /inbox with no Authorization → 401', async () => {
      const res = await req(app, 'GET', '/inbox');
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe('unauthorized');
    });

    it('GET /inbox with wrong token → 401', async () => {
      const res = await req(app, 'GET', '/inbox', {
        headers: { Authorization: 'Bearer wrongkey' },
      });
      expect(res.status).toBe(401);
    });

    it('POST /news with correct token → 200', async () => {
      const res = await req(app, 'POST', '/news', {
        headers: { Authorization: 'Bearer secret123' },
        body: {},
      });
      expect(res.status).toBe(200);
    });
  });

  describe('no key + ALLOW_PUBLIC_UNAUTHENTICATED=true → endpoints open', () => {
    const env = makeEnv({ authKey: null, allowPublicUnauthenticated: true });
    const app = makeOperatorApp(env);

    it('GET /inbox without bearer → 200', async () => {
      const res = await req(app, 'GET', '/inbox');
      expect(res.status).toBe(200);
    });

    it('POST /news without bearer → 200', async () => {
      const res = await req(app, 'POST', '/news', { body: {} });
      expect(res.status).toBe(200);
    });

    it('POST /mcp without bearer → 200', async () => {
      const res = await req(app, 'POST', '/mcp', { body: {} });
      expect(res.status).toBe(200);
    });
  });

  describe('/talk with no key + no dev flag → still open (public by design)', () => {
    const env = makeEnv({ authKey: null, allowPublicUnauthenticated: false });
    // Handler just returns 200 OK; no actual OpenRouter call.
    const app = makeTalkApp(env, (c) => c.json({ ok: true }));

    it('POST /talk without auth → 200 (public surface)', async () => {
      const res = await req(app, 'POST', '/talk', { body: { message: 'hello' } });
      expect(res.status).toBe(200);
    });
  });

  describe('well-known and health are always public', () => {
    const env = makeEnv({ authKey: null, allowPublicUnauthenticated: false });
    const app = makeOperatorApp(env);

    it('GET /.well-known/restap.json → 200 (no auth)', async () => {
      const res = await req(app, 'GET', '/.well-known/restap.json');
      expect(res.status).toBe(200);
    });

    it('GET /healthz → 200 (no auth)', async () => {
      const res = await req(app, 'GET', '/healthz');
      expect(res.status).toBe(200);
    });
  });
});

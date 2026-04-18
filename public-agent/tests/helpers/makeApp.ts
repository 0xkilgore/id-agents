/**
 * Factory for building a minimal Hono app for unit tests.
 * Mounts only the route(s) under test to avoid startup side effects
 * (knowledge manifest load, budget file, etc.).
 */
import { Hono } from 'hono';
import { requireAuth, requireAuthOrPublicTalk } from '../../src/lib/auth.js';
export { makeEnv } from './makeEnv.js';

/** Build a tiny app that mounts /inbox, /news, /mcp with requireAuth. */
export function makeOperatorApp(env: Env): Hono {
  const app = new Hono();
  app.get('/inbox', requireAuth(env), (c) => c.json({ ok: true }));
  app.post('/news', requireAuth(env), (c) => c.json({ ok: true }));
  app.post('/mcp', requireAuth(env), (c) => c.json({ ok: true }));
  app.get('/.well-known/restap.json', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ ok: true }));
  return app;
}

/** Build a tiny /talk app that uses requireAuthOrPublicTalk. */
export function makeTalkApp(
  env: Env,
  handler: (c: import('hono').Context) => Response | Promise<Response>,
): Hono {
  const app = new Hono();
  app.post('/talk', requireAuthOrPublicTalk(env), handler);
  return app;
}

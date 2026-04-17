import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * Require a bearer token matching PUBLIC_AGENT_AUTH_KEY.
 * If the env var is unset, the middleware is a no-op (every endpoint open).
 */
export function requireAuth(env: Env): MiddlewareHandler {
  if (env.authKey === null) {
    return async (_c, next) => {
      await next();
    };
  }
  const expected = env.authKey;
  return async (c, next) => {
    const header = c.req.header('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || m[1]!.trim() !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}

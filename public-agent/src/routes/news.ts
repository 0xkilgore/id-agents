import { Hono } from 'hono';
import type { Env } from '../env.js';
import { appendNews, tailNews } from '../lib/news-log.js';
import { requireAuth } from '../lib/auth.js';

export function newsRoutes(env: Env): Hono {
  const app = new Hono();

  app.post('/news', requireAuth(env), async (c) => {
    let body: { type?: string; from?: string; message?: string; data?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!from) return c.json({ error: 'missing_from' }, 400);
    if (!message) return c.json({ error: 'missing_message' }, 400);
    const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : 'notify';

    const item = appendNews(env, { type, from, message, data: body.data });
    return c.json({ ok: true, id: item.id, timestamp: item.timestamp });
  });

  app.get('/news', requireAuth(env), (c) => {
    const sinceId = Number(c.req.query('since_id') ?? 0);
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? 100)));
    const { items, next_since_id } = tailNews(env, Number.isFinite(sinceId) ? sinceId : 0, limit);
    return c.json({ items, next_since_id });
  });

  return app;
}

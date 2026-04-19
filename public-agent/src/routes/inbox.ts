import { Hono } from 'hono';
import type { Env } from '../env.js';
import { archiveEntry, isValidInboxId, listInbox } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';

export function inboxRoutes(env: Env): Hono {
  const app = new Hono();

  app.get('/inbox', requireAuth(env), (c) => {
    const status = (c.req.query('status') ?? 'unread').toLowerCase();
    if (status !== 'unread' && status !== 'archived' && status !== 'all') {
      return c.json({ error: 'invalid_status', detail: 'status must be unread, archived, or all' }, 400);
    }
    const entries = listInbox(env, status);
    return c.json({
      count: entries.length,
      entries: entries.map((e) => ({
        id: e.id,
        received_at: e.received_at,
        from: e.from,
        status: e.status,
        message_preview: e.message.slice(0, 200),
        reply_preview: e.reply.slice(0, 200),
        tokens_used: e.tokens_used,
      })),
    });
  });

  app.post('/inbox/:id/archive', requireAuth(env), (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing_id' }, 400);
    if (!isValidInboxId(id)) {
      // Reject anything that isn't a well-formed inbox id before it can reach
      // the filesystem. Stops `..` / `/` / NUL-byte path-traversal attempts.
      return c.json({ error: 'invalid_id', detail: 'id must match ^[0-9T-]+-[a-f0-9]{6}$' }, 400);
    }
    const entry = archiveEntry(env, id);
    if (!entry) return c.json({ error: 'not_found', id }, 404);
    return c.json({ ok: true, id: entry.id, status: entry.status, archived_at: entry.archived_at });
  });

  return app;
}

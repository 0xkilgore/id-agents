import { Hono } from 'hono';
import type { Env } from '../env.js';
import { openRouterChat } from '../lib/openrouter.js';
import { writeInboxEntry, makeInboxId, type InboxEntry } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';
import { ipOf, tokenBucket } from '../lib/rate-limit.js';
import { isOverBudget, recordTokens } from '../lib/budget.js';

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  // Behind a reverse proxy we'd trust X-Forwarded-For; on Colima/Docker the
  // client IP comes through as the socket's remoteAddress, which Hono exposes
  // via the underlying request headers only when a proxy sets them. Keep this
  // best-effort for v1 — rate-limiter can still tell containers apart.
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? null;
}

export function talkRoutes(env: Env): Hono {
  const app = new Hono();
  const limiter = tokenBucket(env.talkRateLimitPerMin, ipOf);

  app.post('/talk', requireAuth(env), limiter, async (c) => {
    const budget = isOverBudget(env);
    if (budget.over) {
      return c.json(
        { error: 'budget_exceeded', used: budget.used, limit: env.maxTokensPerDay, resets_at: budget.resets_at },
        503,
      );
    }

    let body: { message?: string; from?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return c.json({ error: 'missing_message', detail: 'body.message is required and must be non-empty' }, 400);
    }
    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : null;

    const id = makeInboxId();

    let reply: string;
    let model: string;
    let usage: { prompt: number; completion: number; total: number };
    try {
      const result = await openRouterChat(env, message);
      reply = result.reply;
      model = result.model;
      usage = result.usage;
    } catch (err) {
      console.error('[public-agent] /talk openrouter error:', err);
      return c.json({ error: 'upstream_error', detail: (err as Error).message }, 502);
    }

    try {
      recordTokens(env, usage.total);
    } catch (err) {
      console.error('[public-agent] /talk budget write failed:', err);
    }

    const entry: InboxEntry = {
      id,
      received_at: new Date().toISOString(),
      from,
      ip: clientIp(c),
      message,
      reply,
      model,
      tokens_used: usage,
      status: 'unread',
    };
    try {
      writeInboxEntry(env, entry);
    } catch (err) {
      console.error('[public-agent] /talk inbox write failed:', err);
    }

    return c.json({ reply, model, inbox_id: id, tokens_used: usage });
  });

  return app;
}

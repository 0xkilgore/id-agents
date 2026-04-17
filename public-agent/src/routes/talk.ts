import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Env } from '../env.js';
import { openRouterChat } from '../lib/openrouter.js';
import { writeInboxEntry, makeInboxId, type InboxEntry } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';
import { clientIp, tokenBucket } from '../lib/rate-limit.js';
import { isOverBudget, reserveTokens, reconcileTokens } from '../lib/budget.js';

export function talkRoutes(env: Env): Hono {
  const app = new Hono();
  // One IP resolver for the whole route — the rate-limiter and the inbox
  // writer must agree on who "this client" is. If trustedProxy=false and no
  // socket IP is available, the resolver returns null and we bail 400.
  const resolve = (c: Context) => clientIp(c, getConnInfo, env.trustedProxy);
  const limiter = tokenBucket(env.talkRateLimitPerMin, (c) => {
    const ip = resolve(c);
    // tokenBucket expects a non-null key; '' collides across clients, but
    // we block requests without an IP before this runs via the handler
    // below. Returning a constant here is only hit on paths where the
    // handler has already 400'd, so it's harmless.
    return ip ?? '__no_ip__';
  });

  app.post('/talk', requireAuth(env), async (c, next) => {
    const ip = resolve(c);
    if (!ip) {
      return c.json(
        {
          error: 'unknown_client',
          detail:
            'Could not determine client IP. Set TRUSTED_PROXY=true only if a known reverse proxy sets X-Forwarded-For.',
        },
        400,
      );
    }
    await next();
  }, limiter, async (c) => {
    // resolve() is idempotent — re-run here so we don't need to thread the
    // value through Hono's Variables type. The null-case is already gated
    // out by the preceding middleware.
    const ip = resolve(c) ?? '';
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

    // Cap the completion at what's left in today's budget so a runaway model
    // can't push tokens_used past maxTokensPerDay. If the budget is disabled
    // (maxTokensPerDay <= 0), remaining is +Infinity and we fall back to the
    // configured reply ceiling.
    const cap = Number.isFinite(budget.remaining)
      ? Math.min(env.maxReplyTokens, budget.remaining)
      : env.maxReplyTokens;

    // Pre-reserve the cap before the upstream call. Two concurrent /talk
    // requests must not both slip past the isOverBudget check and each
    // consume their full cap. We reconcile down to actual usage when the
    // call returns (success OR failure).
    const reserved = Math.max(0, cap);
    if (reserved > 0) {
      try {
        reserveTokens(env, reserved);
      } catch (err) {
        console.error('[public-agent] /talk budget reserve failed:', err);
      }
    }

    let reply: string;
    let model: string;
    let usage: { prompt: number; completion: number; total: number };
    try {
      const result = await openRouterChat(env, message, { maxTokens: cap > 0 ? cap : undefined });
      reply = result.reply;
      model = result.model;
      usage = result.usage;
    } catch (err) {
      // Upstream failed — release the reservation so it doesn't permanently
      // eat the daily budget for a call that produced nothing.
      if (reserved > 0) {
        try {
          reconcileTokens(env, reserved, 0);
        } catch (reconcileErr) {
          console.error('[public-agent] /talk budget reconcile (on error) failed:', reconcileErr);
        }
      }
      console.error('[public-agent] /talk openrouter error:', err);
      return c.json({ error: 'upstream_error', detail: (err as Error).message }, 502);
    }

    try {
      reconcileTokens(env, reserved, usage.total);
    } catch (err) {
      console.error('[public-agent] /talk budget reconcile failed:', err);
    }

    const entry: InboxEntry = {
      id,
      received_at: new Date().toISOString(),
      from,
      ip,
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

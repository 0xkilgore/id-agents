import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Env } from '../env.js';
import { openRouterChatMessages } from '../lib/openrouter.js';
import { writeInboxEntry, makeInboxId, type InboxEntry } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';
import { clientIp, tokenBucket } from '../lib/rate-limit.js';
import { isOverBudget, reserveTokens, reconcileTokens } from '../lib/budget.js';
import { createSessionStore } from '../lib/sessions.js';

export function talkRoutes(env: Env): Hono {
  const app = new Hono();
  const sessions = createSessionStore(env);

  // One IP resolver for the whole route — the rate-limiter and the inbox
  // writer must agree on who "this client" is. If trustedProxy=false and no
  // socket IP is available, the resolver returns null and we bail 400.
  const resolve = (c: Context) => clientIp(c, getConnInfo, env.trustedProxy);
  const limiter = tokenBucket(env.talkRateLimitPerMin, (c) => {
    const ip = resolve(c);
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
    const ip = resolve(c) ?? '';
    const budget = isOverBudget(env);
    if (budget.over) {
      return c.json(
        { error: 'budget_exceeded', used: budget.used, limit: env.maxTokensPerDay, resets_at: budget.resets_at },
        503,
      );
    }

    let body: { message?: unknown; from?: unknown; session_id?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return c.json(
        { error: 'missing_message', detail: 'body.message (string) is required' },
        400,
      );
    }

    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : null;
    const requestedSessionId =
      typeof body.session_id === 'string' && body.session_id.trim() ? body.session_id.trim() : null;

    const { session } = sessions.getOrCreate(requestedSessionId);

    // Enforce the per-session turn cap BEFORE appending the user turn so the
    // client can rotate to a new session cleanly. The check happens after
    // getOrCreate so a stale session_id that evicted doesn't count against
    // the caller's fresh session.
    if (session.turnCount >= env.maxTurnsPerSession) {
      return c.json(
        {
          error: 'session_turn_limit',
          detail: `session exceeded ${env.maxTurnsPerSession} user turns; start a new session`,
          new_session_required: true,
          session_id: session.id,
        },
        409,
      );
    }

    sessions.append(session.id, 'user', message);
    const outgoingMessages = session.messages.slice();

    const id = makeInboxId();

    const cap = Number.isFinite(budget.remaining)
      ? Math.min(env.maxReplyTokens, budget.remaining)
      : env.maxReplyTokens;

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
      const result = await openRouterChatMessages(env, outgoingMessages, { maxTokens: cap > 0 ? cap : undefined });
      reply = result.reply;
      model = result.model;
      usage = result.usage;
    } catch (err) {
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

    sessions.append(session.id, 'assistant', reply);

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
      session_id: session.id,
    };
    try {
      writeInboxEntry(env, entry);
    } catch (err) {
      console.error('[public-agent] /talk inbox write failed:', err);
    }

    return c.json({
      reply,
      model,
      inbox_id: id,
      tokens_used: usage,
      session_id: session.id,
    });
  });

  return app;
}

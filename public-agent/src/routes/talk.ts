import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Env } from '../env.js';
import { openRouterChatMessages, type ChatMessage } from '../lib/openrouter.js';
import { writeInboxEntry, makeInboxId, type InboxEntry } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';
import { clientIp, tokenBucket } from '../lib/rate-limit.js';
import { isOverBudget, reserveTokens, reconcileTokens } from '../lib/budget.js';

// Roles we accept from the client. The server always prepends its own
// system prompt inside openRouterChatMessages, so `system` turns supplied
// here are additive, not a replacement.
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

function coerceMessages(raw: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'messages must be an array' };
  if (raw.length === 0) return { ok: false, error: 'messages must be non-empty' };
  const out: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as { role?: unknown; content?: unknown } | null;
    if (!m || typeof m !== 'object') return { ok: false, error: `messages[${i}] must be an object` };
    const role = typeof m.role === 'string' ? m.role : '';
    const content = typeof m.content === 'string' ? m.content : '';
    if (!ALLOWED_ROLES.has(role)) return { ok: false, error: `messages[${i}].role must be one of system|user|assistant` };
    if (!content.trim()) return { ok: false, error: `messages[${i}].content must be a non-empty string` };
    out.push({ role: role as ChatMessage['role'], content });
  }
  return { ok: true, messages: out };
}

function lastUserTurn(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return '';
}

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

    let body: { message?: unknown; from?: unknown; messages?: unknown; session_id?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const hasMessage = typeof body.message === 'string' && body.message.trim().length > 0;
    const hasMessages = body.messages !== undefined && body.messages !== null;

    if (hasMessage && hasMessages) {
      return c.json(
        { error: 'conflicting_body', detail: 'Pass either `message` (string) or `messages` (array), not both.' },
        400,
      );
    }

    let messages: ChatMessage[];
    if (hasMessages) {
      const parsed = coerceMessages(body.messages);
      if (!parsed.ok) {
        return c.json({ error: 'invalid_messages', detail: parsed.error }, 400);
      }
      messages = parsed.messages;
    } else if (hasMessage) {
      messages = [{ role: 'user', content: (body.message as string).trim() }];
    } else {
      return c.json(
        { error: 'missing_message', detail: 'body.message (string) or body.messages (array) is required' },
        400,
      );
    }

    const latestUserTurn = lastUserTurn(messages);
    if (!latestUserTurn) {
      return c.json({ error: 'no_user_turn', detail: 'messages must contain at least one user turn' }, 400);
    }

    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : null;
    const session_id = typeof body.session_id === 'string' && body.session_id.trim() ? body.session_id.trim() : null;

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
      const result = await openRouterChatMessages(env, messages, { maxTokens: cap > 0 ? cap : undefined });
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
      // `message` stays the latest user turn for preview/backwards-compat;
      // full conversation goes under `messages` when history was supplied.
      message: latestUserTurn,
      reply,
      model,
      tokens_used: usage,
      status: 'unread',
      session_id,
      // Store the full array regardless — one-shot calls just have a single
      // user turn. Keeps review simpler than branching on presence.
      messages,
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
      session_id: session_id ?? undefined,
    });
  });

  return app;
}

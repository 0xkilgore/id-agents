import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { Env } from '../env.js';
import { openRouterRawCall, type ChatMessage, type RawAssistantMessage } from '../lib/openrouter.js';
import { writeInboxEntry, makeInboxId, type InboxEntry } from '../lib/inbox.js';
import { requireAuth } from '../lib/auth.js';
import { clientIp, tokenBucket } from '../lib/rate-limit.js';
import { isOverBudget, reserveTokens, reconcileTokens } from '../lib/budget.js';
import { createSessionStore, type Session } from '../lib/sessions.js';
import { classifyMessage, type GuardVerdict } from '../lib/guard.js';
import { REFUSAL_REPLY, UNDER_REVIEW_REPLY, mainSystemPrompt } from '../lib/prompts.js';
import {
  KNOWLEDGE_MAX_TOOL_CALLS_PER_REQUEST,
  KNOWLEDGE_MAX_TOOL_OUTPUT_BYTES,
  KNOWLEDGE_TOOL_DEFS,
  KNOWLEDGE_TOOL_TIMEOUT_MS,
  executeKnowledgeTool,
  wrapToolContent,
  type KnowledgeManifest,
  type ToolCallLog,
} from '../lib/knowledge.js';

// The server-minted session_id is a UUID v4. Clients echo it back verbatim.
// Reject anything that isn't shaped like one so a garbage id can't cause
// weird lookups downstream.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildTalkSchema(env: Env) {
  return z
    .object({
      message: z.string().min(1).max(env.maxMessageChars),
      from: z.string().max(120).optional(),
      session_id: z
        .string()
        .regex(UUID_RE, 'session_id must be a UUID v4')
        .optional(),
    })
    .strict();
}

type TalkInput = z.infer<ReturnType<typeof buildTalkSchema>>;

function sanitizeFrom(from: string | undefined): string | null {
  if (typeof from !== 'string') return null;
  const trimmed = from.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

async function runGuardOrFail(
  env: Env,
  message: string,
): Promise<
  | { ok: true; verdict: GuardVerdict; usage: { prompt: number; completion: number; total: number }; model: string }
  | { ok: false; response: { status: number; body: Record<string, unknown> } }
> {
  try {
    const result = await classifyMessage(env, message);
    return { ok: true, verdict: result.verdict, usage: result.usage, model: result.model };
  } catch (err) {
    console.error('[public-agent] /talk guard failed (fail-closed):', err);
    return {
      ok: false,
      response: {
        status: 503,
        body: {
          error: 'guard_unavailable',
          detail: 'Safety classifier unavailable; request refused.',
        },
      },
    };
  }
}

function writeGuardedInbox(
  env: Env,
  params: {
    id: string;
    ip: string;
    from: string | null;
    message: string;
    reply: string;
    model: string;
    usage: { prompt: number; completion: number; total: number };
    session: Session;
    verdict: GuardVerdict;
    guardModel: string;
    priority: 'normal' | 'review';
    toolLogs?: ToolCallLog[];
  },
): void {
  const entry: InboxEntry = {
    id: params.id,
    received_at: new Date().toISOString(),
    from: params.from,
    ip: params.ip,
    message: params.message,
    reply: params.reply,
    model: params.model,
    tokens_used: params.usage,
    status: 'unread',
    session_id: params.session.id,
    guard: {
      classification: params.verdict.classification,
      violation_type: params.verdict.violation_type,
      cwe_codes: params.verdict.cwe_codes,
      reasoning: params.verdict.reasoning,
      model: params.guardModel,
    },
    priority: params.priority,
    tool_calls: params.toolLogs?.map((l) => ({
      name: l.name,
      ok: l.ok,
      bytes: l.bytes,
      result_count: l.result_count,
      duration_ms: l.duration_ms,
      ...(l.error ? { error: l.error } : {}),
      ...(l.truncated ? { truncated: true } : {}),
      ...(l.artifact ? { artifact: l.artifact } : {}),
    })),
  };
  try {
    writeInboxEntry(env, entry);
  } catch (err) {
    console.error('[public-agent] /talk inbox write failed:', err);
  }
}

// Runs the tool-call loop after the guard allows a message. Executes any
// knowledge tool calls the model requested, enforces per-request caps, and
// returns the final user-visible reply plus combined usage.
async function runToolLoop(
  env: Env,
  knowledge: KnowledgeManifest,
  baseMessages: ChatMessage[],
  replyCap: number,
): Promise<{
  reply: string;
  model: string;
  usage: { prompt: number; completion: number; total: number };
  toolLogs: ToolCallLog[];
}> {
  const messages: ChatMessage[] = baseMessages.slice();
  const toolLogs: ToolCallLog[] = [];
  let totalToolBytes = 0;
  let combinedUsage = { prompt: 0, completion: 0, total: 0 };
  let model = env.openRouterModel;
  let callBudget = KNOWLEDGE_MAX_TOOL_CALLS_PER_REQUEST;

  // Loop: ask the model, execute tool calls if any, re-ask. Bail when the
  // model returns a plain content message or we exhaust the call budget.
  while (true) {
    const raw: RawAssistantMessage = await openRouterRawCall(env, messages, {
      maxTokens: replyCap > 0 ? replyCap : undefined,
      tools: KNOWLEDGE_TOOL_DEFS,
      toolChoice: 'auto',
    });
    model = raw.model;
    combinedUsage = {
      prompt: combinedUsage.prompt + raw.usage.prompt,
      completion: combinedUsage.completion + raw.usage.completion,
      total: combinedUsage.total + raw.usage.total,
    };

    const toolCalls = raw.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { reply: raw.content, model, usage: combinedUsage, toolLogs };
    }

    // Add the assistant's tool-call turn to the conversation before
    // appending tool results, per OpenAI/OpenRouter protocol.
    messages.push({
      role: 'assistant',
      content: raw.content ?? '',
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      if (callBudget <= 0) {
        const msg = `tool_error: per-request cap of ${KNOWLEDGE_MAX_TOOL_CALLS_PER_REQUEST} tool calls reached`;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: wrapToolContent(msg) });
        toolLogs.push({ name: tc.function.name, args: {}, ok: false, bytes: msg.length, result_count: 0, duration_ms: 0, error: msg });
        continue;
      }
      callBudget -= 1;

      let execResult: { content: string; log: ToolCallLog };
      try {
        execResult = await withTimeout(
          () =>
            Promise.resolve(
              executeKnowledgeTool(knowledge, tc.function.name, tc.function.arguments, { dataDir: env.dataDir }),
            ),
          KNOWLEDGE_TOOL_TIMEOUT_MS,
        );
      } catch (err) {
        const msg = `tool_error: ${(err as Error).message}`;
        execResult = {
          content: msg,
          log: { name: tc.function.name, args: {}, ok: false, bytes: msg.length, result_count: 0, duration_ms: KNOWLEDGE_TOOL_TIMEOUT_MS, error: msg },
        };
      }

      // Enforce the 128KB total tool-output ceiling across the loop.
      const room = KNOWLEDGE_MAX_TOOL_OUTPUT_BYTES - totalToolBytes;
      let content = execResult.content;
      if (content.length > room) {
        content = content.slice(0, Math.max(0, room));
        execResult.log.error = (execResult.log.error ? execResult.log.error + '; ' : '') + 'truncated to 128KB cap';
      }
      totalToolBytes += content.length;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: wrapToolContent(content),
      });
      toolLogs.push(execResult.log);
    }
  }
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`tool execution exceeded ${ms}ms`));
    }, ms);
    fn().then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

export function talkRoutes(env: Env, knowledge: KnowledgeManifest): Hono {
  const app = new Hono();
  const sessions = createSessionStore(env);
  const talkSchema = buildTalkSchema(env);

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

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parsed = talkSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        {
          error: 'invalid_body',
          detail: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'body failed validation',
        },
        400,
      );
    }
    const body: TalkInput = parsed.data;

    const message = body.message.trim();
    if (!message) {
      return c.json({ error: 'missing_message', detail: 'body.message must be non-empty' }, 400);
    }

    const from = sanitizeFrom(body.from);
    const requestedSessionId = body.session_id ?? null;

    const { session } = sessions.getOrCreate(requestedSessionId);

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

    // Reserve tokens for the classifier call first. Fail closed if the
    // reservation bookkeeping itself fails (disk error etc.).
    const guardCap = Math.max(0, env.maxGuardTokens);
    if (guardCap > 0) {
      try {
        reserveTokens(env, guardCap);
      } catch (err) {
        console.error('[public-agent] /talk guard reserve failed:', err);
        return c.json({ error: 'budget_error', detail: 'Budget bookkeeping failed.' }, 503);
      }
    }

    const guardOutcome = await runGuardOrFail(env, message);
    if (!guardOutcome.ok) {
      if (guardCap > 0) {
        try { reconcileTokens(env, guardCap, 0); } catch (e) { console.error('[public-agent] guard budget reconcile failed:', e); }
      }
      return c.json(guardOutcome.response.body, guardOutcome.response.status as 503);
    }
    const verdict = guardOutcome.verdict;
    const guardUsage = guardOutcome.usage;
    const guardModel = guardOutcome.model;
    if (guardCap > 0) {
      try { reconcileTokens(env, guardCap, guardUsage.total); } catch (e) { console.error('[public-agent] guard budget reconcile failed:', e); }
    }

    sessions.append(session.id, 'user', message);
    const inboxId = makeInboxId();

    // Short-circuit on refuse/review: return a canned reply without running
    // the main LLM. The user turn is still counted toward the session cap
    // and the interaction is logged for review.
    if (verdict.classification === 'refuse' || verdict.classification === 'review') {
      const reply = verdict.classification === 'refuse' ? REFUSAL_REPLY : UNDER_REVIEW_REPLY;
      sessions.append(session.id, 'assistant', reply);
      writeGuardedInbox(env, {
        id: inboxId,
        ip,
        from,
        message,
        reply,
        model: guardModel,
        usage: guardUsage,
        session,
        verdict,
        guardModel,
        priority: verdict.classification === 'review' ? 'review' : 'normal',
      });
      return c.json({
        reply,
        model: guardModel,
        inbox_id: inboxId,
        tokens_used: guardUsage,
        session_id: session.id,
        guard: {
          classification: verdict.classification,
          violation_type: verdict.violation_type,
        },
      });
    }

    // Classifier said allow — run the main LLM with the KB tool loop.
    const outgoingMessages: ChatMessage[] = [mainSystemPrompt(env), ...session.messages];
    const postGuardBudget = isOverBudget(env);
    if (postGuardBudget.over) {
      return c.json(
        { error: 'budget_exceeded', used: postGuardBudget.used, limit: env.maxTokensPerDay, resets_at: postGuardBudget.resets_at },
        503,
      );
    }

    const cap = Number.isFinite(postGuardBudget.remaining)
      ? Math.min(env.maxReplyTokens, postGuardBudget.remaining)
      : env.maxReplyTokens;
    const reserved = Math.max(0, cap);
    if (reserved > 0) {
      try {
        reserveTokens(env, reserved);
      } catch (err) {
        console.error('[public-agent] /talk reply reserve failed:', err);
      }
    }

    let reply: string;
    let model: string;
    let usage: { prompt: number; completion: number; total: number };
    let toolLogs: ToolCallLog[] = [];
    try {
      const result = await runToolLoop(env, knowledge, outgoingMessages, cap);
      reply = result.reply;
      model = result.model;
      usage = result.usage;
      toolLogs = result.toolLogs;
    } catch (err) {
      if (reserved > 0) {
        try { reconcileTokens(env, reserved, 0); } catch (e) { console.error('[public-agent] reply budget reconcile (err) failed:', e); }
      }
      console.error('[public-agent] /talk openrouter error:', err);
      return c.json({ error: 'upstream_error', detail: (err as Error).message }, 502);
    }
    if (reserved > 0) {
      try { reconcileTokens(env, reserved, usage.total); } catch (e) { console.error('[public-agent] reply budget reconcile failed:', e); }
    }

    for (const log of toolLogs) {
      console.log(
        `[public-agent] /talk tool_call session=${session.id} name=${log.name} ok=${log.ok} ` +
          `result_count=${log.result_count} bytes=${log.bytes} duration_ms=${log.duration_ms}` +
          (log.error ? ` error="${log.error}"` : ''),
      );
    }

    sessions.append(session.id, 'assistant', reply);
    const combinedUsage = {
      prompt: guardUsage.prompt + usage.prompt,
      completion: guardUsage.completion + usage.completion,
      total: guardUsage.total + usage.total,
    };
    writeGuardedInbox(env, {
      id: inboxId,
      ip,
      from,
      message,
      reply,
      model,
      usage: combinedUsage,
      session,
      verdict,
      guardModel,
      priority: 'normal',
      toolLogs,
    });

    return c.json({
      reply,
      model,
      inbox_id: inboxId,
      tokens_used: combinedUsage,
      session_id: session.id,
      guard: {
        classification: verdict.classification,
        violation_type: verdict.violation_type,
      },
      tool_calls_used: toolLogs.length,
    });
  });

  return app;
}

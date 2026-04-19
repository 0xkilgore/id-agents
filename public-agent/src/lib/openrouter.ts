import type { Env } from '../env.js';
import { mainSystemPrompt } from './prompts.js';
import { retryFetch, HttpRetryError } from './retry.js';

export interface OpenRouterResult {
  reply: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CallOptions {
  model?: string;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
}

export interface RawAssistantMessage {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  model: string;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | null;
}

// Sentinel error for sanitized upstream failures. The status is preserved for
// callers that need to distinguish context-overflow (413) from other errors.
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly sanitizedReason: string,
  ) {
    super(`openrouter_upstream_error status=${status}`);
    this.name = 'UpstreamError';
  }
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

async function call(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions,
): Promise<RawAssistantMessage> {
  const model = opts.model ?? env.openRouterModel;
  const body: Record<string, unknown> = { model, messages };
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;

  const resp = await retryFetch(
    () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.upstreamDeadlineMs);
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.openRouterApiKey}`,
          'HTTP-Referer': 'https://github.com/idchain-world/id-agents',
          'X-Title': env.agentName,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },
    {
      label: `openrouter model=${model}`,
      maxRetryAfterMs: env.maxRetryAfterMs,
    },
  ).catch((err: unknown) => {
    if (err instanceof HttpRetryError) {
      // F-07: log full body server-side; do NOT include in thrown error.
      console.error(
        `[public-agent] openrouter upstream error status=${err.status} body=${err.body}`,
      );
      throw new UpstreamError(err.status, `http_${err.status}`);
    }
    throw err;
  });

  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;

  if (!content && (!tool_calls || tool_calls.length === 0)) {
    throw new Error('openrouter returned empty completion');
  }

  return {
    content,
    tool_calls,
    model: data.model ?? model,
    usage: {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
      total: data.usage?.total_tokens ?? 0,
    },
    finishReason: choice?.finish_reason ?? null,
  };
}

// Public chat: always prepends the main-LLM XML-sectioned system prompt.
// Supplied messages are appended after ours. Two system turns in the array
// stack (ours first), keeping the public-agent guardrails non-bypassable.
export async function openRouterChatMessages(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<OpenRouterResult> {
  const raw = await call(env, [mainSystemPrompt(env), ...messages], opts);
  return { reply: raw.content, model: raw.model, usage: raw.usage };
}

// Raw call for the tool-call loop + classifier: caller owns the full message
// list (system turn, tool turns, etc.) and gets the raw assistant message
// including tool_calls. No implicit system prompt is prepended.
export async function openRouterRawCall(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<RawAssistantMessage> {
  return call(env, messages, opts);
}

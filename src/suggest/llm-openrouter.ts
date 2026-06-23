// S2 — production LLM caller for suggest-next-step.
//
// A single in-process HTTP call to the OpenRouter chat-completions gateway
// (OpenAI-compatible), routed by DEFAULT to a Claude model per the standing
// open-source posture ("default to the latest Claude models"). OpenRouter is the
// only LLM key provisioned on the manager host (~/.id-agents/openrouter.env);
// there is no ANTHROPIC_API_KEY here, and adding the official @anthropic-ai/sdk
// would require an npm install that risks re-triggering the better-sqlite3 ABI
// rebuild trap. The caller is INJECTED into the service, so swapping this for the
// official Anthropic SDK later is a one-function change (set llmComplete on the
// route deps) with no service/test changes.

import { LlmUnavailableError, type LlmComplete, type LlmCompletion } from "./types.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Latest Claude model via OpenRouter (override with SUGGEST_NEXT_STEP_MODEL). */
export const DEFAULT_SUGGEST_MODEL = "anthropic/claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenRouterLlmOptions {
  env?: NodeJS.ProcessEnv;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Build an `LlmComplete` backed by OpenRouter. Throws `LlmUnavailableError` when
 * no API key is configured (the route maps that to a clean 503).
 */
export function createOpenRouterLlmComplete(opts: OpenRouterLlmOptions = {}): LlmComplete {
  const env = opts.env ?? process.env;
  const model = opts.model || env.SUGGEST_NEXT_STEP_MODEL || DEFAULT_SUGGEST_MODEL;
  const maxTokens = opts.maxTokens ?? (Number(env.SUGGEST_NEXT_STEP_MAX_TOKENS) || DEFAULT_MAX_TOKENS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function openRouterComplete(prompt: string): Promise<LlmCompletion> {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new LlmUnavailableError(
        "suggest-next-step requires OPENROUTER_API_KEY (set in the manager env / ~/.id-agents/openrouter.env)",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/id-agents",
          "X-Title": "id-agents suggest-next-step",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
          stream: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        model: data.model ?? model,
        provider: "openrouter",
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) throw new Error(`suggest-next-step LLM timed out after ${timeoutMs}ms`);
      throw new Error(`suggest-next-step LLM call failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

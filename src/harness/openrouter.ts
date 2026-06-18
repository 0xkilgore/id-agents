// SPDX-License-Identifier: MIT
/**
 * OpenRouter Harness
 *
 * Executes a prompt against the OpenRouter chat-completions API
 * (https://openrouter.ai/api/v1/chat/completions), an OpenAI-compatible
 * gateway that fronts many non-Anthropic / open-source models (e.g.
 * z-ai/glm-5.2, deepseek, llama). Unlike the CLI harnesses this makes a
 * single in-process HTTP request — no child process, no local CLI login.
 *
 * Auth: bearer OPENROUTER_API_KEY (from options.env or process.env).
 * Output: yields a `system`/init message then one `result` message carrying
 * the completion text plus provider/model/usage metadata. The `openrouter`
 * runtime resolves to the "other" provider lane for usage attribution.
 */

import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'z-ai/glm-5.2';
const DEFAULT_MAX_TOKENS = 1024;

export class OpenRouterHarness implements AgentHarness {
  readonly type: HarnessType = 'openrouter' as HarnessType;

  private controller: AbortController | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const model = options.model || DEFAULT_MODEL;
    const apiKey = options.env?.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
    const rawMaxTokens = options.env?.ID_OPENROUTER_MAX_TOKENS ?? process.env.ID_OPENROUTER_MAX_TOKENS;
    const maxTokens = rawMaxTokens !== undefined ? Number(rawMaxTokens) : DEFAULT_MAX_TOKENS;

    console.log(`[OpenRouter] Starting harness`);
    console.log(`[OpenRouter] Endpoint: ${OPENROUTER_CHAT_COMPLETIONS_URL}`);
    console.log(`[OpenRouter] Model: ${model}`);

    if (!apiKey) {
      yield {
        type: 'error',
        content: 'OpenRouter harness requires OPENROUTER_API_KEY (set in the agent env or process env)',
      };
      return;
    }

    this.cancelled = false;
    this.controller = new AbortController();
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => this.controller?.abort(), options.timeoutMs)
        : null;

    yield { type: 'system', subtype: 'init' };

    try {
      const res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        signal: this.controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Optional OpenRouter attribution headers.
          'HTTP-Referer': 'https://github.com/id-agents',
          'X-Title': 'id-agents',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
          stream: false,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        yield { type: 'error', content: `OpenRouter HTTP ${res.status}: ${errBody.slice(0, 500)}` };
        return;
      }

      const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage ?? {};
      console.log(
        `[OpenRouter] Completed — model=${data.model ?? model} ` +
          `prompt_tokens=${usage.prompt_tokens ?? '?'} completion_tokens=${usage.completion_tokens ?? '?'}`,
      );

      yield {
        type: 'result',
        result: text,
        provider: 'openrouter',
        model: data.model ?? model,
        usage: {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: this.cancelled ? 'Cancelled' : `OpenRouter request failed: ${msg}` };
    } finally {
      if (timer) clearTimeout(timer);
      this.controller = null;
    }
  }

  cancel(): boolean {
    if (this.controller) {
      this.cancelled = true;
      this.controller.abort();
      this.controller = null;
      return true;
    }
    return false;
  }
}

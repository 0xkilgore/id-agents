import type { Env } from '../env.js';

export interface OpenRouterResult {
  reply: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function openRouterChat(
  env: Env,
  userMessage: string,
  opts: { maxTokens?: number } = {},
): Promise<OpenRouterResult> {
  const body: Record<string, unknown> = {
    model: env.openRouterModel,
    messages: [
      {
        role: 'system',
        content:
          `You are ${env.agentName}, a lightweight public-facing assistant. ` +
          'Respond concisely. You cannot take actions outside of replying to this message. ' +
          'Do not claim access to the user\'s files, network, or other agents.',
      },
      { role: 'user', content: userMessage },
    ],
  };
  // Cap OpenRouter's completion so it can't overshoot the remaining daily
  // budget. Passing max_tokens <= 0 would be rejected by the API, so skip.
  if (opts.maxTokens && opts.maxTokens > 0) {
    body.max_tokens = opts.maxTokens;
  }

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openRouterApiKey}`,
      // Optional per OpenRouter docs; helps with their attribution dashboard.
      'HTTP-Referer': 'https://github.com/idchain-world/id-agents',
      'X-Title': env.agentName,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`openrouter http ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  const reply = data.choices?.[0]?.message?.content ?? '';
  if (!reply) {
    throw new Error('openrouter returned empty completion');
  }

  return {
    reply,
    model: data.model ?? env.openRouterModel,
    usage: {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
      total: data.usage?.total_tokens ?? 0,
    },
  };
}

import type { Env } from '../env.js';

export interface OpenRouterResult {
  reply: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function systemPrompt(env: Env): ChatMessage {
  return {
    role: 'system',
    content:
      `You are ${env.agentName}, a lightweight public-facing assistant. ` +
      'Respond concisely. You cannot take actions outside of replying to this message. ' +
      'Do not claim access to the user\'s files, network, or other agents.',
  };
}

// Always prepend our own system prompt. If the caller supplied messages
// that also start with a `system` turn, the caller's system is appended
// after ours — two system messages are accepted by OpenRouter and keeps
// the public-agent guardrails non-bypassable from the client.
function assembleMessages(env: Env, userMessages: ChatMessage[]): ChatMessage[] {
  return [systemPrompt(env), ...userMessages];
}

async function call(env: Env, messages: ChatMessage[], opts: { maxTokens?: number }): Promise<OpenRouterResult> {
  const body: Record<string, unknown> = {
    model: env.openRouterModel,
    messages,
  };
  if (opts.maxTokens && opts.maxTokens > 0) {
    body.max_tokens = opts.maxTokens;
  }

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openRouterApiKey}`,
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

export async function openRouterChatMessages(
  env: Env,
  messages: ChatMessage[],
  opts: { maxTokens?: number } = {},
): Promise<OpenRouterResult> {
  return call(env, assembleMessages(env, messages), opts);
}

import { z } from 'zod';
import type { Env } from '../env.js';
import { openRouterRawCall } from './openrouter.js';
import { guardSystemPrompt, guardUserMessage } from './prompts.js';

// Strict schema for classifier output. If the model returns anything that
// doesn't parse, the caller fails CLOSED (503) — we never fall back to the
// main LLM when the gate itself is unreliable.
export const GuardVerdictSchema = z
  .object({
    classification: z.enum(['allow', 'refuse', 'review']),
    violation_type: z.enum([
      'none',
      'prompt_injection',
      'system_prompt_extraction',
      'data_exfiltration',
      'jailbreak',
    ]),
    cwe_codes: z.array(z.string().max(32)).max(10).default([]),
    reasoning: z.string().max(500).default(''),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.classification === 'allow' && val.violation_type !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "classification 'allow' must have violation_type 'none'",
      });
    }
    if (val.classification !== 'allow' && val.violation_type === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "classification 'refuse' or 'review' requires a non-'none' violation_type",
      });
    }
  });

export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;

// OpenRouter JSON-object mode is the widest-supported response_format across
// providers. We enforce the schema post-hoc with Zod; if the model returns
// anything that doesn't parse, we fail closed.
const RESPONSE_FORMAT: Record<string, unknown> = { type: 'json_object' };

function tryParseVerdict(raw: string): GuardVerdict | null {
  const trimmed = raw.trim();
  // Some models wrap JSON in ```json ... ``` despite response_format. Strip
  // the fence if it's there, then parse.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  const result = GuardVerdictSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export interface GuardCallResult {
  verdict: GuardVerdict;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

// Runs the classifier. Throws on any error (network, non-2xx, empty reply,
// unparseable JSON, schema violation) — the caller must fail CLOSED.
export async function classifyMessage(env: Env, text: string): Promise<GuardCallResult> {
  const messages = [guardSystemPrompt(env), guardUserMessage(text)];
  const raw = await openRouterRawCall(env, messages, {
    model: env.guardModel,
    maxTokens: env.maxGuardTokens,
    responseFormat: RESPONSE_FORMAT,
    temperature: 0,
  });
  const verdict = tryParseVerdict(raw.content);
  if (!verdict) {
    throw new Error(`guard returned unparseable verdict: ${raw.content.slice(0, 200)}`);
  }
  return { verdict, usage: raw.usage, model: raw.model };
}

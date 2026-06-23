// S2 — suggest-next-step service.
//
// Pure prompt construction + a thin orchestration over an injected LLM caller.
// The route validates input and calls `suggestNextStep`; tests inject a fake
// `LlmComplete` and assert the prompt + the actor-attributed result.

import {
  LlmUnavailableError,
  type LlmComplete,
  type SuggestActor,
  type SuggestNextStepInput,
  type SuggestNextStepResult,
} from "./types.js";

/** Trim + bound a free-text field so the prompt stays tight. */
function clip(s: string | null | undefined, max: number): string {
  return (s ?? "").toString().trim().slice(0, max);
}

/**
 * Build the LLM prompt for one task. Pure + deterministic so it is unit-tested
 * directly. Asks for ONE concrete, actionable next step grounded in the task.
 */
export function buildSuggestPrompt(input: SuggestNextStepInput): string {
  const text = clip(input.task.text, 2000);
  const project = clip(input.task.project ?? input.project, 120);
  const owner = clip(input.task.owner, 120);
  const context = clip(input.context, 4000);

  const lines: string[] = [
    "You are an operations copilot helping an operator move work forward.",
    "Given ONE task, propose the single most useful NEXT STEP to advance it.",
    "",
    "Rules:",
    "- Output ONE concrete, actionable next step (1–3 sentences). No preamble, no lists, no headers.",
    "- Be specific to THIS task; do not restate the task or give generic advice.",
    "- If the task is already actionable, say exactly what to do first.",
    "",
    "Task:",
    `- text: ${text || "(empty)"}`,
  ];
  if (project) lines.push(`- project: ${project}`);
  if (owner) lines.push(`- owner: ${owner}`);
  if (context) {
    lines.push("", "Additional context:", context);
  }
  lines.push("", "Next step:");
  return lines.join("\n");
}

export interface SuggestDeps {
  llmComplete: LlmComplete;
  now?: () => Date;
}

/**
 * Generate an actor-attributed next-step suggestion. Throws
 * `LlmUnavailableError` (mapped to 503 by the route) when the LLM cannot run;
 * other LLM errors propagate (mapped to 502).
 */
export async function suggestNextStep(
  input: SuggestNextStepInput,
  deps: SuggestDeps,
): Promise<SuggestNextStepResult> {
  if (!input.task || clip(input.task.text, 1).length === 0) {
    throw new Error("task.text is required");
  }
  const now = (deps.now ?? (() => new Date()))();
  const prompt = buildSuggestPrompt(input);

  const completion = await deps.llmComplete(prompt);
  const suggestion = clip(completion.text, 4000);
  if (suggestion.length === 0) {
    throw new LlmUnavailableError("LLM returned an empty suggestion");
  }

  const actor: SuggestActor = {
    kind: "service",
    id: "suggest-next-step",
    label: "Suggest Next Step",
    model: completion.model,
    provider: completion.provider,
  };

  return {
    ok: true,
    suggestion,
    actor,
    model: completion.model,
    provider: completion.provider,
    generated_at: now.toISOString(),
    task_id: input.task.id ?? null,
    usage: completion.usage,
  };
}

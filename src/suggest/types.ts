// S2 — Manager "suggest next step" LLM route — shared types.
//
// Given a task (and optional project/context) the manager asks an LLM for ONE
// concrete next step and returns it actor-attributed (the response carries an
// actor_ref identifying which model/service produced the suggestion). The LLM
// call is injected (`LlmComplete`) so the service is unit-testable without
// network/keys, and the production caller is a one-function swap.

export interface SuggestTaskInput {
  /** The task text — what the work item says. Required. */
  text: string;
  project?: string | null;
  owner?: string | null;
  /** Optional stable id of the task (echoed back for the caller's wiring). */
  id?: string | null;
}

export interface SuggestNextStepInput {
  task: SuggestTaskInput;
  /** Optional project name when not on the task. */
  project?: string | null;
  /** Optional extra context (recent activity, constraints) to ground the suggestion. */
  context?: string | null;
}

/** Provenance of a generated suggestion — who produced it. */
export interface SuggestActor {
  kind: "service";
  id: "suggest-next-step";
  label: string;
  model: string;
  provider: string;
}

export interface SuggestNextStepResult {
  ok: true;
  /** The actor-attributed suggestion text. */
  suggestion: string;
  actor: SuggestActor;
  model: string;
  provider: string;
  generated_at: string;
  /** Echoed task id, when supplied. */
  task_id: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

/** A single LLM completion. Injected so the service is provider-agnostic. */
export type LlmComplete = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<LlmCompletion>;

export interface LlmCompletion {
  text: string;
  model: string;
  provider: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Raised by a production LLM caller when it cannot run (no key / transport / model). */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

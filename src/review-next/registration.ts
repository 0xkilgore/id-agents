import type { ReviewNextAction, ReviewNextRegistration } from "./types.js";

const REVIEW_NEXT_ACTIONS = new Set<ReviewNextAction>([
  "open", "acknowledge", "comment", "approve", "request_change", "route", "react",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the explicit, default-deny Review-next admission contract. */
export function reviewNextRegistration(value: unknown): ReviewNextRegistration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const requiredStrings = [
    "owner", "canonical_url", "effective_lifecycle", "source_as_of",
    "attention_state", "attention_reason", "admission_reason",
  ] as const;
  if (row.audience !== "operator" && row.audience !== "system") throw new Error("review_next.audience must be operator or system");
  if (row.environment !== "production" && row.environment !== "test") throw new Error("review_next.environment must be production or test");
  for (const key of requiredStrings) {
    if (!asString(row[key])) throw new Error(`review_next.${key} is required`);
  }
  if (typeof row.attention_priority !== "number" || !Number.isFinite(row.attention_priority)) {
    throw new Error("review_next.attention_priority must be a number");
  }
  if (!Array.isArray(row.permitted_actions)) throw new Error("review_next.permitted_actions must be an array");
  const permittedActions = row.permitted_actions.filter((action): action is ReviewNextAction =>
    typeof action === "string" && REVIEW_NEXT_ACTIONS.has(action as ReviewNextAction));
  if (permittedActions.length !== row.permitted_actions.length) throw new Error("review_next.permitted_actions contains an unsupported action");
  return {
    audience: row.audience,
    environment: row.environment,
    owner: String(row.owner),
    canonical_url: String(row.canonical_url),
    effective_lifecycle: String(row.effective_lifecycle),
    source_as_of: String(row.source_as_of),
    revised_at: asString(row.revised_at) ?? null,
    revalidated_at: asString(row.revalidated_at) ?? null,
    pinned_at: asString(row.pinned_at) ?? null,
    attention_state: String(row.attention_state),
    attention_reason: String(row.attention_reason),
    attention_priority: row.attention_priority,
    admission_reason: String(row.admission_reason),
    permitted_actions: permittedActions,
  };
}

import type { TaskRow } from "../db/types.js";
import { extractTaskScheduleFacts } from "../tasks-readmodel/bands.js";

export const CANONICAL_TASK_TERMINAL_REASON = "canonical_task_terminal";
export const REPLACEMENT_IMPLEMENTATION_COMMIT_REASON = "replacement_implementation_commit";

export function classifyCheckinRecurrenceSuppression(
  task: Pick<TaskRow, "title" | "description" | "status">,
): string | null {
  const facts = extractTaskScheduleFacts(task);
  if (facts.done || facts.archived) return CANONICAL_TASK_TERMINAL_REASON;

  const text = `${task.title}\n${task.description ?? ""}`;
  if (/\b(?:superseded|moot|cancelled|canceled)\b/i.test(text)) {
    return CANONICAL_TASK_TERMINAL_REASON;
  }
  if (hasReplacementImplementationCommitEvidence(text)) {
    return REPLACEMENT_IMPLEMENTATION_COMMIT_REASON;
  }
  return null;
}

function hasReplacementImplementationCommitEvidence(text: string): boolean {
  return /\breplacement implementation commit\b\s*:?\s*[0-9a-f]{7,40}\b/i.test(text)
    || /\bimplemented by commit\b\s*:?\s*[0-9a-f]{7,40}\b/i.test(text);
}

/**
 * Mechanical clarification: canonical checkout dirty before an isolated worktree build.
 * Fleet policy: always proceed via worktree — never pause the dispatch queue for this.
 */

export const DIRTY_WORKTREE_AUTO_ANSWER =
  "Proceed by creating a new isolated worktree from origin/main and leave canonical dirty state untouched. Do not wait for checkout cleanup.";

const QUESTION_MARKERS = [
  /uncommitted work/i,
  /dirty.*checkout/i,
  /untracked.*before (this )?build/i,
  /canonical.*checkout.*uncommitted/i,
  /isolated worktree/i,
];

export function isDirtyWorktreeClarification(
  question: string,
  context: unknown,
): boolean {
  if (!question.trim()) return false;
  if (!QUESTION_MARKERS.some((pattern) => pattern.test(question))) return false;
  const blocking = extractBlockingReasons(context);
  if (blocking.length === 0) return true;
  return blocking.some((reason) =>
    /uncommitted|untracked|dirty|worktree|\.ops-.*lock|test-results/i.test(reason),
  );
}

function extractBlockingReasons(context: unknown): string[] {
  if (!context || typeof context !== "object") return [];
  const raw = (context as { blocking_reasons?: unknown }).blocking_reasons;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item));
}

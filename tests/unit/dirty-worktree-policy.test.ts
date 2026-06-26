import { test, expect } from "vitest";
import {
  DIRTY_WORKTREE_AUTO_ANSWER,
  isDirtyWorktreeClarification,
} from "../../src/dispatch-scheduler/dirty-worktree-policy.js";

test("detects dirty canonical checkout clarifications", () => {
  expect(
    isDirtyWorktreeClarification(
      "Canonical kapelle-site checkout has uncommitted work before this build; should I use an isolated worktree?",
      {
        blocking_reasons: [
          "Canonical checkout is dirty before my work",
          "Untracked: test-results/",
        ],
      },
    ),
  ).toBe(true);
});

test("ignores unrelated operator decisions", () => {
  expect(
    isDirtyWorktreeClarification(
      "T-OSS.6 is HELD-ON-CHRIS — should I proceed or hold?",
      { blocking_reasons: ["HC-5 is an explicit Chris hold"] },
    ),
  ).toBe(false);
});

test("auto answer tells builders to use isolated worktree", () => {
  expect(DIRTY_WORKTREE_AUTO_ANSWER).toMatch(/isolated worktree/i);
  expect(DIRTY_WORKTREE_AUTO_ANSWER).toMatch(/origin\/main/i);
});

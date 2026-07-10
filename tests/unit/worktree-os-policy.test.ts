import { describe, expect, it } from "vitest";

import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  countBranchLedgerExceptions,
  ingestBranchLedgerScannerJson,
  migrateBranchLedgerTables,
} from "../../src/branch-ledger/storage.js";
import {
  CLEAN_DEPLOY_CHECKOUT_REPAIR_DEPENDENCY,
  classifyWorktreeScannerPolicy,
  evaluateCodeDispatchAdmission,
  validateCloseoutPromotionPolicy,
} from "../../src/workspaces/policy.js";

describe("worktree OS policy", () => {
  it("rejects code dispatches missing required admission metadata before agent start", () => {
    const decision = evaluateCodeDispatchAdmission({
      repo: "/repo/id-agents",
      source_branch: "feat/kg09",
      owner: "roger",
      promotion_mode: "promote",
    });

    expect(decision.ok).toBe(false);
    expect(decision.action).toBe("reject");
    expect(decision.code).toBe("missing_metadata");
    expect(decision.missing_metadata).toEqual(["worktree", "base", "remote", "smoke"]);
    expect(decision.quarantine).toMatchObject({
      action_class: "reject_before_start",
      class_code: "missing_metadata",
      owner_lane: "roger",
    });
  });

  it("turns dirty worktrees into owner-routed quarantine records", () => {
    const record = classifyWorktreeScannerPolicy({
      repo: "/repo/id-agents",
      branch: "feat/dirty",
      worktree_path: "/repo/id-agents/.worktrees/dirty",
      owner: "hopper",
      dirty_tracked_count: 2,
      dirty_untracked_count: 1,
      ahead: 0,
      behind: 0,
    });

    expect(record).toMatchObject({
      class_code: "dirty_worktree",
      action_class: "owner_routed_quarantine",
      owner_lane: "hopper",
      dedupe_key: "/repo/id-agents:feat/dirty:dirty_worktree",
    });
    expect(record?.evidence).toContain("dirty_count:3");
  });

  it("accepts non-git operational closeout only with explicit promotion_exempt reason", () => {
    expect(validateCloseoutPromotionPolicy({
      promotion_mode: "promotion_exempt",
      promotion_exempt_reason: "non-git operational report; no code to promote",
    })).toMatchObject({
      ok: true,
      code: "promotion_exempt",
    });

    expect(validateCloseoutPromotionPolicy({ promotion_mode: "promotion_exempt" })).toMatchObject({
      ok: false,
      code: "missing_promotion_exempt_reason",
    });
  });

  it("classifies ahead+behind divergence as needs-fresh-branch", () => {
    const record = classifyWorktreeScannerPolicy({
      repo: "/repo/id-agents",
      branch: "feat/diverged",
      worktree: "/repo/id-agents/.worktrees/diverged",
      owner_agent: "roger",
      ahead: 2,
      behind: 3,
    });

    expect(record).toMatchObject({
      class_code: "ahead_behind_divergence",
      action_class: "needs_fresh_branch",
      owner_lane: "roger",
    });
    expect(record?.recommended_action).toContain("fresh branch");
  });

  it("classifies behind-only branches as stale-base fresh-branch work", () => {
    const record = classifyWorktreeScannerPolicy({
      repo: "/repo/id-agents",
      branch: "async-first-dispatch-path",
      worktree: "/repo/id-agents/.worktrees/async-first-dispatch-path",
      owner_agent: "substrate-orch-codex",
      ahead: 0,
      behind: 25,
    });

    expect(record).toMatchObject({
      class_code: "stale_base",
      action_class: "needs_fresh_branch",
      owner_lane: "substrate-orch-codex",
      recommended_action: "create a fresh branch off origin/main and reapply only the scoped work",
    });
    expect(record?.evidence).toEqual(expect.arrayContaining(["ahead:0", "behind:25", "stale_base_threshold:20"]));
  });

  it("requires closeout promotion evidence for promote mode", () => {
    expect(validateCloseoutPromotionPolicy({ promotion_mode: "promote", promotion: null })).toMatchObject({
      ok: false,
      code: "missing_promotion_evidence",
    });

    expect(validateCloseoutPromotionPolicy({
      promotion_mode: "promote",
      promotion: {
        required: true,
        completed: true,
        repos: [{
          path: "/repo/id-agents",
          base: "main",
          source_branch: "feat/kg09",
          strategy: "fast_forward",
          promoted_sha: "abc123",
          remote_main_sha: "abc123",
          pushed: true,
          verified: true,
        }],
      },
    })).toMatchObject({
      ok: true,
      code: "promotion_evidence_present",
    });
  });

  it("surfaces the clean deploy checkout repair as an external dependency", () => {
    expect(CLEAN_DEPLOY_CHECKOUT_REPAIR_DEPENDENCY).toMatchObject({
      dispatch_id: "phid:disp-be115010513e4105",
      owner: "cto",
      state: "external_active_dependency",
    });
  });

  it("exposes actionable exception counts for Console/Fleet consumers", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateBranchLedgerTables(adapter);
      await ingestBranchLedgerScannerJson(adapter, {
        items: [
          {
            repo: "/repo/id-agents",
            branch: "feat/dirty",
            class_code: "dirty_worktree",
            action_class: "owner_routed_quarantine",
            owner_lane: "roger",
          },
          {
            repo: "/repo/id-agents",
            branch: "feat/diverged",
            class_code: "ahead_behind_divergence",
            action_class: "needs_fresh_branch",
            owner_lane: "roger",
            ahead: 1,
            behind: 2,
          },
        ],
      });

      expect(await countBranchLedgerExceptions(adapter)).toMatchObject({
        total: 2,
        owner_routed_quarantine: 1,
        needs_fresh_branch: 1,
        by_class_code: {
          dirty_worktree: 1,
          ahead_behind_divergence: 1,
        },
        by_owner_lane: {
          roger: 2,
        },
      });
    } finally {
      await adapter.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { buildWorktreeHygieneReadModel, type PromotionEvidence } from "../../src/worktree-hygiene/read-model.js";
import type { DirtyRootRecord } from "../../src/workspaces/monitor.js";
import type { BranchLedgerRow } from "../../src/branch-ledger/types.js";

describe("worktree hygiene read model", () => {
  it("projects protected roots, release state, UI awaiting release, incidents, and next action deterministically", () => {
    const roots: DirtyRootRecord[] = [
      root({
        repo_name: "kapelle-site",
        root: "/repo/kapelle-site",
        branch: "main",
        intended_branch: "main",
        head_sha: "old-running",
        origin_main_sha: "new-promoted",
      }),
      root({
        repo_name: "id-agents",
        root: "/repo/id-agents",
        branch: "main",
        intended_branch: "main",
        head_sha: "new-promoted",
        origin_main_sha: "new-promoted",
      }),
    ];
    const promotions: PromotionEvidence[] = [{
      dispatch_id: "phid:disp-ui",
      query_id: "query-ui",
      agent: "substrate-api-codex",
      completed_at: "2026-07-12T13:00:00.000Z",
      repo: "/repo/kapelle-site",
      branch: "ui-release",
      base: "main",
      promoted_sha: "new-promoted",
      remote_main_sha: "new-promoted",
      completed: true,
      pushed: true,
      verified: true,
    }];

    const model = buildWorktreeHygieneReadModel({
      generated_at: "2026-07-12T14:00:00.000Z",
      protected_roots: roots,
      branch_ledger_rows: [ledger({ dedupe_key: "id-agents:old:merged_but_present", class_code: "merged_but_present", action_class: "safe_auto_action" })],
      promotions,
      build: {
        build_sha: "old-running",
        build_time: null,
        source_branch_sha: "new-promoted",
        source_branch_name: "main",
        local_main_sha: "new-promoted",
        origin_main_sha: "new-promoted",
        behind_origin: true,
        freshness: {
          classification: "server_not_rebuilt",
          running_manager_build_sha: "old-running",
          source_branch_sha: "new-promoted",
          source_branch_name: "main",
          promoted_main_sha: "new-promoted",
          behind_promoted_main: true,
          source_differs_from_promoted_main: false,
          message: "rebuild required",
        },
        source: "build_stamp",
      },
      origin_main_commits_today: [{ sha: "new-promoted", subject: "Ship UI", repo: "kapelle-site", committed_at: "2026-07-12T13:00:00.000Z" }],
    });

    expect(model.schema_version).toBe("worktree-hygiene.v1");
    expect(model.source.freshness).toBe("live");
    expect(model.protected_repos).toHaveLength(2);
    expect(model.commit_movement.origin_main_today_count).toBe(1);
    expect(model.release_state).toMatchObject({
      promoted_origin_sha: "new-promoted",
      deployed_running_sha: "old-running",
      promoted_but_not_deployed_count: 1,
      state: "promoted_but_not_deployed",
    });
    expect(model.accepted_ui_awaiting_release.count).toBe(1);
    expect(model.accepted_ui_awaiting_release.derivation).toBe("promotion_or_branch_evidence_only");
    expect(model.next_action).toBe("rebuild");
  });

  it("prioritizes dirty inspection and does not duplicate incidents by dedupe key", () => {
    const dirty = root({
      repo_name: "id-agents",
      root: "/repo/id-agents",
      branch: "feature/x",
      intended_branch: "main",
      dirty_count: 2,
      dirty_tracked_count: 1,
      dirty_untracked_count: 1,
      off_canonical_branch: true,
      severity: "critical",
      status_short: "## feature/x\n M src/a.ts\n?? scratch.ts",
    });
    const model = buildWorktreeHygieneReadModel({
      generated_at: "2026-07-12T14:00:00.000Z",
      protected_roots: [dirty],
      branch_ledger_rows: [
        ledger({ dedupe_key: "same", class_code: "stale_feature_branch", action_class: "needs_owner" }),
        ledger({ dedupe_key: "same", class_code: "stale_feature_branch", action_class: "needs_owner" }),
      ],
      build: null,
    });

    expect(model.worktree_summary.dirty).toBe(1);
    expect(model.next_action).toBe("inspect_dirty");
    expect(model.next_action_reason).toMatch(/dirty/);
    expect(model.incidents.filter((i) => i.dedupe_key === "same")).toHaveLength(1);
  });
});

function root(overrides: Partial<DirtyRootRecord>): DirtyRootRecord {
  return {
    root: "/repo/default",
    repo_name: "repo",
    branch: "main",
    intended_branch: "main",
    head_sha: "head",
    origin_main_sha: "head",
    off_canonical_branch: false,
    remote: "origin",
    base: "main",
    ahead: 0,
    behind: 0,
    dirty_count: 0,
    dirty_tracked_count: 0,
    dirty_untracked_count: 0,
    status_short: "",
    last_lease_id: null,
    last_dispatch_id: null,
    severity: "info",
    observed_at: "2026-07-12T14:00:00.000Z",
    ...overrides,
  };
}

function ledger(overrides: Partial<BranchLedgerRow>): BranchLedgerRow {
  return {
    repo: "id-agents",
    branch: "feature/x",
    head_sha: "abc",
    upstream: "origin/main",
    base: "main",
    remote: "origin",
    ahead: 0,
    behind: 0,
    dirty_tracked_count: 0,
    dirty_untracked_count: 0,
    worktree_path: null,
    is_primary_checkout: false,
    last_commit_at: null,
    last_seen_at: "2026-07-12T14:00:00.000Z",
    linked_dispatch_id: null,
    linked_task_name: null,
    linked_rd: null,
    owner_agent: null,
    owner_lane: null,
    class_code: "unknown_branch_owner",
    action_class: "needs_owner",
    recommended_action: null,
    dedupe_key: "id-agents:feature/x:unknown_branch_owner",
    last_hygiene_run_id: null,
    last_promotion_failure_id: null,
    console_url: null,
    evidence_json: "[]",
    scanner_payload_json: "{}",
    created_at: "2026-07-12T14:00:00.000Z",
    updated_at: "2026-07-12T14:00:00.000Z",
    ...overrides,
  };
}

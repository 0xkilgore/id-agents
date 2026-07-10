// T-OSS.2 — unit coverage: registry resolution, lease path/id generation,
// dirty-root admission block, branch-conflict block, closeout status comparison,
// promotion payload validation, and monitor severity.

import { describe, it, expect } from "vitest";
import {
  RepoRegistry,
  isWithin,
  normalizeRoot,
} from "../../src/workspaces/repo-registry.js";
import {
  decideAdmission,
  leaseWorktreePath,
  mintLeaseId,
  branchSlug,
  dispatchShort,
} from "../../src/workspaces/allocator.js";
import {
  validateWorkspaceCloseout,
  validatePromotionLeaseFields,
} from "../../src/workspaces/closeout.js";
import { classifySeverity } from "../../src/workspaces/monitor.js";
import type { ProtectedRootEntry } from "../../src/workspaces/repo-registry.js";

const idAgents = "/Users/kilgore/Dropbox/Code/cane/id-agents";

describe("RepoRegistry", () => {
  const reg = new RepoRegistry();

  it("resolves a repo path to its protected root", () => {
    expect(reg.resolve(idAgents)?.repo_name).toBe("id-agents");
    expect(reg.resolve(`${idAgents}/src/workspaces`)?.repo_name).toBe("id-agents");
  });

  it("returns null for an unregistered path", () => {
    expect(reg.resolve("/tmp/some/random/repo")).toBeNull();
  });

  it("prefers the most specific (longest) protected root", () => {
    const nested: ProtectedRootEntry[] = [
      { root: "/a", repo_name: "outer", role: "", intended_canonical_branch: "main", dirty_severity: "warning", block_builds_without_lease: true },
      { root: "/a/b", repo_name: "inner", role: "", intended_canonical_branch: "main", dirty_severity: "critical", block_builds_without_lease: true },
    ];
    const r = new RepoRegistry(nested);
    expect(r.resolve("/a/b/c")?.repo_name).toBe("inner");
    expect(r.resolve("/a/x")?.repo_name).toBe("outer");
  });

  it("isProtectedRoot is exact-match only", () => {
    expect(reg.isProtectedRoot(idAgents)).toBe(true);
    expect(reg.isProtectedRoot(`${idAgents}/src`)).toBe(false);
  });

  it("registers the clean id-agents deploy checkout as the most-specific protected root", () => {
    const reg = new RepoRegistry();
    const deploy = "/Users/kilgore/Dropbox/Code/cane/id-agents-deploy-main";
    expect(reg.isProtectedRoot(deploy)).toBe(true);
    expect(reg.resolve(`${deploy}/scripts/start-id-agents-manager.sh`)).toMatchObject({
      repo_name: "id-agents-deploy-main",
      dirty_severity: "critical",
      block_builds_without_lease: true,
    });
  });

  it("isWithin handles trailing slashes and exact roots", () => {
    expect(isWithin("/a/b/", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(normalizeRoot("/a/b/")).toBe("/a/b");
  });
});

describe("lease path + id generation", () => {
  it("places the worktree under <protected_root>/.worktrees/", () => {
    const p = leaseWorktreePath(idAgents, "roger", "phid:disp-61d72001b7f5d42c", "feat/x");
    expect(p).toBe(`${idAgents}/.worktrees/roger-61d72001-feat-x`);
    expect(p.startsWith(`${idAgents}/.worktrees/`)).toBe(true);
  });

  it("never returns the protected root itself", () => {
    const p = leaseWorktreePath(idAgents, "roger", "phid:disp-abc", "main");
    expect(normalizeRoot(p)).not.toBe(normalizeRoot(idAgents));
  });

  it("slugifies branch names safely", () => {
    expect(branchSlug("feat/x")).toBe("feat-x");
    expect(branchSlug("fix/ABI-#42!")).toBe("fix-ABI-42");
    expect(dispatchShort("phid:disp-61d72001b7f5d42c")).toBe("61d72001");
    expect(mintLeaseId("phid:disp-61d72001b7f5d42c", "roger", "feat/x")).toBe("wsl_61d72001_roger_feat-x");
  });
});

describe("decideAdmission", () => {
  it("admits a clean protected root with no branch conflict", () => {
    expect(decideAdmission({ protected_root_status: "" }).ok).toBe(true);
  });

  it("blocks a dirty protected root with exact status", () => {
    const d = decideAdmission({
      protected_root_status: " M src/agent-manager-db.ts",
      protected_root_status_short: " M src/agent-manager-db.ts",
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("blocked_dirty_protected_root");
    expect(d.status_short).toContain("src/agent-manager-db.ts");
  });

  it("allows a dirty root only with workspace_policy=reconcile_dirty_root", () => {
    const d = decideAdmission({
      protected_root_status: " M x",
      workspace_policy: "reconcile_dirty_root",
    });
    expect(d.ok).toBe(true);
  });

  it("blocks when the branch is checked out in another worktree (different lease)", () => {
    const d = decideAdmission({
      protected_root_status: "",
      branch_conflict: { worktree_path: "/repo/.worktrees/other", lease_id: "wsl_other" },
      requested_lease_id: "wsl_me",
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("branch_conflict");
    expect(d.conflict_worktree).toBe("/repo/.worktrees/other");
  });

  it("blocks stale-base branches before admission with fresh-branch remediation", () => {
    const d = decideAdmission({
      protected_root_status: "",
      stale_base: {
        branch: "async-first-dispatch-path",
        base_ref: "origin/main",
        behind: 25,
        threshold: 20,
      },
    });

    expect(d.ok).toBe(false);
    expect(d.code).toBe("stale_base");
    expect(d.reason).toContain("stale-base");
    expect(d.reason).toContain("create a fresh branch off origin/main");
  });

  it("reuses a worktree when the existing lease id matches", () => {
    const d = decideAdmission({
      protected_root_status: "",
      branch_conflict: { worktree_path: "/repo/.worktrees/me", lease_id: "wsl_me" },
      requested_lease_id: "wsl_me",
    });
    expect(d.ok).toBe(true);
  });
});

describe("validateWorkspaceCloseout", () => {
  const lease = { lease_id: "wsl_1", worktree_path: "/repo/.worktrees/wt", protected_root: "/repo" };
  const clean = {
    lease_id: "wsl_1",
    worktree_path: "/repo/.worktrees/wt",
    protected_root: "/repo",
    protected_root_status_before: "",
    protected_root_status_after: "",
    worktree_status_after: "",
    cleanup_action: "kept_for_review" as const,
  };

  it("passes when the protected root is unchanged and worktree clean", () => {
    expect(validateWorkspaceCloseout(lease, clean, { dispatchSucceeded: true }).ok).toBe(true);
  });

  it("fails with protected_root_dirty_after + exact file list when the root was mutated", () => {
    const r = validateWorkspaceCloseout(
      lease,
      { ...clean, protected_root_status_after: " M src/agent-manager-db.ts" },
      { dispatchSucceeded: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("protected_root_dirty_after");
    expect(r.protected_root_diff?.some((l) => l.includes("src/agent-manager-db.ts"))).toBe(true);
  });

  it("ignores pre-existing protected-root dirt (only NEW dirt fails)", () => {
    const r = validateWorkspaceCloseout(
      lease,
      { ...clean, protected_root_status_before: " M pre.ts", protected_root_status_after: " M pre.ts" },
      { dispatchSucceeded: true },
    );
    expect(r.ok).toBe(true);
  });

  it("fails on lease/worktree mismatch", () => {
    expect(validateWorkspaceCloseout(lease, { ...clean, lease_id: "wsl_x" }, { dispatchSucceeded: true }).code).toBe(
      "lease_mismatch",
    );
    expect(
      validateWorkspaceCloseout(lease, { ...clean, worktree_path: "/repo/.worktrees/elsewhere" }, { dispatchSucceeded: true })
        .code,
    ).toBe("worktree_mismatch");
  });

  it("allows a dirty worktree only for a failed/blocked dispatch", () => {
    const dirtyWt = { ...clean, worktree_status_after: " M wip.ts" };
    expect(validateWorkspaceCloseout(lease, dirtyWt, { dispatchSucceeded: true }).code).toBe("dirty_worktree_on_success");
    expect(validateWorkspaceCloseout(lease, dirtyWt, { dispatchSucceeded: false }).ok).toBe(true);
  });
});

describe("validatePromotionLeaseFields", () => {
  const lease = { lease_id: "wsl_1", worktree_path: "/repo/.worktrees/wt" };
  const baseRepo = {
    path: "/repo",
    base: "main",
    source_branch: "feat-x",
    strategy: "fast_forward" as const,
    promoted_sha: "abc",
    remote_main_sha: "abc",
    pushed: true,
    verified: true,
  };

  it("passes when the promotion repo echoes the lease", () => {
    const r = validatePromotionLeaseFields(
      { ...baseRepo, workspace_lease_id: "wsl_1", worktree_path: "/repo/.worktrees/wt", protected_root_status_after: "" },
      lease,
    );
    expect(r.ok).toBe(true);
  });

  it("fails when the lease id is missing or wrong", () => {
    expect(validatePromotionLeaseFields(baseRepo, lease).ok).toBe(false);
    expect(validatePromotionLeaseFields({ ...baseRepo, workspace_lease_id: "wsl_other" }, lease).ok).toBe(false);
  });

  it("fails when promotion reports a dirty protected root", () => {
    const r = validatePromotionLeaseFields(
      { ...baseRepo, workspace_lease_id: "wsl_1", protected_root_status_after: " M leak.ts" },
      lease,
    );
    expect(r.ok).toBe(false);
  });
});

describe("classifySeverity", () => {
  const deploy: ProtectedRootEntry = {
    root: "/repo", repo_name: "id-agents", role: "deploy", intended_canonical_branch: "main",
    dirty_severity: "critical", block_builds_without_lease: true,
  };
  const planning: ProtectedRootEntry = { ...deploy, repo_name: "agent-platform", dirty_severity: "warning" };

  it("critical when a deploy/core root is dirty", () => {
    expect(classifySeverity({ entry: deploy, dirty: true, offCanonicalBranch: false, ahead: 0, behind: 0 })).toBe("critical");
  });
  it("warning when a non-deploy root is dirty", () => {
    expect(classifySeverity({ entry: planning, dirty: true, offCanonicalBranch: false, ahead: 0, behind: 0 })).toBe("warning");
  });
  it("critical when off the intended canonical branch (even if clean)", () => {
    expect(classifySeverity({ entry: deploy, dirty: false, offCanonicalBranch: true, ahead: 0, behind: 0 })).toBe("critical");
  });
  it("info when clean but ahead/behind drift exists", () => {
    expect(classifySeverity({ entry: deploy, dirty: false, offCanonicalBranch: false, ahead: 3, behind: 1 })).toBe("info");
  });
});

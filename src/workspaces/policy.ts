import type { PromotionAgentDone } from "../dispatch-scheduler/types.js";

export const WORKTREE_OS_POLICY_VERSION = "worktree-os-policy.v1";

export const CLEAN_DEPLOY_CHECKOUT_REPAIR_DEPENDENCY = {
  dispatch_id: "phid:disp-be115010513e4105",
  owner: "cto",
  repo_name: "id-agents-deploy-main",
  state: "external_active_dependency",
  required_repair: "restore missing clean deploy checkout before treating deploy-root health as green",
} as const;

export type AdmissionPolicyAction = "admit" | "reject" | "quarantine";
export type PromotionMode = "promote" | "promotion_exempt" | "manual_lab";
export type WorktreeQuarantineClass =
  | "missing_metadata"
  | "dirty_worktree"
  | "ahead_behind_divergence"
  | "missing_git"
  | "unknown_owner";

export interface CodeDispatchAdmissionInput {
  repo?: string | null;
  source_branch?: string | null;
  branch?: string | null;
  worktree?: string | null;
  worktree_path?: string | null;
  base?: string | null;
  remote?: string | null;
  owner?: string | null;
  to_agent?: string | null;
  promotion_mode?: string | null;
  smoke?: string | string[] | null;
}

export interface AdmissionPolicyDecision {
  ok: boolean;
  action: AdmissionPolicyAction;
  code: "admitted" | WorktreeQuarantineClass;
  reason: string;
  missing_metadata: string[];
  quarantine?: WorktreeQuarantineRecord;
}

export interface WorktreeScannerPolicyInput {
  repo: string;
  branch?: string | null;
  source_branch?: string | null;
  worktree_path?: string | null;
  worktree?: string | null;
  owner?: string | null;
  owner_agent?: string | null;
  dirty_tracked_count?: number | null;
  dirty_untracked_count?: number | null;
  ahead?: number | null;
  behind?: number | null;
  is_git?: boolean | null;
  git_error?: string | null;
  evidence?: string[] | null;
}

export interface WorktreeQuarantineRecord {
  policy_version: typeof WORKTREE_OS_POLICY_VERSION;
  class_code: WorktreeQuarantineClass;
  action_class: "reject_before_start" | "owner_routed_quarantine" | "needs_fresh_branch";
  repo: string;
  branch: string;
  worktree_path: string | null;
  owner_agent: string | null;
  owner_lane: string;
  dedupe_key: string;
  recommended_action: string;
  evidence: string[];
}

export interface CloseoutPolicyInput {
  promotion_mode?: string | null;
  promotion_exempt_reason?: string | null;
  manual_lab_reason?: string | null;
  promotion?: PromotionAgentDone | null;
}

export type CloseoutPolicyDecision =
  | { ok: true; code: "promotion_evidence_present" | "promotion_exempt" | "manual_lab" | "not_build_closeout"; reason: string }
  | { ok: false; code: "missing_promotion_evidence" | "missing_promotion_exempt_reason" | "missing_manual_lab_reason"; reason: string };

const REQUIRED_ADMISSION_METADATA = [
  "repo",
  "source_branch",
  "worktree",
  "base",
  "remote",
  "owner",
  "promotion_mode",
  "smoke",
] as const;

export function evaluateCodeDispatchAdmission(input: CodeDispatchAdmissionInput): AdmissionPolicyDecision {
  const missing = REQUIRED_ADMISSION_METADATA.filter((field) => !hasMetadata(input, field));
  if (missing.length === 0) {
    return {
      ok: true,
      action: "admit",
      code: "admitted",
      reason: "code dispatch carries required worktree admission metadata",
      missing_metadata: [],
    };
  }

  const repo = present(input.repo) ?? "unknown-repo";
  const branch = present(input.source_branch) ?? present(input.branch) ?? "unknown-branch";
  const worktree = present(input.worktree) ?? present(input.worktree_path);
  const owner = present(input.owner) ?? present(input.to_agent);
  const quarantine = buildQuarantineRecord({
    class_code: "missing_metadata",
    action_class: "reject_before_start",
    repo,
    branch,
    worktree_path: worktree,
    owner_agent: owner,
    recommended_action: `add required dispatch metadata before agent start: ${missing.join(", ")}`,
    evidence: missing.map((field) => `missing:${field}`),
  });

  return {
    ok: false,
    action: "reject",
    code: "missing_metadata",
    reason: quarantine.recommended_action,
    missing_metadata: missing,
    quarantine,
  };
}

export function classifyWorktreeScannerPolicy(input: WorktreeScannerPolicyInput): WorktreeQuarantineRecord | null {
  const repo = input.repo;
  const branch = present(input.source_branch) ?? present(input.branch) ?? "unknown-branch";
  const worktree = present(input.worktree_path) ?? present(input.worktree);
  const owner = present(input.owner_agent) ?? present(input.owner);
  const dirtyCount = Math.max(0, Number(input.dirty_tracked_count ?? 0)) + Math.max(0, Number(input.dirty_untracked_count ?? 0));
  const ahead = Math.max(0, Number(input.ahead ?? 0));
  const behind = Math.max(0, Number(input.behind ?? 0));

  if (input.is_git === false || present(input.git_error)) {
    return buildQuarantineRecord({
      class_code: "missing_git",
      action_class: "owner_routed_quarantine",
      repo,
      branch,
      worktree_path: worktree,
      owner_agent: owner,
      recommended_action: "route to owner to restore or remove the non-git operational worktree",
      evidence: [...(input.evidence ?? []), input.git_error ? `git_error:${input.git_error}` : "missing:.git"],
    });
  }

  if (!owner) {
    return buildQuarantineRecord({
      class_code: "unknown_owner",
      action_class: "owner_routed_quarantine",
      repo,
      branch,
      worktree_path: worktree,
      owner_agent: null,
      recommended_action: "assign an owner before this worktree can admit code dispatches",
      evidence: [...(input.evidence ?? []), "missing:owner"],
    });
  }

  if (ahead > 0 && behind > 0) {
    return buildQuarantineRecord({
      class_code: "ahead_behind_divergence",
      action_class: "needs_fresh_branch",
      repo,
      branch,
      worktree_path: worktree,
      owner_agent: owner,
      recommended_action: "create a fresh branch from base and cherry-pick scoped commits; do not promote the divergent branch",
      evidence: [...(input.evidence ?? []), `ahead:${ahead}`, `behind:${behind}`],
    });
  }

  if (dirtyCount > 0) {
    return buildQuarantineRecord({
      class_code: "dirty_worktree",
      action_class: "owner_routed_quarantine",
      repo,
      branch,
      worktree_path: worktree,
      owner_agent: owner,
      recommended_action: "route dirty worktree to owner for commit, stash, or quarantine before new admission",
      evidence: [...(input.evidence ?? []), `dirty_count:${dirtyCount}`],
    });
  }

  return null;
}

export function validateCloseoutPromotionPolicy(input: CloseoutPolicyInput): CloseoutPolicyDecision {
  const mode = normalizePromotionMode(input.promotion_mode);
  if (!mode) return { ok: true, code: "not_build_closeout", reason: "no build promotion mode declared" };

  if (mode === "promotion_exempt") {
    const reason = present(input.promotion_exempt_reason);
    return reason
      ? { ok: true, code: "promotion_exempt", reason }
      : {
          ok: false,
          code: "missing_promotion_exempt_reason",
          reason: "promotion_exempt closeout requires an explicit exemption reason",
        };
  }

  if (mode === "manual_lab") {
    const reason = present(input.manual_lab_reason);
    return reason
      ? { ok: true, code: "manual_lab", reason }
      : {
          ok: false,
          code: "missing_manual_lab_reason",
          reason: "manual_lab closeout requires an explicit manual_lab reason",
        };
  }

  if (hasCompletePromotionEvidence(input.promotion)) {
    return { ok: true, code: "promotion_evidence_present", reason: "promotion payload completed and verified" };
  }
  return {
    ok: false,
    code: "missing_promotion_evidence",
    reason: "promote closeout requires completed promotion evidence or an explicit promotion_exempt/manual_lab mode",
  };
}

function buildQuarantineRecord(input: Omit<WorktreeQuarantineRecord, "policy_version" | "dedupe_key" | "owner_lane">): WorktreeQuarantineRecord {
  const ownerLane = input.owner_agent ?? policyOwnerLane(input.repo);
  return {
    ...input,
    policy_version: WORKTREE_OS_POLICY_VERSION,
    owner_lane: ownerLane,
    dedupe_key: `${input.repo}:${input.branch}:${input.class_code}`,
  };
}

function hasMetadata(input: CodeDispatchAdmissionInput, field: typeof REQUIRED_ADMISSION_METADATA[number]): boolean {
  if (field === "source_branch") return !!(present(input.source_branch) ?? present(input.branch));
  if (field === "worktree") return !!(present(input.worktree) ?? present(input.worktree_path));
  if (field === "owner") return !!(present(input.owner) ?? present(input.to_agent));
  if (field === "smoke") return Array.isArray(input.smoke) ? input.smoke.some((s) => present(s)) : !!present(input.smoke);
  return !!present(input[field]);
}

function normalizePromotionMode(value: string | null | undefined): PromotionMode | null {
  const v = present(value);
  if (v === "promote" || v === "promotion_exempt" || v === "manual_lab") return v;
  return null;
}

function hasCompletePromotionEvidence(promotion: PromotionAgentDone | null | undefined): boolean {
  return promotion?.completed === true &&
    Array.isArray(promotion.repos) &&
    promotion.repos.length > 0 &&
    promotion.repos.every((repo) =>
      repo.pushed === true &&
      repo.verified === true &&
      !!repo.promoted_sha &&
      !!repo.remote_main_sha &&
      repo.promoted_sha === repo.remote_main_sha
    );
}

function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function policyOwnerLane(repo: string): string {
  const r = repo.toLowerCase();
  if (/(kapelle-site|frontend|console|ui)(\/|$)/.test(r)) return "frontend-ui-codex";
  if (/(id-agents|agent-platform|manager|substrate|cane)(\/|$)/.test(r)) return "substrate-api-codex";
  return "roger";
}

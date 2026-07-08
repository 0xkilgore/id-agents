// T-OSS.2 — Workspace leases + protected canonical checkouts + dirty-root monitor.
//
// Public surface for the manager + supervisor + CLI to consume. The agent never
// writes the canonical root: a build dispatch is allocated a git worktree under
// <protected_root>/.worktrees/, custody is recorded as a WorkspaceLease, and the
// protected root is verified unchanged at closeout.
// Spec: cto/output/2026-06-22-toss2-workspace-leases-protected-checkouts.md

export {
  RepoRegistry,
  DEFAULT_PROTECTED_ROOTS,
  normalizeRoot,
  isWithin,
  type ProtectedRootEntry,
  type ProtectedRootSeverity,
} from "./repo-registry.js";

export {
  decideAdmission,
  allocateWorktree,
  leaseWorktreePath,
  mintLeaseId,
  branchSlug,
  dispatchShort,
  findBranchWorktree,
  listWorktrees,
  gitStatusPorcelain,
  gitStatusShort,
  protectedRootStatus,
  stripWorktreeNoise,
  gitCurrentBranch,
  gitAheadBehind,
  type AdmissionDecision,
  type AdmissionCode,
  type AdmissionInput,
  type AllocateInput,
  type AllocateResult,
  type WorkspacePolicy,
} from "./allocator.js";

export {
  validateWorkspaceCloseout,
  validatePromotionLeaseFields,
  type WorkspaceCloseout,
  type CloseoutValidation,
} from "./closeout.js";
export {
  CLEAN_DEPLOY_CHECKOUT_REPAIR_DEPENDENCY,
  WORKTREE_OS_POLICY_VERSION,
  evaluateCodeDispatchAdmission,
  classifyWorktreeScannerPolicy,
  validateCloseoutPromotionPolicy,
  type AdmissionPolicyDecision,
  type CodeDispatchAdmissionInput,
  type CloseoutPolicyDecision,
  type WorktreeQuarantineRecord,
  type WorktreeScannerPolicyInput,
} from "./policy.js";

export {
  sampleProtectedRoot,
  sampleAll,
  classifySeverity,
  dirtyRootAlerts,
  type DirtyRootRecord,
  type DirtySeverity,
  type SampleOptions,
} from "./monitor.js";

export {
  reapMergedWorktrees,
  type ReapResult,
  type ReapedWorktree,
  type ReapOptions,
  type ReapAction,
} from "./reaper.js";

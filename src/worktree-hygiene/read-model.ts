import type { BranchLedgerRow } from "../branch-ledger/types.js";
import type { MonitorFleetResponse } from "../monitor/types.js";
import type { DirtyRootRecord } from "../workspaces/monitor.js";

export type WorktreeHygieneNextAction =
  | "clean"
  | "inspect_dirty"
  | "fresh_branch"
  | "promote"
  | "rebuild"
  | "prune_merged"
  | "unknown";

export interface CompactCommit {
  sha: string;
  subject: string;
  repo?: string | null;
  committed_at?: string | null;
}

export interface PromotionEvidence {
  dispatch_id: string | null;
  query_id: string | null;
  agent: string | null;
  completed_at: string | null;
  repo: string | null;
  branch: string | null;
  base: string | null;
  promoted_sha: string | null;
  remote_main_sha: string | null;
  completed: boolean | null;
  pushed: boolean | null;
  verified: boolean | null;
}

export interface WorktreeHygieneReadModelInput {
  generated_at: string;
  protected_roots: DirtyRootRecord[];
  branch_ledger_rows?: BranchLedgerRow[];
  promotions?: PromotionEvidence[];
  build?: MonitorFleetResponse["build"] | null;
  origin_main_commits_today?: CompactCommit[];
}

export interface WorktreeHygieneReadModel {
  ok: true;
  schema_version: "worktree-hygiene.v1";
  generated_at: string;
  source: {
    system: "manager";
    projection: "worktree_hygiene";
    source_type: "live_git_and_manager_read_model";
    freshness: "live";
  };
  protected_repos: Array<{
    repo: string;
    root: string;
    branch: string | null;
    intended_branch: string;
    head_sha: string | null;
    origin_main_sha: string | null;
    ahead: number | null;
    behind: number | null;
    dirty_tracked_count: number;
    dirty_untracked_count: number;
    dirty_count: number;
    status: string;
    severity: DirtyRootRecord["severity"];
    last_lease_id: string | null;
    last_dispatch_id: string | null;
    observed_at: string;
    error?: string;
  }>;
  worktree_summary: {
    total: number;
    dirty: number;
    stale_diverged: number;
    merged_but_present: number;
    active: number;
  };
  commit_movement: {
    origin_main_today_count: number;
    origin_main_today: CompactCommit[];
    active_branch_ahead_counts: Array<{ repo: string; branch: string; ahead: number; source: "protected_root" | "branch_ledger" }>;
  };
  release_state: {
    promoted_origin_sha: string | null;
    current_origin_sha: string | null;
    deployed_running_sha: string | null;
    promoted_but_not_deployed_count: number;
    state: "deployed" | "promoted_but_not_deployed" | "unknown";
  };
  accepted_ui_awaiting_release: {
    count: number;
    items: PromotionEvidence[];
    derivation: "promotion_or_branch_evidence_only";
  };
  incidents: Array<{
    dedupe_key: string;
    kind: "protected_root" | "branch_ledger";
    repo: string;
    branch: string | null;
    code: string;
    severity: "critical" | "warning" | "info";
    action_class?: string;
    reason: string;
  }>;
  next_action: WorktreeHygieneNextAction;
  next_action_reason: string;
}

export function buildWorktreeHygieneReadModel(input: WorktreeHygieneReadModelInput): WorktreeHygieneReadModel {
  const roots = input.protected_roots.map((r) => ({
    repo: r.repo_name,
    root: r.root,
    branch: r.branch,
    intended_branch: r.intended_branch,
    head_sha: r.head_sha,
    origin_main_sha: r.origin_main_sha,
    ahead: r.ahead,
    behind: r.behind,
    dirty_tracked_count: r.dirty_tracked_count,
    dirty_untracked_count: r.dirty_untracked_count,
    dirty_count: r.dirty_count,
    status: r.status_short,
    severity: r.severity,
    last_lease_id: r.last_lease_id,
    last_dispatch_id: r.last_dispatch_id,
    observed_at: r.observed_at,
    ...(r.error ? { error: r.error } : {}),
  }));
  const ledgerRows = input.branch_ledger_rows ?? [];
  const promotions = input.promotions ?? [];
  const build = input.build ?? null;
  const promotedOriginSha = build?.origin_main_sha ?? firstNonEmpty(roots.map((r) => r.origin_main_sha));
  const deployedRunningSha = build?.build_sha ?? null;
  const uiAwaiting = promotions.filter((p) => isKapelleRepo(p.repo) && isVerifiedPromotion(p) && p.promoted_sha && p.promoted_sha !== deployedRunningSha);
  const promotedButNotDeployed =
    promotedOriginSha && deployedRunningSha
      ? promotedOriginSha !== deployedRunningSha
      : uiAwaiting.length > 0
        ? true
        : null;
  const incidents = dedupeIncidents([
    ...input.protected_roots.flatMap(protectedRootIncidents),
    ...ledgerRows
      .filter((row) => row.action_class !== "safe_auto_action")
      .map((row) => ({
        dedupe_key: row.dedupe_key,
        kind: "branch_ledger" as const,
        repo: row.repo,
        branch: row.branch,
        code: row.class_code,
        severity: row.action_class === "needs_chris" ? "warning" as const : "info" as const,
        action_class: row.action_class,
        reason: row.recommended_action ?? row.class_code,
      })),
  ]);
  const activeAhead = activeBranchAheadCounts(input.protected_roots, ledgerRows);
  const summary = {
    total: roots.length + ledgerRows.length,
    dirty: roots.filter((r) => r.dirty_count > 0).length + ledgerRows.filter((r) => r.dirty_tracked_count + r.dirty_untracked_count > 0).length,
    stale_diverged: roots.filter((r) => isDiverged(r.ahead, r.behind)).length + ledgerRows.filter((r) => isDiverged(r.ahead, r.behind) || /stale|diverg/i.test(r.class_code)).length,
    merged_but_present: ledgerRows.filter((r) => /merged.*present|prune/i.test(`${r.class_code} ${r.action_class} ${r.recommended_action ?? ""}`)).length,
    active: activeAhead.length,
  };
  const next = chooseNextAction({
    roots: input.protected_roots,
    summary,
    activeAheadCount: activeAhead.length,
    promotedButNotDeployed,
    incidents,
  });

  return {
    ok: true,
    schema_version: "worktree-hygiene.v1",
    generated_at: input.generated_at,
    source: {
      system: "manager",
      projection: "worktree_hygiene",
      source_type: "live_git_and_manager_read_model",
      freshness: "live",
    },
    protected_repos: roots,
    worktree_summary: summary,
    commit_movement: {
      origin_main_today_count: input.origin_main_commits_today?.length ?? 0,
      origin_main_today: input.origin_main_commits_today ?? [],
      active_branch_ahead_counts: activeAhead,
    },
    release_state: {
      promoted_origin_sha: promotedOriginSha,
      current_origin_sha: promotedOriginSha,
      deployed_running_sha: deployedRunningSha,
      promoted_but_not_deployed_count: promotedButNotDeployed ? 1 : 0,
      state: promotedButNotDeployed === null ? "unknown" : promotedButNotDeployed ? "promoted_but_not_deployed" : "deployed",
    },
    accepted_ui_awaiting_release: {
      count: uiAwaiting.length,
      items: uiAwaiting,
      derivation: "promotion_or_branch_evidence_only",
    },
    incidents,
    next_action: next.action,
    next_action_reason: next.reason,
  };
}

function protectedRootIncidents(r: DirtyRootRecord): WorktreeHygieneReadModel["incidents"] {
  const incidents: WorktreeHygieneReadModel["incidents"] = [];
  if (r.error) {
    incidents.push({
      dedupe_key: `protected-root:${r.root}:unreadable`,
      kind: "protected_root",
      repo: r.repo_name,
      branch: r.branch,
      code: "unreadable",
      severity: "info",
      reason: r.error,
    });
  }
  if (r.off_canonical_branch) {
    incidents.push({
      dedupe_key: `protected-root:${r.root}:off_canonical_branch`,
      kind: "protected_root",
      repo: r.repo_name,
      branch: r.branch,
      code: "off_canonical_branch",
      severity: "critical",
      reason: `current branch ${r.branch ?? "DETACHED"} differs from intended ${r.intended_branch}`,
    });
  }
  if (r.dirty_count > 0) {
    incidents.push({
      dedupe_key: `protected-root:${r.root}:dirty`,
      kind: "protected_root",
      repo: r.repo_name,
      branch: r.branch,
      code: "dirty_protected_root",
      severity: r.severity,
      reason: `${r.dirty_count} dirty file(s) in protected root`,
    });
  }
  return incidents;
}

function activeBranchAheadCounts(roots: DirtyRootRecord[], rows: BranchLedgerRow[]) {
  const out: WorktreeHygieneReadModel["commit_movement"]["active_branch_ahead_counts"] = [];
  for (const r of roots) {
    if (r.branch && (r.ahead ?? 0) > 0) out.push({ repo: r.repo_name, branch: r.branch, ahead: r.ahead ?? 0, source: "protected_root" });
  }
  for (const r of rows) {
    if (r.ahead > 0) out.push({ repo: r.repo, branch: r.branch, ahead: r.ahead, source: "branch_ledger" });
  }
  return out.sort((a, b) => b.ahead - a.ahead || a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch));
}

function chooseNextAction(input: {
  roots: DirtyRootRecord[];
  summary: WorktreeHygieneReadModel["worktree_summary"];
  activeAheadCount: number;
  promotedButNotDeployed: boolean | null;
  incidents: WorktreeHygieneReadModel["incidents"];
}): { action: WorktreeHygieneNextAction; reason: string } {
  if (input.roots.some((r) => r.error)) return { action: "unknown", reason: "one or more protected root signals are unreadable" };
  if (input.summary.dirty > 0) return { action: "inspect_dirty", reason: `${input.summary.dirty} protected or ledger worktree(s) are dirty` };
  if (input.summary.stale_diverged > 0) return { action: "fresh_branch", reason: `${input.summary.stale_diverged} branch(es) are stale or diverged from base` };
  if (input.activeAheadCount > 0) return { action: "promote", reason: `${input.activeAheadCount} active branch(es) have commits ahead of base` };
  if (input.promotedButNotDeployed) return { action: "rebuild", reason: "origin/main is promoted beyond the running build SHA" };
  if (input.summary.merged_but_present > 0) return { action: "prune_merged", reason: `${input.summary.merged_but_present} merged branch/worktree row(s) remain present` };
  if (input.promotedButNotDeployed === null) return { action: "unknown", reason: "release state is unreadable" };
  if (input.incidents.length > 0) return { action: "unknown", reason: "incidents remain but no deterministic remediation class matched" };
  return { action: "clean", reason: "protected roots are clean and release/build SHAs are aligned" };
}

function dedupeIncidents(items: WorktreeHygieneReadModel["incidents"]): WorktreeHygieneReadModel["incidents"] {
  const byKey = new Map<string, WorktreeHygieneReadModel["incidents"][number]>();
  for (const item of items) if (!byKey.has(item.dedupe_key)) byKey.set(item.dedupe_key, item);
  return [...byKey.values()].sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key));
}

function isVerifiedPromotion(p: PromotionEvidence): boolean {
  return p.completed === true && p.pushed !== false && p.verified !== false && Boolean(p.promoted_sha);
}

function isKapelleRepo(repo: string | null): boolean {
  return Boolean(repo && /kapelle/i.test(repo));
}

function isDiverged(ahead: number | null, behind: number | null): boolean {
  return (ahead ?? 0) > 0 && (behind ?? 0) > 0;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  return values.find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
}

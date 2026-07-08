export type BranchLedgerActionClass = "safe_auto_action" | "needs_owner" | "needs_chris" | string;

export interface BranchLedgerRow {
  repo: string;
  branch: string;
  head_sha: string | null;
  upstream: string | null;
  base: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty_tracked_count: number;
  dirty_untracked_count: number;
  worktree_path: string | null;
  is_primary_checkout: boolean;
  last_commit_at: string | null;
  last_seen_at: string;
  linked_dispatch_id: string | null;
  linked_task_name: string | null;
  linked_rd: string | null;
  owner_agent: string | null;
  owner_lane: string | null;
  class_code: string;
  action_class: BranchLedgerActionClass;
  recommended_action: string | null;
  dedupe_key: string;
  last_hygiene_run_id: string | null;
  last_promotion_failure_id: string | null;
  console_url: string | null;
  evidence_json: string;
  scanner_payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface BranchLedgerFilters {
  repo?: string | null;
  action_class?: string | null;
  owner_lane?: string | null;
  needs_chris?: boolean | null;
  stale_age_days?: number | null;
  limit?: number | null;
  now?: string;
}

export interface BranchLedgerExceptionCounts {
  total: number;
  by_class_code: Record<string, number>;
  by_action_class: Record<string, number>;
  by_owner_lane: Record<string, number>;
  needs_chris: number;
  needs_fresh_branch: number;
  owner_routed_quarantine: number;
}

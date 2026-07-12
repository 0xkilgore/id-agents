// Continuous Orchestration — shared types.
//
// The daemon pulls READY backlog items and fires dispatches through the
// manager API, strictly within guardrails. It NEVER invents work: items enter
// the backlog as `draft`/`needs_review` (e.g. imported from the roadmap) and
// only a human/approval gate promotes them to `ready`. See the CTO scope
// cto/output/2026-06-16-continuous-orchestration-system-scope.md.

/** Global orchestration mode. Kill-switch file/`stopped` win over everything. */
export type OrchestrationMode =
  | "running"
  | "paused"
  | "drain_only"
  | "approve_only"
  | "stopped";

/** Backlog item lifecycle. Only `ready` is admissible by the tick. */
export type ReadinessState =
  | "draft"
  | "needs_review"
  | "ready"
  | "queued"
  | "in_flight"
  | "blocked_dependency"
  | "needs_chris_batch"
  | "waiting_window"
  | "done"
  | "failed"
  | "superseded"
  | "cancelled";

export type RiskClass = "routine" | "build" | "external" | "destructive" | "costly" | "novel";

/**
 * Auto-flesh lifecycle (daemon SELF-REFUEL). An imported roadmap skeleton lands
 * `unfleshed`; the flesher fills its dispatch fields (`fleshed`), the auto-ready
 * policy promotes safe rows (`approved_ready` → readiness_state `ready`) or holds
 * risky/ambiguous ones for one-click Chris approval (`needs_chris_batch`).
 */
export type FleshStatus =
  | "unfleshed"
  | "fleshing"
  | "fleshed"
  | "approved_ready"
  | "needs_chris_batch"
  | "failed"
  | "stale";

/** The dispatch fields the flesher generates for an unfleshed skeleton. */
export interface FleshPatch {
  to_agent: string;
  dispatch_body: string;
  risk_class: RiskClass;
  write_scope: string[];
  dependencies: string[];
  token_estimate: number;
  provider: string;
  runtime: string;
  value_score: number | null;
  priority: number;
  confidence: number;
  ready_decision: "auto_ready" | "needs_chris_batch";
  reason: string;
}

/** A dispatchable unit of work the daemon can fire. */
export interface BacklogItem {
  item_id: string;
  team_id: string;
  /** Stable identity for the logical work across roadmap imports/refuels. */
  logical_key?: string | null;
  title: string;
  /** Roadmap track, e.g. "T-ORCH", "T15", "T-CKPT". */
  track: string | null;
  /** Owner lane — the target agent the dispatch fires to. */
  to_agent: string | null;
  /** The dispatch body fired when admitted. Null until the item is ready. */
  dispatch_body: string | null;
  /** 1 (highest) .. 9 (lowest). */
  priority: number;
  value_score: number | null;
  readiness_state: ReadinessState;
  risk_class: RiskClass;
  /** Repos/dirs this item writes — enforces single-writer lanes. */
  write_scope: string[];
  /** item_ids that must be `done` before this is admissible. */
  dependencies: string[];
  token_estimate: number | null;
  provider: string | null;
  runtime: string | null;
  /** Monday North Star items sort ahead of everything else. */
  is_north_star: boolean;
  source_refs: string[];
  /** Who promoted needs_review -> ready (the human approval gate). */
  approved_by: string | null;
  approved_at: string | null;
  last_dispatch_phid: string | null;
  /** Explicit marker allowing a previously-dispatched row to fire again. */
  retry_safe?: boolean;
  /** Actor who last edited this item via PATCH (actor-attributed updates). */
  updated_by: string | null;
  /**
   * True when the item's `track` does not conform to the canonical-track-registry
   * (flagged at ingest — warn + tag, never blocks). See src/track-registry.
   */
  track_drift: boolean;
  // ── Auto-flesh (daemon SELF-REFUEL) ──
  flesh_status: FleshStatus;
  flesh_source: string | null;
  flesh_confidence: number | null;
  flesh_error: string | null;
  flesh_attempts: number;
  fleshed_at: string | null;
  auto_ready_approved_at: string | null;
  auto_ready_policy_version: string | null;
  /** The proposed FleshPatch (stored for one-click approve of needs_chris_batch). */
  flesh_patch: FleshPatch | null;
  created_at: string;
  updated_at: string;
}

/** What the tick decided for one candidate (or a guardrail-level event). */
export interface DecisionRecord {
  item_id: string | null;
  action:
    | "dispatched"
    | "would_dispatch"
    | "skipped"
    | "held"
    | "guardrail_halt"
    | "stall_alert"
    | "auto_pause"
    | "refuel"
    | "fleet_blockage"
    | "model_policy_drift_alert"
    | "auto_promote"
    | "ready_metadata_repair"
    | "reconciled"
    | "would_reconcile";
  reason: string;
  dispatch_phid?: string | null;
  metadata?: Record<string, unknown>;
}

/** The token/budget view the tick reads from usage-meter-v2 each cycle. */
export interface UsageGateView {
  /** True when the global gate is hard-paused under enforcement. */
  hard_paused: boolean;
  daily_percent: number | null;
  weekly_percent: number | null;
  enforcement: "warn" | "enforce";
}

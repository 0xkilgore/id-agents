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

/** A dispatchable unit of work the daemon can fire. */
export interface BacklogItem {
  item_id: string;
  team_id: string;
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
  /** Actor who last edited this item via PATCH (actor-attributed updates). */
  updated_by: string | null;
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
    | "auto_pause";
  reason: string;
  dispatch_phid?: string | null;
  metadata?: Record<string, unknown>;
}

/** The token/budget view the tick reads from usage-meter-v2 each cycle. */
export interface UsageGateView {
  /** True when the global gate is hard-paused under enforcement. */
  hard_paused: boolean;
  daily_percent: number;
  weekly_percent: number;
  enforcement: "warn" | "enforce";
}

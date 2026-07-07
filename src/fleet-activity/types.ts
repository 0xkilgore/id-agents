// Kapelle Fleet Activity — "what your fleet did since you last looked".
//
// A team-scoped, since-watermark activity feed that federates three substrate
// sources into one newest-first event stream:
//   - artifact_produced   (artifacts catalog, by produced_at)
//   - dispatch_completed  (terminal dispatch_scheduler_queue rows, by completed_at)
//   - dispatch_queued     (active dispatch_scheduler_queue rows, by queued_at)
//   - task_claimed        (tasks assigned/started, by updated_at)
//   - task_completed      (tasks finished, by completed_at)
//   - artifact_commented  (artifact_operations comment_recorded, by op ts)
//
// The feed is the read path behind the daily surface. It is deliberately
// owner-agnostic: scoping is by team_id, never by a hard-coded operator
// identity or filesystem path.

export type FleetActivityKind =
  | "artifact_produced"
  | "dispatch_completed"
  | "dispatch_queued"
  | "task_claimed"
  | "task_completed"
  | "artifact_commented";

export const FLEET_ACTIVITY_KINDS: readonly FleetActivityKind[] = [
  "artifact_produced",
  "dispatch_completed",
  "dispatch_queued",
  "task_claimed",
  "task_completed",
  "artifact_commented",
] as const;

export interface FleetActivityEvent {
  /** Stable, kind-prefixed id (e.g. `artifact_produced:art_1`). */
  id: string;
  kind: FleetActivityKind;
  /** The watermark axis: when this thing happened (ISO 8601). */
  ts: string;
  /** Agent that produced the activity, when known. */
  actor: string | null;
  label: string;
  summary: string | null;
  href: string | null;
  source_ref: string;
  metadata: Record<string, unknown>;
}

export interface FleetActivityResponse {
  schema_version: "fleet.activity.v1";
  generated_at: string;
  team: {
    id: string | null;
    name: string | null;
  };
  watermark: {
    /** The caller's "last looked" boundary (inclusive lower bound), or null. */
    since: string | null;
    /**
     * Newest event ts in this response — pass back as `since` next time to
     * resume from here. null when the response is empty.
     */
    next: string | null;
  };
  source: {
    system: "manager";
    projection: "fleet_activity";
    source_type: "hybrid_projection";
    read_path: "substrate";
  };
  filters: {
    since: string | null;
    limit: number;
    kinds: FleetActivityKind[];
  };
  counts: {
    /** Total matched events across all kinds (before the limit slice). */
    total: number;
    /** Events actually returned (after the limit slice). */
    returned: number;
    artifact_produced: number;
    dispatch_completed: number;
    dispatch_queued: number;
    task_claimed: number;
    task_completed: number;
    artifact_commented: number;
  };
  instrumentation: {
    generated_for_day: string;
    active_window_hours: number;
    daily_active_agents: number;
    agents: Array<{
      id: string;
      name: string;
      status: string | null;
      last_seen_at: string | null;
      active_today: boolean;
    }>;
  };
  items: FleetActivityEvent[];
  warnings: Array<{ code: string; message: string }>;
}

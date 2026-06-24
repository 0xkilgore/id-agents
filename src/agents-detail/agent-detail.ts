// AGENT-V2 (2026-06-24, phid:disp-94021fb2bd1fb039) — GET /agents/:name/detail
// per-agent dossier: { identity + current model, health, last-N dispatches,
// recent outputs, cost }.
//
// This module is the testable orchestrator (mirrors the dispatch-verification
// getAgentDispatches(deps, …) pattern): the manager route wires the real
// building blocks into `AgentDetailDeps`, and this composes them into one
// dossier. Every sub-fetch is BEST-EFFORT — a missing verification store or an
// un-ingested usage table degrades that section to null/[] rather than failing
// the whole dossier. Only an unknown agent is a hard 404.

export interface AgentDetailIdentity {
  id: string;
  name: string;
  /** The agent's current model (AgentRow.model). */
  model: string;
  type: string;
  status: string;
  working_directory: string | null;
  /** Operational health string from the agent catalog (agentToResponse.health). */
  health: string | null;
  last_health_check: number | null;
}

/** Reliability posture derived from dispatch-verification effectiveness. */
export interface AgentDetailHealth {
  status: string;
  dispatches_completed: number;
  verified_landings: number;
  verified_landing_rate: number;
  throughput: number;
  in_flight_dispatch_id: string | null;
}

/** Per-agent spend signal from the usage-meter daily report (by_agent). The
 *  substrate tracks weighted tokens per agent; fleet cost_usd is report-level. */
export interface AgentDetailCost {
  date: string;
  weighted_tokens: number;
  input_tokens: number;
  output_tokens: number;
  providers: string[];
  /** Share of the fleet's weighted-token spend (0..100). */
  pct_weighted: number;
}

export interface AgentDetailResponse {
  schema_version: "agents.detail.v1";
  generated_at: string;
  agent_name: string;
  identity: AgentDetailIdentity;
  /** Convenience mirror of identity.model — the dispatch asks for "current model". */
  model: string;
  health: AgentDetailHealth | null;
  recent_dispatches: unknown[];
  recent_outputs: unknown[];
  cost: AgentDetailCost | null;
}

export interface AgentDetailDeps {
  getIdentity: (teamId: string, name: string) => Promise<AgentDetailIdentity | null>;
  getHealth: (teamId: string, name: string) => Promise<AgentDetailHealth | null>;
  getRecentDispatches: (teamId: string, name: string, limit: number) => Promise<unknown[]>;
  getRecentOutputs: (teamId: string, agentId: string, limit: number) => Promise<unknown[]>;
  getCost: (teamId: string, agentId: string) => Promise<AgentDetailCost | null>;
  now: () => string;
}

export interface HandlerResult<T> {
  status: number;
  body: T;
}

export const AGENT_DETAIL_DEFAULT_LIMIT = 10;
export const AGENT_DETAIL_MAX_LIMIT = 50;

/** Parse ?limit (default 10, clamped 1..50). Mirrors the read-model limit parse. */
export function parseDetailLimit(raw: unknown): number {
  if (raw == null || raw === "") return AGENT_DETAIL_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AGENT_DETAIL_DEFAULT_LIMIT;
  return Math.min(AGENT_DETAIL_MAX_LIMIT, Math.floor(n));
}

async function nullOnError<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function arrOnError(fn: () => Promise<unknown[]>): Promise<unknown[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/**
 * Assemble the per-agent dossier. 404 when the agent is unknown; otherwise 200
 * with whatever sections resolved (best-effort — see module header).
 */
export async function getAgentDetail(
  deps: AgentDetailDeps,
  teamId: string,
  name: string,
  opts: { limit?: unknown } = {},
): Promise<HandlerResult<AgentDetailResponse | { error: string }>> {
  const identity = await deps.getIdentity(teamId, name);
  if (!identity) {
    return { status: 404, body: { error: `Agent "${name}" not found` } };
  }
  const limit = parseDetailLimit(opts.limit);
  const [health, recent_dispatches, recent_outputs, cost] = await Promise.all([
    nullOnError(() => deps.getHealth(teamId, name)),
    arrOnError(() => deps.getRecentDispatches(teamId, name, limit)),
    arrOnError(() => deps.getRecentOutputs(teamId, identity.id, limit)),
    nullOnError(() => deps.getCost(teamId, identity.id)),
  ]);
  return {
    status: 200,
    body: {
      schema_version: "agents.detail.v1",
      generated_at: deps.now(),
      agent_name: identity.name,
      identity,
      model: identity.model,
      health,
      recent_dispatches,
      recent_outputs,
      cost,
    },
  };
}

// W2-1 DispatchVerification — Agents-tab endpoints.
//
// GET /agents/effectiveness?window=24h|7d|30d   (default 7d)
// GET /agents/:name/dispatches?window=&limit=   (default 7d, 50)
//
// These read the durable projection ONLY — they never stat files on request.
// The handlers are framework-agnostic and pure-ish (DB reads via the injected
// storage); the express wiring is a thin adapter so the same logic is unit-
// and integration-testable without standing up the whole manager.

import {
  isEffectivenessWindow,
  WINDOW_DAYS,
  type DispatchVerification,
  type EffectivenessWindow,
} from "./types.js";
import {
  buildAgentDispatches,
  buildAgentsEffectiveness,
  buildTrend4w,
  type AgentDispatchesResponse,
  type AgentsEffectivenessResponse,
} from "./read-model.js";

export interface RosterEntry {
  name: string;
  status: string;
  in_flight_dispatch_id?: string | null;
}

export interface DispatchVerificationRouteDeps {
  storage: {
    readWindow(teamId: string, fromIso: string, toIso: string): Promise<DispatchVerification[]>;
    readAgentWindow(
      teamId: string,
      agentName: string,
      fromIso: string,
      toIso: string,
      limit: number,
    ): Promise<DispatchVerification[]>;
  };
  /** Resolve the agent roster for the team (status + in-flight dispatch id). */
  listRoster(teamId: string): Promise<RosterEntry[]>;
  now: () => string;
}

export interface HandlerResult<T> {
  status: number;
  body: T | { error: string };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseWindow(raw: unknown): EffectivenessWindow | null {
  if (raw === undefined || raw === null || raw === "") return "7d";
  return isEffectivenessWindow(raw) ? raw : null;
}

export function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return null;
  return n;
}

function windowBounds(window: EffectivenessWindow, nowIso: string): { fromIso: string; toIso: string } {
  const now = Date.parse(nowIso);
  const fromMs = now - WINDOW_DAYS[window] * 86_400_000;
  return { fromIso: new Date(fromMs).toISOString(), toIso: nowIso };
}

/** GET /agents/effectiveness — verified-landing-rate for the fleet + per agent. */
export async function getAgentsEffectiveness(
  deps: DispatchVerificationRouteDeps,
  teamId: string,
  query: { window?: unknown },
): Promise<HandlerResult<AgentsEffectivenessResponse>> {
  const window = parseWindow(query.window);
  if (window === null) return { status: 400, body: { error: "invalid_window" } };

  const nowIso = deps.now();
  const { fromIso, toIso } = windowBounds(window, nowIso);
  // trend_4w spans four 7-day buckets (28 days) regardless of the window.
  // Fetch the wider of {window, 28d} once; use window rows for the fleet/agent
  // rollups (which count regardless of status) and the full set for trend.
  const trendFromIso = new Date(Date.parse(nowIso) - 28 * 86_400_000).toISOString();
  const earliestFrom = Date.parse(fromIso) < Date.parse(trendFromIso) ? fromIso : trendFromIso;

  const allRows = await deps.storage.readWindow(teamId, earliestFrom, toIso);
  const roster = await deps.listRoster(teamId);

  const windowRows = allRows.filter(
    (r) => r.dispatch_completed_at !== null && r.dispatch_completed_at >= fromIso,
  );
  const body = buildAgentsEffectiveness(windowRows, roster, window, nowIso);
  // Override trend with the wider 28-day set so all four buckets are populated
  // even for a 24h/7d window (the rollup numbers stay window-scoped).
  body.fleet.trend_4w = buildTrend4w(allRows, nowIso);
  return { status: 200, body };
}

/** GET /agents/:name/dispatches — recent dispatches for one agent. */
export async function getAgentDispatches(
  deps: DispatchVerificationRouteDeps,
  teamId: string,
  agentName: string,
  query: { window?: unknown; limit?: unknown },
): Promise<HandlerResult<AgentDispatchesResponse>> {
  const window = parseWindow(query.window);
  if (window === null) return { status: 400, body: { error: "invalid_window" } };
  const limit = parseLimit(query.limit);
  if (limit === null) return { status: 400, body: { error: "invalid_limit" } };

  const nowIso = deps.now();
  const { fromIso, toIso } = windowBounds(window, nowIso);
  const rows = await deps.storage.readAgentWindow(teamId, agentName, fromIso, toIso, limit);
  const body = buildAgentDispatches(rows, agentName, window, limit, nowIso);
  return { status: 200, body };
}

/**
 * Express adapter. Mounts BOTH routes. `/agents/effectiveness` is registered
 * before any dynamic `/agents/:id` route by the caller to avoid capture; this
 * helper only wires the two handlers. `resolveTeamId` returns the team for a
 * request (mirrors existing manager management-route auth).
 */
export function mountDispatchVerificationRoutes(
  router: {
    get(path: string, handler: (req: ExpressLikeReq, res: ExpressLikeRes) => void): void;
  },
  deps: DispatchVerificationRouteDeps & {
    resolveTeamId: (req: ExpressLikeReq) => Promise<string | null> | string | null;
  },
): void {
  router.get("/agents/effectiveness", (req, res) => {
    void (async () => {
      const teamId = await deps.resolveTeamId(req);
      if (!teamId) return res.status(400).json({ error: "team_not_resolved" });
      const r = await getAgentsEffectiveness(deps, teamId, { window: req.query?.window });
      res.status(r.status).json(r.body);
    })().catch((err) => res.status(500).json({ error: errMessage(err) }));
  });

  router.get("/agents/:name/dispatches", (req, res) => {
    void (async () => {
      const teamId = await deps.resolveTeamId(req);
      if (!teamId) return res.status(400).json({ error: "team_not_resolved" });
      const name = req.params?.name ?? "";
      const r = await getAgentDispatches(deps, teamId, name, {
        window: req.query?.window,
        limit: req.query?.limit,
      });
      res.status(r.status).json(r.body);
    })().catch((err) => res.status(500).json({ error: errMessage(err) }));
  });
}

interface ExpressLikeReq {
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, unknown>;
}
interface ExpressLikeRes {
  status(code: number): ExpressLikeRes;
  json(body: unknown): void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

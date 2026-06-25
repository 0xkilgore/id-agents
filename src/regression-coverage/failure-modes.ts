// T-QA.5 — the canonical typed failure-mode catalog (the data).
//
// Grounded in real failure classes this team has hit (the spec names
// false-expire, rate-limit cascade, deploy gap, backfill defect, BUG-006).
// Each typed mode is something a regression test must lock before its bug closes.

import type { FailureModeDef, FailureModeId } from "./types.js";

export const FAILURE_MODES: FailureModeDef[] = [
  {
    id: "false_expire",
    name: "False expire / false-STALL",
    description:
      "An item is wrongly marked expired/stale/STALL when it is actually live — e.g. STALL reported while all build slots are full.",
    example: "continuous-orchestration false-STALL-on-full-slots",
  },
  {
    id: "rate_limit_cascade",
    name: "Rate-limit mislabel cascade",
    description:
      "A transport/connection failure is hardcoded/mislabeled as a provider rate limit (429), cascading into wrong retry/backoff behavior.",
    example: "provider_rate_limit_exhausted that was actually last_bounce_json.kind=transport",
  },
  {
    id: "deploy_gap",
    name: "Deploy / freshness gap",
    description:
      "Correct shipped code is not actually loaded — a long-running orphan process or a missing restart/redeploy means the fix never took effect.",
    example: "'fix isn't working' = orphan process (PPID 1) never cycled to load the new code",
  },
  {
    id: "backfill_defect",
    name: "Backfill / projection defect",
    description:
      "A backfill or read projection reads the wrong field or source — e.g. sorting by live fs mtime instead of the catalog's frozen produced_at.",
    example: "GET /artifacts sorted by fs.stat mtime not produced_at ('old artifacts landed at noon')",
  },
  {
    id: "agent_down_vs_provider_error",
    name: "Agent-down vs provider-error misattribution",
    description:
      "A down agent process is misattributed to a provider/server error, masking the real cause (process not listening on its port).",
    example: "provider_server_error/agent_unreachable that was the agent process being down",
  },
  {
    id: "placeholder_reuse",
    name: "SQL placeholder / param-count defect",
    description:
      "A query reuses a $N placeholder (each occurrence becomes a positional ?) or otherwise miscounts params → 'Too few parameter values'.",
    example: "SqliteAdapter $N reuse throwing on a routed query",
  },
  {
    id: "in_flight_leak",
    name: "In-flight reconciliation leak",
    description:
      "Dispatch in_flight rows are not reconciled out when their dispatch terminates, eventually strangling the scheduling loop.",
    example: "overnight loop-strangle fixed by reconciling in_flight items out on dispatch terminal",
  },
  {
    id: "other",
    name: "Other / uncatalogued",
    description:
      "A failure that does not yet have a typed mode. Still requires a regression test to close; type it (or add a new mode) when recurring.",
    example: "any one-off not yet a named class",
  },
];

const BY_ID = new Map<FailureModeId, FailureModeDef>(FAILURE_MODES.map((m) => [m.id, m]));

export function getFailureMode(id: FailureModeId): FailureModeDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown failure mode: ${id}`);
  return def;
}

export function isKnownFailureMode(id: string): id is FailureModeId {
  return BY_ID.has(id as FailureModeId);
}

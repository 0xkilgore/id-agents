// Manual-trigger admission (B1, 2026-06-22) — the pure, testable core of
// POST /loops/:ref/run. Normalizes the request actor/surface/idempotency-key,
// evaluates the enabled / allow_manual_run gates, and builds the queued
// LoopRun envelope (with an admission evidence step). DB-dependent checks
// (duplicate idempotency, active-run cap) stay in the route/storage layer.

import { loopRunPhid } from "./storage.js";
import type {
  ActorRef,
  LoopRecord,
  LoopRunRecord,
  LoopStepLog,
  LoopTrigger,
} from "./types.js";

export type ManualRejectCode =
  | "invalid_loop_identifier"
  | "loop_not_found"
  | "loop_disabled"
  | "manual_run_not_allowed";

const HTTP_BY_CODE: Record<ManualRejectCode, number> = {
  invalid_loop_identifier: 400,
  loop_not_found: 404,
  loop_disabled: 409,
  manual_run_not_allowed: 409,
};

export function manualRejectHttpStatus(code: ManualRejectCode): number {
  return HTTP_BY_CODE[code];
}

export interface ManualTriggerRequest {
  idempotency_key?: string;
  actor?: { type?: string; kind?: string; id?: string; label?: string } | null;
  surface?: string;
  reason?: string | null;
}

type ManualSurface = Extract<LoopTrigger, { kind: "manual" }>["surface"];

const SURFACES: readonly ManualSurface[] = ["dashboard", "cli", "telegram", "api"];

export function normalizeActor(raw: ManualTriggerRequest["actor"]): ActorRef {
  const id = (raw?.id ?? "operator").trim() || "operator";
  const k = (raw?.kind ?? raw?.type ?? "").toLowerCase();
  const kind: ActorRef["kind"] =
    k === "human" || k === "user"
      ? "user"
      : k === "agent"
        ? "agent"
        : k === "system"
          ? "system"
          : k === "service"
            ? "service"
            : "user";
  return { kind, id, label: raw?.label ?? id };
}

function normalizeSurface(raw: string | undefined): ManualSurface {
  const s = (raw ?? "").toLowerCase() as ManualSurface;
  return SURFACES.includes(s) ? s : "api";
}

/** Synthesize a stable idempotency key when the caller omits one: floors to the
 *  minute so a double-click within the same minute collapses to one run. */
export function synthesizeIdempotencyKey(
  loopPhid: string,
  actor: ActorRef,
  surface: ManualSurface,
  nowIso: string,
): string {
  const minute = nowIso.slice(0, 16); // YYYY-MM-DDTHH:mm
  return `manual:${loopPhid}:${actor.id}:${surface}:${minute}`;
}

/** True for a malformed/display-only ref (empty or a bare table index). */
export function isMalformedLoopRef(ref: string): boolean {
  const r = (ref ?? "").trim();
  if (!r) return true;
  if (/^\d+$/.test(r)) return true; // a row number, not an id
  return false;
}

/** Evaluate the loop-state gates. Returns a reject code or null (= admit). */
export function evaluateManualTrigger(loop: LoopRecord): ManualRejectCode | null {
  if (!loop.enabled) return "loop_disabled";
  if (!loop.allow_manual_run) return "manual_run_not_allowed";
  return null;
}

export interface BuiltManualRun {
  run: LoopRunRecord;
  idempotency_key: string;
}

/** Build the queued LoopRun envelope for an admitted manual trigger, including
 *  the admission evidence step. The run is `queued`; the daemon/runtime drives
 *  it forward later via transitionLoopRun(). */
export function buildManualRun(
  loop: LoopRecord,
  req: ManualTriggerRequest,
  nowIso: string,
): BuiltManualRun {
  const actor = normalizeActor(req.actor);
  const surface = normalizeSurface(req.surface);
  const idempotencyKey =
    (req.idempotency_key ?? "").trim() ||
    synthesizeIdempotencyKey(loop.loop_phid, actor, surface, nowIso);

  const trigger: LoopTrigger = {
    kind: "manual",
    actor,
    surface,
    idempotency_key: idempotencyKey,
    reason: req.reason ?? null,
  };

  const admissionStep: LoopStepLog = {
    step_id: "admission",
    phase: "admission",
    name: "manual trigger admitted",
    status: "succeeded",
    started_at: nowIso,
    finished_at: nowIso,
    failure_reason: null,
    detail: `manual run by ${actor.kind}:${actor.id} via ${surface}`,
    evidence_refs: [{ kind: "trigger", ref: `manual:${idempotencyKey}` }],
  };

  const run: LoopRunRecord = {
    loop_run_phid: loopRunPhid(loop.loop_phid, idempotencyKey),
    loop_phid: loop.loop_phid,
    trigger,
    status: "queued",
    failure_reason: null,
    failure_detail: null,
    step_log: [admissionStep],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: idempotencyKey,
    retry_of_phid: null,
    fired_at: nowIso,
    queued_at: nowIso,
    admitted_at: null,
    started_at: null,
    finished_at: null,
    created_by: actor,
    updated_at: nowIso,
  };

  return { run, idempotency_key: idempotencyKey };
}

import type { DbAdapter } from "../db/db-adapter.js";
import type { LoopSummary, ReportDefinition } from "./registry.js";
import { SEED_LOOPS } from "./registry.js";
import type { LoopOutputRef, LoopRunRecord, LoopStepLog, LoopRunStatus } from "./types.js";
import { listLoopRuns } from "./storage.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const BIWEEK_MS = 14 * DAY_MS;

const TERMINAL_STATUSES: ReadonlySet<LoopRunStatus> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export type ReportRunFactStatus = "expected" | "done" | "late" | "failed" | "skipped";

export interface ReportProofRef {
  kind: "artifact" | "path" | "href" | "dispatch" | "evidence";
  ref: string;
}

export interface ReportRunFact {
  report_key: string;
  loop_phid: string;
  loop_slug: string;
  loop_run_phid: string | null;
  expected_for: string;
  due_at: string;
  stale_at: string;
  status: ReportRunFactStatus;
  reason: string;
  artifact_refs: ReportProofRef[];
  ref_proof: ReportProofRef[];
  fired_at: string | null;
  finished_at: string | null;
}

export interface ReportDefinitionFact {
  report_key: string;
  label: string;
  loop_phid: string;
  loop_slug: string;
  loop_name: string;
  project_phid: string | null;
  owner_agent: string;
  enabled: boolean;
  cadence: ReportDefinition["cadence"];
  grace_minutes: number;
  stale_after_minutes: number;
  artifact_required: boolean;
}

export interface ReportsDueResponse {
  schema_version: "report-facts-v1";
  generated_at: string;
  definitions: ReportDefinitionFact[];
  runs: ReportRunFact[];
  owed_now: ReportRunFact[];
  stale: ReportRunFact[];
  summary: {
    expected: number;
    done: number;
    late: number;
    failed: number;
    skipped: number;
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function setUtcTime(dayStartMs: number, hourUtc: number, minuteUtc: number): number {
  const d = new Date(dayStartMs);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return d.getTime();
}

export function previousDueAt(def: ReportDefinition, nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid nowIso: ${nowIso}`);

  switch (def.cadence.kind) {
    case "interval_hours": {
      const anchorMs = Date.parse(def.cadence.anchor_due_at);
      if (!Number.isFinite(anchorMs)) throw new Error(`invalid anchor_due_at: ${def.cadence.anchor_due_at}`);
      const period = Math.max(1, def.cadence.every_hours) * HOUR_MS;
      if (nowMs < anchorMs) return iso(anchorMs);
      return iso(anchorMs + Math.floor((nowMs - anchorMs) / period) * period);
    }
    case "weekly": {
      const now = new Date(nowMs);
      const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const daysSinceDue = (now.getUTCDay() - def.cadence.weekday + 7) % 7;
      let due = setUtcTime(currentDayStart - daysSinceDue * DAY_MS, def.cadence.hour_utc, def.cadence.minute_utc);
      if (due > nowMs) due -= WEEK_MS;
      return iso(due);
    }
    case "biweekly": {
      const anchorMs = Date.parse(def.cadence.anchor_due_at);
      if (!Number.isFinite(anchorMs)) throw new Error(`invalid anchor_due_at: ${def.cadence.anchor_due_at}`);
      if (nowMs < anchorMs) return iso(anchorMs);
      return iso(anchorMs + Math.floor((nowMs - anchorMs) / BIWEEK_MS) * BIWEEK_MS);
    }
  }
}

function proofFromOutputs(outputs: readonly LoopOutputRef[]): ReportProofRef[] {
  const refs: ReportProofRef[] = [];
  for (const output of outputs) {
    if (output.artifact_phid) refs.push({ kind: "artifact", ref: output.artifact_phid });
    if (output.path) refs.push({ kind: "path", ref: output.path });
    if (output.href) refs.push({ kind: "href", ref: output.href });
    for (const phid of output.dispatch_phids) refs.push({ kind: "dispatch", ref: phid });
  }
  return refs;
}

function proofFromSteps(steps: readonly LoopStepLog[]): ReportProofRef[] {
  return steps.flatMap((step) =>
    step.evidence_refs.map((e) => ({ kind: "evidence" as const, ref: `${e.kind}:${e.ref}` })),
  );
}

function refProof(run: LoopRunRecord | null): ReportProofRef[] {
  if (!run) return [];
  return [
    ...proofFromOutputs(run.output_refs),
    ...run.spawned_dispatch_phids.map((ref) => ({ kind: "dispatch" as const, ref })),
    ...proofFromSteps(run.step_log),
  ];
}

function runExpectedFor(run: LoopRunRecord): string | null {
  return run.trigger.kind === "scheduled" ? run.trigger.scheduled_for : null;
}

function runCoversExpected(run: LoopRunRecord, expectedFor: string, staleAt: string): boolean {
  const scheduledFor = runExpectedFor(run);
  if (scheduledFor) return scheduledFor === expectedFor;
  return run.fired_at >= expectedFor && run.fired_at <= staleAt;
}

function selectRunForExpected(runs: readonly LoopRunRecord[], expectedFor: string, staleAt: string): LoopRunRecord | null {
  const matches = runs
    .filter((run) => runCoversExpected(run, expectedFor, staleAt))
    .sort((a, b) => (a.fired_at < b.fired_at ? 1 : a.fired_at > b.fired_at ? -1 : 0));
  return matches[0] ?? null;
}

function reasonForRun(run: LoopRunRecord, proof: readonly ReportProofRef[], artifactRequired: boolean): string {
  if (run.status === "cancelled") return run.failure_detail ?? "run_cancelled";
  if (run.status === "failed") return run.failure_detail ?? run.failure_reason ?? "run_failed";
  if (artifactRequired && proof.length === 0) return "artifact_or_ref_proof_missing";
  if (run.status === "partial") return run.failure_detail ?? "partial_run_with_proof";
  return "artifact_or_ref_proof_present";
}

export function reportDefinitionFacts(loops: readonly LoopSummary[] = SEED_LOOPS): ReportDefinitionFact[] {
  return loops.flatMap((loop) =>
    loop.report_definitions.map((def) => ({
      report_key: def.report_key,
      label: def.label,
      loop_phid: loop.loop_phid,
      loop_slug: loop.slug,
      loop_name: loop.name,
      project_phid: loop.project?.project_phid ?? null,
      owner_agent: loop.owner_agent,
      enabled: loop.enabled && def.enabled,
      cadence: def.cadence,
      grace_minutes: def.grace_minutes,
      stale_after_minutes: def.stale_after_minutes,
      artifact_required: def.artifact_required,
    })),
  );
}

export function projectReportRunFact(
  loop: LoopSummary,
  def: ReportDefinition,
  runs: readonly LoopRunRecord[],
  nowIso: string,
): ReportRunFact {
  const expectedFor = previousDueAt(def, nowIso);
  const dueMs = Date.parse(expectedFor) + def.grace_minutes * MINUTE_MS;
  const staleMs = Date.parse(expectedFor) + def.stale_after_minutes * MINUTE_MS;
  const dueAt = iso(dueMs);
  const staleAt = iso(staleMs);
  const nowMs = Date.parse(nowIso);
  const run = selectRunForExpected(runs, expectedFor, staleAt);
  const proof = refProof(run);
  const artifactRefs = proof.filter((p) => p.kind === "artifact" || p.kind === "path" || p.kind === "href");

  let status: ReportRunFactStatus;
  let reason: string;
  if (!loop.enabled || !def.enabled) {
    status = "skipped";
    reason = !loop.enabled ? "loop_disabled" : "report_definition_disabled";
  } else if (run) {
    if (run.status === "cancelled") status = "skipped";
    else if (run.status === "failed") status = "failed";
    else if (TERMINAL_STATUSES.has(run.status)) {
      status = def.artifact_required && proof.length === 0 ? "failed" : "done";
    } else {
      status = nowMs > dueMs ? "late" : "expected";
    }
    reason = reasonForRun(run, proof, def.artifact_required);
  } else if (nowMs > staleMs) {
    status = "late";
    reason = "no_run_recorded_past_stale_window";
  } else if (nowMs > dueMs) {
    status = "late";
    reason = "no_run_recorded_past_grace_window";
  } else {
    status = "expected";
    reason = "due_window_open";
  }

  return {
    report_key: def.report_key,
    loop_phid: loop.loop_phid,
    loop_slug: loop.slug,
    loop_run_phid: run?.loop_run_phid ?? null,
    expected_for: expectedFor,
    due_at: dueAt,
    stale_at: staleAt,
    status,
    reason,
    artifact_refs: artifactRefs,
    ref_proof: proof,
    fired_at: run?.fired_at ?? null,
    finished_at: run?.finished_at ?? null,
  };
}

export async function buildReportsDue(
  adapter: DbAdapter,
  nowIso: string,
  opts: { team_id?: string | null; loops?: readonly LoopSummary[] } = {},
): Promise<ReportsDueResponse> {
  const loops = opts.loops ?? SEED_LOOPS;
  const runs: ReportRunFact[] = [];
  for (const loop of loops) {
    if (loop.report_definitions.length === 0) continue;
    const loopRuns = await listLoopRuns(adapter, loop.loop_phid, { limit: 200, team_id: opts.team_id ?? null });
    for (const def of loop.report_definitions) {
      runs.push(projectReportRunFact(loop, def, loopRuns, nowIso));
    }
  }
  const summary = {
    expected: runs.filter((r) => r.status === "expected").length,
    done: runs.filter((r) => r.status === "done").length,
    late: runs.filter((r) => r.status === "late").length,
    failed: runs.filter((r) => r.status === "failed").length,
    skipped: runs.filter((r) => r.status === "skipped").length,
  };
  return {
    schema_version: "report-facts-v1",
    generated_at: nowIso,
    definitions: reportDefinitionFacts(loops),
    runs,
    owed_now: runs.filter((r) => r.status === "expected" || r.status === "late"),
    stale: runs.filter((r) => r.status === "late" || r.status === "failed"),
    summary,
  };
}

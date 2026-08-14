import { createHash } from "node:crypto";
import { buildDailyDeskResponse } from "../daily-desk/projection.js";
import type { DailyDeskAction, DailyDeskFreshnessState, DailyDeskRow } from "../daily-desk/types.js";
import {
  OPERATOR_ATTENTION_CAPS,
  OPERATOR_ATTENTION_MAX_BYTES,
  OPERATOR_ATTENTION_SCHEMA_VERSION,
  type OperatorAttentionBand,
  type OperatorAttentionBuildResult,
  type OperatorAttentionCandidate,
  type OperatorAttentionItem,
  type OperatorAttentionResponse,
  type OperatorAttentionSourceSet,
  type OperatorAttentionSuppression,
  type OperatorAttentionSuppressionCode,
} from "./types.js";

const TERMINAL = new Set(["done", "archived", "withdrawn", "superseded", "resolved", "closed"]);
const DECISIONS = new Set(["decide", "answer", "approve"]);
const OWNER_DAILY_BUDGET = 2;
const KNOWN_ACTIONS: DailyDeskAction[] = [
  "open", "complete", "snooze", "acknowledge", "comment", "approve", "request_change", "route", "react",
];

export interface BuildOperatorAttentionOptions {
  evaluatedAt?: Date;
  today?: string;
  capabilities?: Partial<Record<DailyDeskAction, "available" | `disabled:${string}`>>;
}

export class OperatorAttentionUnavailableError extends Error {
  readonly code = "OPERATOR_ATTENTION_SOURCE_UNAVAILABLE";
  readonly status = 503;
}

export function buildOperatorAttention(
  source: OperatorAttentionSourceSet,
  options: BuildOperatorAttentionOptions = {},
): OperatorAttentionBuildResult {
  if (source.source_health === "unavailable") {
    throw new OperatorAttentionUnavailableError(
      source.source_health_reason ?? "manager projection source is unavailable",
    );
  }
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const evaluatedIso = evaluatedAt.toISOString();
  const desk = buildDailyDeskResponse(source.daily_desk, { now: evaluatedAt, today: options.today });
  const candidates = [...compatibilityCandidates(desk.lanes.flatMap((lane) => lane.rows)), ...(source.candidates ?? [])];
  const suppressions: OperatorAttentionSuppression[] = [];
  const admitted: OperatorAttentionItem[] = [];
  const identities = new Set<string>();
  const familyLatest = latestFamilyMembers(candidates);
  const ownerAdmissions = new Map<string, number>();
  const capabilities = capabilityMap(options.capabilities);

  for (const candidate of [...candidates].sort(compareCandidates)) {
    const suppression = globalSuppression(candidate, identities, familyLatest, evaluatedAt, capabilities);
    if (suppression) {
      suppressions.push({ ref: candidate.ref, ...suppression });
      continue;
    }
    identities.add(candidate.ref);

    const band = classifyBand(candidate);
    if (!band) {
      suppressions.push({ ref: candidate.ref, reason: "unlinked_decision", detail: "decision request is not linked to manager-owned waiting work" });
      continue;
    }

    if (candidate.source_kind === "report") {
      const used = ownerAdmissions.get(candidate.owner) ?? 0;
      if (used >= OWNER_DAILY_BUDGET) {
        suppressions.push({ ref: candidate.ref, reason: "owner_budget_exhausted", detail: `owner ${candidate.owner} already has ${OWNER_DAILY_BUDGET} admitted reports` });
        continue;
      }
      ownerAdmissions.set(candidate.owner, used + 1);
    }

    admitted.push(toItem(candidate, band, desk.freshness_state, capabilities));
  }

  const ordered = admitted.sort(compareItems);
  const bands = {
    primary: ordered.filter((item) => item.band === "primary").slice(0, OPERATOR_ATTENTION_CAPS.primary),
    next: ordered.filter((item) => item.band === "next").slice(0, OPERATOR_ATTENTION_CAPS.next),
    waiting: ordered.filter((item) => item.band === "waiting").slice(0, OPERATOR_ATTENTION_CAPS.waiting),
  };
  for (const item of ordered) {
    const visible = bands[item.band].some((row) => row.ref === item.ref);
    if (!visible) suppressions.push({ ref: item.ref, reason: "over_budget", detail: `${item.band} band visible cap is ${OPERATOR_ATTENTION_CAPS[item.band]}` });
  }
  const visibleRows = [...bands.primary, ...bands.next, ...bands.waiting];
  const sourceHealth = source.source_health ?? "current";
  const sourceCursor = hash([
    `health:${sourceHealth}`,
    `changes:${Math.max(0, Math.trunc(source.changes_count ?? 0))}`,
    ...[...candidates].sort((a, b) => a.ref.localeCompare(b.ref)).map((row) => [
      row.ref, row.source_as_of, row.lifecycle, row.environment, row.audience,
      row.attention_kind, row.requested_by_ref ?? "", row.family_ref ?? "", row.supersedes_ref ?? "",
    ].join("\u0000")),
  ].join("\n"));
  const freshnessState: DailyDeskFreshnessState = sourceHealth === "current" ? desk.freshness_state : "degraded";
  const response: OperatorAttentionResponse = {
    ok: true,
    schema_version: OPERATOR_ATTENTION_SCHEMA_VERSION,
    authority: { owner: "manager", projection: "operator_attention", state: "authoritative", source_cursor: sourceCursor },
    evaluated_at: evaluatedIso,
    source_as_of: visibleRows.reduce<string | null>((latest, row) => !latest || row.source_as_of > latest ? row.source_as_of : latest, null),
    freshness_state: freshnessState,
    freshness_reason: source.source_health_reason ?? (freshnessState === "current"
      ? "all admitted rows are current manager projections"
      : "one or more manager projection sources are degraded"),
    bands,
    counts: {
      primary: bands.primary.length,
      next: bands.next.length,
      waiting: bands.waiting.length,
      suppressed: suppressions.length,
      overflow: suppressions.filter((row) => row.reason === "over_budget").length,
    },
    changes_count: Math.max(0, Math.trunc(source.changes_count ?? 0)),
    capabilities,
    max_payload_bytes: OPERATOR_ATTENTION_MAX_BYTES,
    payload_bytes: 0,
  };
  response.payload_bytes = stablePayloadBytes(response);
  if (response.payload_bytes > OPERATOR_ATTENTION_MAX_BYTES) throw new Error(`operator_attention_payload_exceeds_${OPERATOR_ATTENTION_MAX_BYTES}_bytes`);
  return { response, suppressions };
}

function compatibilityCandidates(rows: DailyDeskRow[]): OperatorAttentionCandidate[] {
  return rows.map((row) => ({
    ref: row.id,
    title: row.title,
    owner: row.owner,
    audience: row.audience,
    environment: row.environment,
    authority_owner: row.authority.owner,
    canonical_url: row.canonical_url,
    lifecycle: row.effective_lifecycle,
    source_as_of: row.source_as_of,
    meaningful_at: row.review_next?.meaningful_at ?? row.source_as_of,
    due_at: null,
    expires_at: row.lane === "review_next" ? row.review_next?.meaningful_at ?? row.source_as_of : row.source_as_of,
    priority: row.review_next?.attention_priority ?? 500,
    source_kind: row.lane === "today" ? "task" : row.lane === "review_next" ? "report" : row.lane === "needs_response" ? "inbox" : "checkin",
    attention_kind: row.lane === "today" ? "due" : row.lane === "review_next" ? reviewAttentionKind(row) : row.lane === "needs_response" ? "read" : "waiting",
    requested_by_waiting: false,
    actions: row.permitted_actions,
    admission_code: row.admission_reason.code,
    admission_detail: row.admission_reason.detail,
  }));
}

function reviewAttentionKind(row: DailyDeskRow): OperatorAttentionCandidate["attention_kind"] {
  const state = row.review_next?.attention_state.toLowerCase();
  if (state === "decide" || state === "decision") return "decide";
  if (state === "answer" || state === "needs_answer") return "answer";
  if (state === "approve" || state === "approval" || state === "needs_approval") return "approve";
  return "read";
}

function globalSuppression(
  row: OperatorAttentionCandidate,
  identities: Set<string>,
  familyLatest: Map<string, string>,
  evaluatedAt: Date,
  capabilities: OperatorAttentionResponse["capabilities"],
): { reason: OperatorAttentionSuppressionCode; detail: string } | null {
  if (identities.has(row.ref)) return { reason: "duplicate_identity", detail: "candidate identity was already evaluated" };
  if (!row.authority_owner || !row.canonical_url) return { reason: "no_authority", detail: "authority owner and canonical URL are required" };
  if (row.audience !== "operator") return { reason: "not_operator", detail: "candidate audience is not operator" };
  if (row.environment !== "production") return { reason: "test_material", detail: "candidate environment is not production" };
  if (TERMINAL.has(row.lifecycle)) return { reason: row.lifecycle === "superseded" ? "superseded" : "terminal", detail: `candidate lifecycle is ${row.lifecycle}` };
  if (row.family_ref && familyLatest.get(row.family_ref) !== row.ref) return { reason: "superseded", detail: "a newer family member is authoritative" };
  if (row.snoozed) return { reason: "snoozed", detail: "candidate is snoozed" };
  if (row.dismissed) return { reason: "dismissed", detail: "candidate was dismissed by the operator" };
  if (!row.due_at && !row.expires_at && !row.operator_pinned) return { reason: "unbounded_request", detail: "candidate has no due, expiry, or operator pin" };
  const sourceMs = Date.parse(row.source_as_of);
  if (!Number.isFinite(sourceMs) || (evaluatedAt.getTime() - sourceMs > 7 * 86_400_000 && !row.last_known && !row.degraded)) {
    return { reason: "stale_unlabeled", detail: "source is outside its freshness budget without last-known labeling" };
  }
  if (row.actions.length > 0 && row.actions.every((action) => capabilities[action].startsWith("disabled:"))) {
    return { reason: "unsupported_action", detail: "all requested actions are unavailable in this snapshot" };
  }
  return null;
}

function classifyBand(row: OperatorAttentionCandidate): OperatorAttentionBand | null {
  if ((row.manager_derived || row.operator_pinned) && row.attention_kind === "urgent") return "primary";
  if (row.attention_kind === "waiting" || row.source_kind === "checkin") return "waiting";
  if (DECISIONS.has(row.attention_kind)) return row.requested_by_waiting ? "next" : null;
  return "next";
}

function toItem(
  row: OperatorAttentionCandidate,
  band: OperatorAttentionBand,
  freshnessState: DailyDeskFreshnessState,
  capabilities: OperatorAttentionResponse["capabilities"],
): OperatorAttentionItem {
  const rankBand = band === "primary" ? 1 : band === "waiting" ? 7 : row.attention_kind === "due" ? 3 : 4;
  const cursor = hash([row.ref, row.source_as_of, row.lifecycle, row.canonical_url, rankBand].join("\u0000"));
  return {
    ref: bounded(row.ref, 256), title: bounded(row.title.trim(), 256), owner: bounded(row.owner, 128),
    authority: { owner: bounded(row.authority_owner, 128), source_cursor: cursor }, audience: "operator",
    environment: "production", band, rank_band: rankBand, canonical_url: bounded(row.canonical_url, 1024),
    lifecycle: bounded(row.lifecycle, 128), source_kind: row.source_kind, source_as_of: row.source_as_of,
    meaningful_at: row.meaningful_at, due_at: row.due_at ?? null, expires_at: row.expires_at ?? null,
    freshness_state: row.degraded ? "degraded" : freshnessState,
    permitted_actions: [...new Set(row.actions.filter((action) => capabilities[action] === "available"))],
    admission_reason: { code: bounded(row.admission_code, 128), detail: bounded(row.admission_detail, 240) },
  };
}

function compareCandidates(a: OperatorAttentionCandidate, b: OperatorAttentionCandidate): number {
  return candidateBandRank(a) - candidateBandRank(b)
    || timestampRank(a.due_at ?? a.expires_at ?? null) - timestampRank(b.due_at ?? b.expires_at ?? null)
    || (a.priority ?? 999) - (b.priority ?? 999)
    || a.meaningful_at.localeCompare(b.meaningful_at)
    || a.ref.localeCompare(b.ref);
}

function candidateBandRank(row: OperatorAttentionCandidate): number {
  if ((row.manager_derived || row.operator_pinned) && row.attention_kind === "urgent") return 1;
  if (DECISIONS.has(row.attention_kind) && row.requested_by_waiting) return 2;
  if (row.attention_kind === "due") return 3;
  if (row.attention_kind === "waiting" || row.source_kind === "checkin") return 7;
  return 4;
}

function compareItems(a: OperatorAttentionItem, b: OperatorAttentionItem): number {
  return a.rank_band - b.rank_band
    || timestampRank(a.due_at ?? a.expires_at) - timestampRank(b.due_at ?? b.expires_at)
    || (a.meaningful_at.localeCompare(b.meaningful_at))
    || a.ref.localeCompare(b.ref);
}

function latestFamilyMembers(rows: OperatorAttentionCandidate[]): Map<string, string> {
  const latest = new Map<string, OperatorAttentionCandidate>();
  for (const row of rows) {
    if (!row.family_ref) continue;
    const current = latest.get(row.family_ref);
    if (!current || row.source_as_of > current.source_as_of || (row.source_as_of === current.source_as_of && row.ref > current.ref)) latest.set(row.family_ref, row);
  }
  return new Map([...latest].map(([familyRef, row]) => [familyRef, row.ref]));
}

function capabilityMap(overrides: BuildOperatorAttentionOptions["capabilities"]): OperatorAttentionResponse["capabilities"] {
  return Object.fromEntries(KNOWN_ACTIONS.map((action) => [action, overrides?.[action] ?? "available"])) as OperatorAttentionResponse["capabilities"];
}

function timestampRank(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function hash(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function bounded(value: string, max: number): string { return value.slice(0, max); }

function stablePayloadBytes(response: OperatorAttentionResponse): number {
  let previous = -1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = Buffer.byteLength(JSON.stringify(response), "utf8");
    response.payload_bytes = next;
    if (next === previous) return next;
    previous = next;
  }
  return Buffer.byteLength(JSON.stringify(response), "utf8");
}

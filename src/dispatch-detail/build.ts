import path from "path";

import type { DispatchReadRow } from "../dispatch-scheduler/read-model.js";
import type { PromotionInput } from "../dispatch-scheduler/types.js";
import { redactSecrets } from "../harness/transient-errors.js";

export const DISPATCH_DETAIL_SCHEMA_VERSION = "dispatch-detail.v1" as const;
const BODY_EXCERPT_LIMIT = 1200;

export type DispatchDetailTimelineEvent = {
  at: string;
  label: string;
  detail: string | null;
};

export type DispatchDetailLinkedArtifact = {
  id: string;
  report_id: string | null;
  basename: string | null;
  path_redacted: string | null;
  status: "available" | "missing" | "unknown";
  source: "result_json" | "artifact_path" | "unknown";
};

export type DispatchDetailLastError = {
  kind: string | null;
  detail: string | null;
};

export type DispatchDetailPayload = {
  dispatch_id: string;
  query_id: string | null;
  title: string;
  agent_id: string;
  status: string;
  effective_state: string;
  body_excerpt: string | null;
  message_excerpt: string | null;
  args_excerpt: string | null;
  write_scope: string[];
  status_timeline: DispatchDetailTimelineEvent[];
  last_error: DispatchDetailLastError | null;
  linked_artifact: DispatchDetailLinkedArtifact | null;
  promotion: DispatchReadRow["promotion"];
  needs_input: DispatchReadRow["needs_input"];
  recovery: DispatchReadRow["recovery"];
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type DispatchDetailResponse = {
  ok: true;
  schema_version: typeof DISPATCH_DETAIL_SCHEMA_VERSION;
  generated_at: string;
  dispatch: DispatchDetailPayload;
};

export type DispatchDetailSourceRow = {
  dispatch_phid: string;
  body_markdown: string | null;
  bounce_history_json: string | null;
  result_json: string | null;
  artifact_path: string | null;
  promotion_input_json: string | null;
};

export function buildDispatchDetailResponse(
  summary: DispatchReadRow,
  source: DispatchDetailSourceRow,
  now: string = new Date().toISOString(),
): DispatchDetailResponse {
  const promotionInput = parsePromotionInput(source.promotion_input_json);
  const bodyExcerpt = redactDispatchBodyExcerpt(source.body_markdown);
  const linkedArtifact = deriveLinkedArtifact(summary, source);
  return {
    ok: true,
    schema_version: DISPATCH_DETAIL_SCHEMA_VERSION,
    generated_at: now,
    dispatch: {
      dispatch_id: summary.dispatch_id,
      query_id: summary.query_id,
      title: summary.title,
      agent_id: summary.agent_id,
      status: summary.status,
      effective_state: summary.effective_state,
      body_excerpt: bodyExcerpt,
      message_excerpt: bodyExcerpt,
      args_excerpt: bodyExcerpt,
      write_scope: deriveWriteScope(promotionInput),
      status_timeline: buildStatusTimeline(summary, source),
      last_error: deriveLastError(summary),
      linked_artifact: linkedArtifact,
      promotion: summary.promotion,
      needs_input: summary.needs_input,
      recovery: summary.recovery,
      queued_at: summary.queued_at,
      started_at: summary.in_flight_at,
      completed_at: summary.completed_at,
      updated_at: summary.updated_at,
    },
  };
}

export function deriveWriteScope(promotionInput: PromotionInput | null): string[] {
  if (!promotionInput?.repo) return [];
  const repo = promotionInput.repo.trim();
  if (!repo) return [];
  const scope = [repo];
  if (promotionInput.branch?.trim()) {
    scope.push(`${repo}@${promotionInput.branch.trim()}`);
  }
  return scope;
}

export function buildStatusTimeline(
  summary: DispatchReadRow,
  source: DispatchDetailSourceRow,
): DispatchDetailTimelineEvent[] {
  const events: DispatchDetailTimelineEvent[] = [];
  if (summary.queued_at) {
    events.push({ at: summary.queued_at, label: "Queued", detail: null });
  }
  if (summary.in_flight_at) {
    events.push({ at: summary.in_flight_at, label: "In flight", detail: null });
  }
  for (const entry of parseJsonArray(source.bounce_history_json)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const at = stringOrNull(record.ts) ?? summary.updated_at;
    events.push({
      at,
      label: "Bounced",
      detail: stringOrNull(record.message) ?? stringOrNull(record.kind),
    });
  }
  for (const entry of summary.needs_input.history) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const at =
      stringOrNull(record.created_at) ??
      stringOrNull(record.at) ??
      summary.updated_at;
    events.push({
      at,
      label: "Needs input",
      detail: stringOrNull(record.type) ?? stringOrNull(record.question),
    });
  }
  if (summary.completed_at) {
    const terminalLabel = summary.status === "failed" ? "Failed" : "Completed";
    events.push({
      at: summary.completed_at,
      label: terminalLabel,
      detail: summary.status === "failed" ? summary.failure_detail ?? summary.failure_kind : null,
    });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function deriveLastError(summary: DispatchReadRow): DispatchDetailLastError | null {
  if (!summary.failure_kind && !summary.failure_detail) return null;
  return {
    kind: summary.failure_kind,
    detail: summary.failure_detail,
  };
}

export function deriveLinkedArtifact(
  summary: DispatchReadRow,
  source: DispatchDetailSourceRow,
): DispatchDetailLinkedArtifact | null {
  const parsed = parseJsonObject(source.result_json);
  const resultPath = typeof parsed?.artifact_path === "string" ? parsed.artifact_path : null;
  const artifactPath = resultPath ?? source.artifact_path ?? summary.evidence.artifact_path ?? null;
  if (!artifactPath) return null;
  const sourceKind = resultPath ? "result_json" : source.artifact_path ? "artifact_path" : "unknown";
  const promotionInput = parsePromotionInput(source.promotion_input_json);
  return {
    id: reportIdFromResult(parsed) ?? `dispatch:${summary.dispatch_id}`,
    report_id: reportIdFromResult(parsed) ?? summary.evidence.report_id ?? null,
    basename: path.basename(artifactPath),
    path_redacted: redactLocalPath(artifactPath, promotionInput?.repo),
    status: artifactPath ? "available" : "unknown",
    source: sourceKind,
  };
}

export function redactDispatchBodyExcerpt(body: string | null | undefined): string | null {
  if (!body?.trim()) return null;
  const trimmed = body.length > BODY_EXCERPT_LIMIT ? `${body.slice(0, BODY_EXCERPT_LIMIT)}…` : body;
  return redactSecrets(trimmed.replace(/\/Users\/[^\s)\]]+/g, "[local-path]"));
}

export function redactLocalPath(value: string, repoRoot?: string | null): string {
  const repo = repoRoot?.trim();
  if (repo && value.startsWith(repo)) {
    return `[local-path]${value.slice(repo.length)}`;
  }
  return value.replace(/^\/Users\/[^/\s]+/, "[local-path]");
}

function parsePromotionInput(raw: string | null | undefined): PromotionInput | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const repo = stringOrNull(parsed.repo);
  const branch = stringOrNull(parsed.branch);
  if (!repo || !branch) return null;
  return {
    repo,
    branch,
    base: stringOrNull(parsed.base) ?? "main",
    remote: stringOrNull(parsed.remote) ?? "origin",
    promotion_skip_reason: stringOrNull(parsed.promotion_skip_reason),
  };
}

function reportIdFromResult(parsed: Record<string, unknown> | null): string | null {
  if (typeof parsed?.report_id === "string" && parsed.report_id.trim()) return parsed.report_id.trim();
  if (typeof parsed?.reportId === "string" && parsed.reportId.trim()) return parsed.reportId.trim();
  return null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseJsonOrNull(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  const parsed = parseJsonOrNull(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonOrNull(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

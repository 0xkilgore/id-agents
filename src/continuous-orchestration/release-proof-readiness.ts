import type { DbAdapter } from "../db/db-adapter.js";
import { readOrchestrationHealthProjection } from "./health-projection.js";

export type ReleaseProofReadinessState = "ready" | "not_ready";
export type EvidenceState = "present" | "empty" | "stale" | "error";
export type InfraWarningState = "clear" | "warning" | "error";
export type InfraWarningSource = "none" | "readiness_loader" | "orchestration_health_projection";
export type LinkState = "present" | "missing";
export type ReleaseProofNextOwnerLane = "none" | "chris" | "operator" | "release-engineering";
export type ReleaseProofSystemHealthState = "clear" | "warning" | "critical" | "unknown";
export type ReleaseProofReasonCode =
  | "loader_error"
  | "feedback_evidence_empty"
  | "feedback_evidence_stale"
  | "infra_warning"
  | "source_links_missing"
  | "source_links_unsafe"
  | "feedback_source_link_null"
  | "feedback_source_link_redacted"
  | "feedback_source_link_unsupported"
  | "generated_artifacts_empty"
  | "generated_artifact_source_link_missing"
  | "generated_artifact_unavailable"
  | "generated_artifact_stale";

export interface ReleaseProofFeedbackEvidence {
  id: string;
  kind: string;
  observed_at: string;
  source_link: string | null;
  source_link_status?: "present" | "derived" | "redacted" | "unsupported" | "unavailable";
  source_link_reason?: string | null;
  artifact_id: string | null;
  summary: string | null;
}

export interface ReleaseProofArtifactPointer {
  artifact_id: string;
  path: string | null;
  title: string | null;
  produced_at: string;
  source_link: string | null;
  availability: string | null;
}

export interface ReleaseProofSourceLink {
  label: string;
  href: string;
  source: "backlog" | "feedback" | "artifact";
}

export interface ReleaseProofReadinessInput {
  generated_at: string;
  project: string;
  feedback_evidence: ReleaseProofFeedbackEvidence[];
  infra_warnings: string[];
  source_links: ReleaseProofSourceLink[];
  generated_artifacts: ReleaseProofArtifactPointer[];
  system_health?: ReleaseProofSystemHealthInput;
  stale_after_ms?: number;
  load_error?: string | null;
}

export interface ReleaseProofSystemHealthInput {
  disk_state?: "ok" | "warn" | "critical" | "unknown" | null;
  build_behind_origin?: boolean | null;
  deploy_blockers?: string[];
}

export interface ReleaseProofReadinessResponse {
  schema_version: "release_proof.readiness.v1";
  generated_at: string;
  project: string;
  release_readiness: ReleaseProofReadinessState;
  chris_readable_release_ready: "READY" | "NOT READY";
  summary: string;
  feedback_freshness: {
    state: EvidenceState;
    latest_at: string | null;
    stale_after_ms: number;
    stale: boolean;
    reason: string | null;
  };
  infra_warning: {
    state: InfraWarningState;
    count: number;
    requires_operator_review: boolean;
    source: InfraWarningSource;
    action: string | null;
  };
  source_link_state: {
    state: LinkState;
    safe_count: number;
    unsafe_count: number;
    total_count: number;
  };
  system_health: {
    state: ReleaseProofSystemHealthState;
    disk: {
      state: "ok" | "warn" | "critical" | "unknown";
      disk_critical: boolean;
    };
    build: {
      build_behind_origin: boolean | null;
    };
    deploy_blockers: {
      blocked: boolean;
      reasons: string[];
    };
  };
  next_owner: {
    lane: ReleaseProofNextOwnerLane;
    action: string | null;
    reason: string | null;
    candidates: Array<{
      lane: ReleaseProofNextOwnerLane;
      reason: "feedback_freshness" | "infra_warning" | "source_link_state" | "artifact_state" | "loader_error";
      action: string;
    }>;
  };
  feedback_evidence: {
    state: EvidenceState;
    count: number;
    latest_at: string | null;
    stale_after_ms: number;
    items: ReleaseProofFeedbackEvidence[];
  };
  infra_warnings: {
    state: InfraWarningState;
    count: number;
    source: InfraWarningSource;
    action: string | null;
    items: string[];
  };
  sources: {
    state: LinkState;
    counts: {
      safe: number;
      unsafe: number;
      total: number;
    };
    links: ReleaseProofSourceLink[];
  };
  generated_artifacts: {
    state: LinkState;
    count: number;
    items: ReleaseProofArtifactPointer[];
  };
  reason_codes: {
    loader_error: ReleaseProofReasonCode[];
    feedback_freshness: ReleaseProofReasonCode[];
    infra_warning: ReleaseProofReasonCode[];
    source_link_state: ReleaseProofReasonCode[];
    artifact_state: ReleaseProofReasonCode[];
  };
  stale_reasons: string[];
  error_reasons: string[];
  missing_reasons: string[];
}

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function buildReleaseProofReadiness(
  input: ReleaseProofReadinessInput,
): ReleaseProofReadinessResponse {
  const staleAfterMs = Math.max(1, Math.floor(input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS));
  const staleReasons: string[] = [];
  const errorReasons: string[] = [];
  const missingReasons: string[] = [];
  const reasonCodes: ReleaseProofReadinessResponse["reason_codes"] = {
    loader_error: [],
    feedback_freshness: [],
    infra_warning: [],
    source_link_state: [],
    artifact_state: [],
  };
  const systemHealth = buildSystemHealth(input.system_health);

  if (input.load_error) {
    errorReasons.push(input.load_error);
    reasonCodes.loader_error.push("loader_error");
  }

  const latestFeedbackAt = latestIso(input.feedback_evidence.map((item) => item.observed_at));
  let feedbackState: EvidenceState = "present";
  if (input.load_error) {
    feedbackState = "error";
  } else if (input.feedback_evidence.length === 0) {
    feedbackState = "empty";
    missingReasons.push("no feedback evidence has been recorded for this release proof");
    reasonCodes.feedback_freshness.push("feedback_evidence_empty");
  } else if (latestFeedbackAt && Date.parse(input.generated_at) - Date.parse(latestFeedbackAt) > staleAfterMs) {
    feedbackState = "stale";
    staleReasons.push(`latest feedback evidence is older than ${Math.round(staleAfterMs / 3_600_000)}h`);
    reasonCodes.feedback_freshness.push("feedback_evidence_stale");
  }

  const artifactPointers = input.generated_artifacts;
  if (artifactPointers.length === 0) {
    missingReasons.push("no generated release proof artifacts are registered");
    reasonCodes.artifact_state.push("generated_artifacts_empty");
  }
  const missingArtifactSources = artifactPointers.filter((item) => !isSafeSourceToken(item.source_link));
  if (missingArtifactSources.length > 0) {
    missingReasons.push("one or more generated artifacts are missing safe source links");
    reasonCodes.artifact_state.push("generated_artifact_source_link_missing");
  }
  const unavailableArtifacts = artifactPointers.filter((item) => item.availability !== "present");
  if (unavailableArtifacts.length > 0) {
    missingReasons.push("one or more generated proof artifacts are not present");
    reasonCodes.artifact_state.push("generated_artifact_unavailable");
  }
  const staleArtifacts = artifactPointers.filter((item) =>
    Number.isFinite(Date.parse(item.produced_at)) &&
    Date.parse(input.generated_at) - Date.parse(item.produced_at) > staleAfterMs
  );
  if (staleArtifacts.length > 0) {
    staleReasons.push(`one or more generated artifacts are older than ${Math.round(staleAfterMs / 3_600_000)}h`);
    reasonCodes.artifact_state.push("generated_artifact_stale");
  }

  const invalidSourceLinks = input.source_links.filter((item) => !isSafeSourceHref(item.href));
  if (invalidSourceLinks.length > 0) {
    missingReasons.push("one or more source links are redacted or unsupported");
    reasonCodes.source_link_state.push("source_links_unsafe");
  }
  const sourceLinks = dedupeSourceLinks(input.source_links);
  const sourceLinkCounts = {
    safe: sourceLinks.length,
    unsafe: invalidSourceLinks.length,
    total: input.source_links.length,
  };
  if (sourceLinks.length === 0) {
    missingReasons.push("no source links are attached to the release proof");
    reasonCodes.source_link_state.push("source_links_missing");
  }

  const feedbackMissingSources = input.feedback_evidence.filter((item) => !isSafeSourceHref(item.source_link));
  const feedbackNullSources = feedbackMissingSources.filter((item) => !item.source_link?.trim());
  const feedbackRedactedSources = feedbackMissingSources.filter((item) => {
    const source = item.source_link?.trim();
    return source ? isRedactedSource(source) : false;
  });
  const feedbackUnsupportedSources = feedbackMissingSources.filter((item) => {
    const source = item.source_link?.trim();
    return source ? !isRedactedSource(source) : false;
  });
  if (feedbackNullSources.length > 0) {
    missingReasons.push("one or more feedback evidence items have null source_link");
    reasonCodes.source_link_state.push("feedback_source_link_null");
  }
  if (feedbackRedactedSources.length > 0) {
    missingReasons.push("one or more feedback evidence items have redacted source_link");
    reasonCodes.source_link_state.push("feedback_source_link_redacted");
  }
  if (feedbackUnsupportedSources.length > 0) {
    missingReasons.push("one or more feedback evidence items have unsupported source links");
    reasonCodes.source_link_state.push("feedback_source_link_unsupported");
  }

  const infraState: InfraWarningState = input.load_error
    ? "error"
    : input.infra_warnings.length > 0
      ? "warning"
      : "clear";
  const infraSource: InfraWarningSource = input.load_error
    ? "readiness_loader"
    : input.infra_warnings.length > 0
      ? "orchestration_health_projection"
      : "none";
  const infraAction = input.load_error
    ? "restore release-proof data sources and retry readiness"
    : input.infra_warnings.length > 0
      ? "review orchestration health and resolve infra warnings before release proof sign-off"
      : null;
  if (infraState === "warning") reasonCodes.infra_warning.push("infra_warning");
  const nextOwner = deriveNextOwner({
    feedbackState,
    infraState,
    sourceLinks,
    artifactPointers,
    missingArtifactSources,
    unavailableArtifacts,
    feedbackMissingSources,
    staleReasons,
    errorReasons,
    missingReasons,
    infraAction,
  });

  const ready =
    feedbackState === "present" &&
    infraState === "clear" &&
    sourceLinks.length > 0 &&
    artifactPointers.length > 0 &&
    missingArtifactSources.length === 0 &&
    unavailableArtifacts.length === 0 &&
    feedbackMissingSources.length === 0 &&
    staleReasons.length === 0 &&
    errorReasons.length === 0 &&
    missingReasons.length === 0;

  return {
    schema_version: "release_proof.readiness.v1",
    generated_at: input.generated_at,
    project: input.project,
    release_readiness: ready ? "ready" : "not_ready",
    chris_readable_release_ready: ready ? "READY" : "NOT READY",
    summary: ready
      ? "Release proof is ready for Chris: feedback evidence, source links, generated artifacts, and infra state are clean."
      : summaryForNotReady({ feedbackState, infraState, staleReasons, errorReasons, missingReasons }),
    feedback_freshness: {
      state: feedbackState,
      latest_at: latestFeedbackAt,
      stale_after_ms: staleAfterMs,
      stale: feedbackState === "stale",
      reason: feedbackState === "stale" ? staleReasons.find((reason) => reason.includes("feedback evidence")) ?? null : null,
    },
    infra_warning: {
      state: infraState,
      count: input.infra_warnings.length,
      requires_operator_review: infraState === "warning",
      source: infraSource,
      action: infraAction,
    },
    source_link_state: {
      state: sourceLinks.length > 0 ? "present" : "missing",
      safe_count: sourceLinkCounts.safe,
      unsafe_count: sourceLinkCounts.unsafe,
      total_count: sourceLinkCounts.total,
    },
    system_health: systemHealth,
    next_owner: nextOwner,
    feedback_evidence: {
      state: feedbackState,
      count: input.feedback_evidence.length,
      latest_at: latestFeedbackAt,
      stale_after_ms: staleAfterMs,
      items: input.feedback_evidence,
    },
    infra_warnings: {
      state: infraState,
      count: input.infra_warnings.length,
      source: infraSource,
      action: infraAction,
      items: input.infra_warnings,
    },
    sources: {
      state: sourceLinks.length > 0 ? "present" : "missing",
      counts: sourceLinkCounts,
      links: sourceLinks,
    },
    generated_artifacts: {
      state: artifactPointers.length > 0 && missingArtifactSources.length === 0 && unavailableArtifacts.length === 0 ? "present" : "missing",
      count: artifactPointers.length,
      items: artifactPointers,
    },
    reason_codes: reasonCodes,
    stale_reasons: staleReasons,
    error_reasons: errorReasons,
    missing_reasons: missingReasons,
  };
}

function buildSystemHealth(input: ReleaseProofSystemHealthInput | undefined): ReleaseProofReadinessResponse["system_health"] {
  const diskState = input?.disk_state ?? "ok";
  const deployBlockers = input?.deploy_blockers?.filter((reason) => reason.trim() !== "") ?? [];
  const buildBehindOrigin = input?.build_behind_origin ?? null;
  const state: ReleaseProofSystemHealthState =
    diskState === "critical" || deployBlockers.length > 0
      ? "critical"
      : diskState === "warn" || buildBehindOrigin === true
        ? "warning"
        : diskState === "unknown"
          ? "unknown"
          : "clear";

  return {
    state,
    disk: {
      state: diskState,
      disk_critical: diskState === "critical",
    },
    build: {
      build_behind_origin: buildBehindOrigin,
    },
    deploy_blockers: {
      blocked: deployBlockers.length > 0,
      reasons: deployBlockers,
    },
  };
}

export async function readReleaseProofReadiness(
  adapter: DbAdapter,
  opts: { teamId?: string; project?: string; now?: string; staleAfterMs?: number } = {},
): Promise<ReleaseProofReadinessResponse> {
  const teamId = opts.teamId ?? "default";
  const project = opts.project ?? "kapelle";
  const generatedAt = opts.now ?? new Date().toISOString();

  try {
    const [feedback, backlogSources, artifacts, health] = await Promise.all([
      readFeedbackEvidence(adapter, project),
      readBacklogSourceLinks(adapter, teamId, project),
      readGeneratedArtifacts(adapter, project),
      readOrchestrationHealthProjection(adapter, teamId),
    ]);

    const infraWarnings: string[] = [];
    if (health.orchestration_loop.severity !== "ok") {
      infraWarnings.push(formatOrchestrationLoopInfraWarning(health));
    }
    for (const item of health.blockers.needs_clarification.items) {
      if (!item.needs_chris) infraWarnings.push(`clarification blocker ${item.dispatch_phid}: ${item.reason}`);
    }
    for (const item of health.blockers.promotion.items) {
      infraWarnings.push(`promotion blocker ${item.dispatch_phid}: ${item.reason}`);
    }

    return buildReleaseProofReadiness({
      generated_at: generatedAt,
      project,
      feedback_evidence: feedback,
      infra_warnings: infraWarnings,
      source_links: [
        ...backlogSources,
        ...feedback.flatMap((item) =>
          isSafeSourceHref(item.source_link)
            ? [{ label: `feedback:${item.id}`, href: item.source_link, source: "feedback" as const }]
            : [],
        ),
        ...artifacts.flatMap((item) =>
          isSafeSourceHref(item.source_link)
            ? [{ label: `artifact:${item.artifact_id}`, href: item.source_link, source: "artifact" as const }]
            : [],
        ),
      ],
      generated_artifacts: artifacts,
      stale_after_ms: opts.staleAfterMs,
    });
  } catch (err) {
    return buildReleaseProofReadiness({
      generated_at: generatedAt,
      project,
      feedback_evidence: [],
      infra_warnings: [],
      source_links: [],
      generated_artifacts: [],
      stale_after_ms: opts.staleAfterMs,
      load_error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function readFeedbackEvidence(adapter: DbAdapter, project: string): Promise<ReleaseProofFeedbackEvidence[]> {
  const like = `%${project}%`;
  const { rows } = await adapter.query<{
    op_id: number;
    artifact_id: string;
    op_type: string;
    actor: string;
    ts: string;
    payload_json: string | null;
    source_link: string | null;
    artifact_availability: string | null;
  }>(
    `SELECT o.op_id, o.artifact_id, o.op_type, o.actor, o.ts, o.payload_json, o.source_link,
            a.availability AS artifact_availability
       FROM artifact_operations o
       LEFT JOIN artifacts a ON a.artifact_id = o.artifact_id
      WHERE o.op_type IN ('comment_recorded', 'comment_routed', 'approve', 'reject', 'ship_attempted', 'ship_blocked')
        AND (
          COALESCE(o.source_link, '') LIKE ?
          OR COALESCE(o.payload_json, '') LIKE ?
          OR o.artifact_id IN (
            SELECT artifact_id FROM artifacts
             WHERE COALESCE(project_ref, '') = ?
                OR COALESCE(title, '') LIKE ?
                OR COALESCE(abs_path, '') LIKE ?
          )
        )
      ORDER BY o.ts DESC, o.op_id DESC
      LIMIT 20`,
    [like, like, project, like, like],
  );

  return rows.map((row) => {
    const source = resolveFeedbackOperationSourceLink({
      opId: row.op_id,
      artifactId: row.artifact_id,
      sourceLink: row.source_link,
      artifactAvailability: row.artifact_availability,
    });
    return {
      id: `op:${row.op_id}`,
      kind: row.op_type,
      observed_at: row.ts,
      source_link: source.source_link,
      source_link_status: source.status,
      source_link_reason: source.reason,
      artifact_id: row.artifact_id,
      summary: summarizePayload(row.payload_json) ?? `${row.op_type} by ${row.actor}`,
    };
  });
}

function resolveFeedbackOperationSourceLink(input: {
  opId: number;
  artifactId: string | null;
  sourceLink: string | null;
  artifactAvailability: string | null;
}): {
  source_link: string | null;
  status: ReleaseProofFeedbackEvidence["source_link_status"];
  reason: string | null;
} {
  const stored = input.sourceLink?.trim() ?? "";
  if (stored) {
    if (isSafeSourceHref(stored)) return { source_link: stored, status: "present", reason: null };
    if (isRedactedSource(stored)) {
      return { source_link: null, status: "redacted", reason: "stored source link is redacted" };
    }
    return { source_link: null, status: "unsupported", reason: "stored source link uses an unsupported or local scheme" };
  }

  if (!input.artifactId) {
    return { source_link: null, status: "unavailable", reason: "operation has no artifact context" };
  }
  if (input.artifactAvailability === "present") {
    return {
      source_link: stableArtifactOperationSourceLink(input.artifactId, input.opId),
      status: "derived",
      reason: "derived from durable artifact operation",
    };
  }
  if (input.artifactAvailability === "missing") {
    return { source_link: null, status: "unavailable", reason: "artifact source is marked missing" };
  }
  return { source_link: null, status: "unavailable", reason: "artifact source availability is unknown" };
}

async function readBacklogSourceLinks(
  adapter: DbAdapter,
  teamId: string,
  project: string,
): Promise<ReleaseProofSourceLink[]> {
  const like = `%${project}%`;
  const { rows } = await adapter.query<{ item_id: string; source_refs_json: string }>(
    `SELECT item_id, source_refs_json
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND (
          COALESCE(track, '') LIKE ?
          OR COALESCE(title, '') LIKE ?
          OR COALESCE(source_refs_json, '') LIKE ?
        )
      ORDER BY updated_at DESC
      LIMIT 25`,
    [teamId, like, like, like],
  );
  return rows.flatMap((row) => {
    const refs = parseStringArray(row.source_refs_json);
    return refs.map((href, index) => ({
      label: `${row.item_id}:source:${index + 1}`,
      href,
      source: "backlog" as const,
    }));
  });
}

async function readGeneratedArtifacts(adapter: DbAdapter, project: string): Promise<ReleaseProofArtifactPointer[]> {
  const like = `%${project}%`;
  const { rows } = await adapter.query<{
    artifact_id: string;
    abs_path: string | null;
    title: string | null;
    produced_at: string;
    source: string | null;
    availability: string | null;
  }>(
    `SELECT artifact_id, abs_path, title, produced_at, source, availability
       FROM artifacts
      WHERE COALESCE(project_ref, '') = ?
         OR COALESCE(title, '') LIKE ?
         OR COALESCE(abs_path, '') LIKE ?
      ORDER BY produced_at DESC
      LIMIT 20`,
    [project, like, like],
  );

  return rows.map((row) => ({
    artifact_id: row.artifact_id,
    path: row.abs_path,
    title: row.title,
    produced_at: row.produced_at,
    source_link: stableArtifactSourceLink(row.artifact_id),
    availability: row.availability,
  }));
}

function stableArtifactSourceLink(artifactId: string): string {
  return `manager:/artifacts/${encodeURIComponent(artifactId)}`;
}

function stableArtifactOperationSourceLink(artifactId: string, opId: number): string {
  return `${stableArtifactSourceLink(artifactId)}/operations/${opId}`;
}

function latestIso(values: string[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!Number.isFinite(Date.parse(value))) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

function dedupeSourceLinks(links: ReleaseProofSourceLink[]): ReleaseProofSourceLink[] {
  const seen = new Set<string>();
  const out: ReleaseProofSourceLink[] = [];
  for (const link of links) {
    const href = link.href.trim();
    if (!isSafeSourceHref(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ ...link, href });
  }
  return out;
}

function isSafeSourceHref(value: string | null | undefined): value is string {
  if (!value) return false;
  const href = value.trim();
  if (!href || isRedactedSource(href) || isLocalPathExposure(href)) return false;
  if (href.startsWith("manager:/") || href.startsWith("/") || href.startsWith("http://") || href.startsWith("https://")) {
    return true;
  }
  return false;
}

function isSafeSourceToken(value: string | null | undefined): value is string {
  if (!value) return false;
  const source = value.trim();
  if (!source || isRedactedSource(source) || isLocalPathExposure(source)) return false;
  if (isSafeSourceHref(source)) return true;
  return /^[a-z][a-z0-9_-]*(?::[a-z0-9._/-]+)?$/i.test(source);
}

function isRedactedSource(value: string): boolean {
  return /^\[?redacted\]?$/i.test(value.trim()) || value.includes("<redacted>");
}

function isLocalPathExposure(value: string): boolean {
  const source = value.trim();
  return source.startsWith("file://") || source.startsWith("/Users/") || source.startsWith("/home/") || source.startsWith("/tmp/");
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    return [];
  }
}

function summarizePayload(json: string | null): string | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== "object") return null;
    const body = (value as { body?: unknown; text?: unknown; note?: unknown }).body ??
      (value as { text?: unknown }).text ??
      (value as { note?: unknown }).note;
    return typeof body === "string" && body.trim() ? body.trim().slice(0, 240) : null;
  } catch {
    return null;
  }
}

function summaryForNotReady(input: {
  feedbackState: EvidenceState;
  infraState: InfraWarningState;
  staleReasons: string[];
  errorReasons: string[];
  missingReasons: string[];
}): string {
  if (input.errorReasons.length > 0) return `Release proof is not ready: ${input.errorReasons[0]}.`;
  if (input.infraState !== "clear") return "Release proof is not ready: infra warnings require operator review.";
  if (input.staleReasons.length > 0) return `Release proof is not ready: ${input.staleReasons[0]}.`;
  if (input.missingReasons.length > 0) return `Release proof is not ready: ${input.missingReasons[0]}.`;
  return "Release proof is not ready.";
}

export function formatOrchestrationLoopInfraWarning(health: Awaited<ReturnType<typeof readOrchestrationHealthProjection>>): string {
  const loop = health.orchestration_loop;
  const topBlocker = topAdmissionBlocker(health);
  const blockerText = topBlocker
    ? `; top blocker ${topBlocker.code}=${topBlocker.count}`
    : "";
  const routeText = "; source route /orchestration/status ready_admission.blocker_counts";
  const topBlockerAction = topBlocker
    ? releaseProofSafeActionForTopBlocker(health, topBlocker.code)
    : null;
  const action = topBlockerAction?.trim() ||
    health.ready_item_blockers.recommended_action.trim() ||
    "inspect ready admission blockers before release proof sign-off";
  return (
    `orchestration loop ${loop.severity}: ${loop.consecutive_zero_ticks} consecutive zero-admit ticks` +
    `${blockerText}; ${loop.explanation}${routeText}; safe next action: ${action}`
  );
}

function topAdmissionBlocker(
  health: Awaited<ReturnType<typeof readOrchestrationHealthProjection>>,
): { code: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const [code, count] of Object.entries(health.orchestration_loop.last_admission_block_reasons)) {
    if (count > 0) counts.set(code, Math.max(counts.get(code) ?? 0, count));
  }
  for (const blocker of health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class) {
    if (blocker.count > 0) counts.set(blocker.code, Math.max(counts.get(blocker.code) ?? 0, blocker.count));
  }
  return topCount(Object.fromEntries(counts));
}

function releaseProofSafeActionForTopBlocker(
  health: Awaited<ReturnType<typeof readOrchestrationHealthProjection>>,
  code: string,
): string | null {
  const action = safeActionForAdmissionBlocker(health, code);
  const duplicateCount = Math.max(
    health.orchestration_loop.last_admission_block_reasons.duplicate_dispatch_retry_required ?? 0,
    health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class.find((blocker) =>
      blocker.code === "duplicate_dispatch_retry_required"
    )?.count ?? 0,
  );
  if (code === "duplicate_dispatch_retry_required" || duplicateCount === 0) return action;
  const duplicateAction = safeActionForAdmissionBlocker(health, "duplicate_dispatch_retry_required");
  if (!duplicateAction || action?.includes("duplicate_dispatch_retry_required")) return action;
  return action
    ? `${action}; retry-safety blocker also present: ${duplicateAction}`
    : `retry-safety blocker also present: ${duplicateAction}`;
}

function safeActionForAdmissionBlocker(
  health: Awaited<ReturnType<typeof readOrchestrationHealthProjection>>,
  code: string,
): string | null {
  if (code !== "duplicate_dispatch_retry_required") {
    return health.ready_item_blockers.categories.find((category) => category.code === code)?.recommended_action ??
      (health.ready_item_blockers.recommended_action.trim() || null);
  }

  const details = health.ready_item_blockers.items.filter((item) => item.code === code);
  const hasRetryable = details.some((item) => item.retry_readiness_status === "retryable_failed_row");
  const hasStale = details.some((item) => item.retry_readiness_status === "stale_duplicate");
  const hasHeld = details.some((item) =>
    item.retry_readiness_status === "waiting_on_live_dispatch" ||
    item.retry_readiness_status === "non_retryable_failed_row" ||
    item.retry_readiness_status === "retry_cap_reached" ||
    item.retry_readiness_status === null
  );

  const actions: string[] = [];
  if (hasRetryable) actions.push("mark retry_safe only for retryable failed rows");
  if (hasStale) actions.push("close stale duplicates");
  if (hasHeld) actions.push("keep non-retryable or live prior-dispatch rows held for operator review");

  return actions.length > 0
    ? `review duplicate_dispatch_retry_required rows in /orchestration/status: ${actions.join("; ")}`
    : "review duplicate_dispatch_retry_required rows in /orchestration/status before release proof sign-off";
}

function topCount(counts: Record<string, number>): { code: string; count: number } | null {
  const sorted = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([aCode, aCount], [bCode, bCount]) => bCount - aCount || aCode.localeCompare(bCode));
  const top = sorted[0];
  return top ? { code: top[0], count: top[1] } : null;
}

function deriveNextOwner(input: {
  feedbackState: EvidenceState;
  infraState: InfraWarningState;
  sourceLinks: ReleaseProofSourceLink[];
  artifactPointers: ReleaseProofArtifactPointer[];
  missingArtifactSources: ReleaseProofArtifactPointer[];
  unavailableArtifacts: ReleaseProofArtifactPointer[];
  feedbackMissingSources: ReleaseProofFeedbackEvidence[];
  staleReasons: string[];
  errorReasons: string[];
  missingReasons: string[];
  infraAction: string | null;
}): ReleaseProofReadinessResponse["next_owner"] {
  const candidates: ReleaseProofReadinessResponse["next_owner"]["candidates"] = [];

  if (input.errorReasons.length > 0 || input.feedbackState === "error") {
    candidates.push({
      lane: "release-engineering",
      reason: "loader_error",
      action: input.errorReasons[0] ?? "restore release-proof data sources and retry readiness",
    });
  }
  if (input.infraState === "warning") {
    candidates.push({
      lane: "operator",
      reason: "infra_warning",
      action: input.infraAction ?? "review orchestration health and resolve infra warnings before release proof sign-off",
    });
  }
  if (input.feedbackState === "stale") {
    candidates.push({
      lane: "chris",
      reason: "feedback_freshness",
      action: input.staleReasons.find((reason) => reason.includes("feedback evidence")) ??
        "refresh release-proof feedback evidence before sign-off",
    });
  }
  if (input.sourceLinks.length === 0 || input.feedbackMissingSources.length > 0) {
    candidates.push({
      lane: "release-engineering",
      reason: "source_link_state",
      action: input.missingReasons.find((reason) => reason.includes("source link") || reason.includes("source_link")) ??
        "attach safe source links to release-proof evidence",
    });
  }
  if (
    input.artifactPointers.length === 0 ||
    input.missingArtifactSources.length > 0 ||
    input.unavailableArtifacts.length > 0
  ) {
    candidates.push({
      lane: "release-engineering",
      reason: "artifact_state",
      action: input.missingReasons.find((reason) => reason.includes("artifact")) ??
        "restore generated release-proof artifacts",
    });
  }

  const primary = candidates[0] ?? null;
  return {
    lane: primary?.lane ?? "none",
    action: primary?.action ?? null,
    reason: primary?.reason ?? null,
    candidates,
  };
}

import type { DbAdapter } from "../db/db-adapter.js";
import { readOrchestrationHealthProjection } from "./health-projection.js";

export type ReleaseProofReadinessState = "ready" | "not_ready";
export type EvidenceState = "present" | "empty" | "stale" | "error";
export type InfraWarningState = "clear" | "warning" | "error";
export type InfraWarningSource = "none" | "readiness_loader" | "orchestration_health_projection";
export type LinkState = "present" | "missing";
export type ReleaseProofNextOwnerLane = "none" | "chris" | "operator" | "release-engineering";

export interface ReleaseProofFeedbackEvidence {
  id: string;
  kind: string;
  observed_at: string;
  source_link: string | null;
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
  stale_after_ms?: number;
  load_error?: string | null;
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

  if (input.load_error) errorReasons.push(input.load_error);

  const latestFeedbackAt = latestIso(input.feedback_evidence.map((item) => item.observed_at));
  let feedbackState: EvidenceState = "present";
  if (input.load_error) {
    feedbackState = "error";
  } else if (input.feedback_evidence.length === 0) {
    feedbackState = "empty";
    missingReasons.push("no feedback evidence has been recorded for this release proof");
  } else if (latestFeedbackAt && Date.parse(input.generated_at) - Date.parse(latestFeedbackAt) > staleAfterMs) {
    feedbackState = "stale";
    staleReasons.push(`latest feedback evidence is older than ${Math.round(staleAfterMs / 3_600_000)}h`);
  }

  const artifactPointers = input.generated_artifacts;
  if (artifactPointers.length === 0) {
    missingReasons.push("no generated release proof artifacts are registered");
  }
  const missingArtifactSources = artifactPointers.filter((item) => !isSafeSourceToken(item.source_link));
  if (missingArtifactSources.length > 0) {
    missingReasons.push("one or more generated artifacts are missing safe source links");
  }
  const unavailableArtifacts = artifactPointers.filter((item) => item.availability !== "present");
  if (unavailableArtifacts.length > 0) {
    missingReasons.push("one or more generated proof artifacts are not present");
  }
  const staleArtifacts = artifactPointers.filter((item) =>
    Number.isFinite(Date.parse(item.produced_at)) &&
    Date.parse(input.generated_at) - Date.parse(item.produced_at) > staleAfterMs
  );
  if (staleArtifacts.length > 0) {
    staleReasons.push(`one or more generated artifacts are older than ${Math.round(staleAfterMs / 3_600_000)}h`);
  }

  const invalidSourceLinks = input.source_links.filter((item) => !isSafeSourceHref(item.href));
  if (invalidSourceLinks.length > 0) {
    missingReasons.push("one or more source links are redacted or unsupported");
  }
  const sourceLinks = dedupeSourceLinks(input.source_links);
  const sourceLinkCounts = {
    safe: sourceLinks.length,
    unsafe: invalidSourceLinks.length,
    total: input.source_links.length,
  };
  if (sourceLinks.length === 0) {
    missingReasons.push("no source links are attached to the release proof");
  }

  const feedbackMissingSources = input.feedback_evidence.filter((item) => !isSafeSourceHref(item.source_link));
  if (feedbackMissingSources.length > 0) {
    missingReasons.push("one or more feedback evidence items are missing safe source links");
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
    stale_reasons: staleReasons,
    error_reasons: errorReasons,
    missing_reasons: missingReasons,
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
      infraWarnings.push(`orchestration loop ${health.orchestration_loop.severity}: ${health.orchestration_loop.explanation}`);
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
  }>(
    `SELECT op_id, artifact_id, op_type, actor, ts, payload_json, source_link
       FROM artifact_operations
      WHERE op_type IN ('comment_recorded', 'comment_routed', 'approve', 'reject', 'ship_attempted', 'ship_blocked')
        AND (
          COALESCE(source_link, '') LIKE ?
          OR COALESCE(payload_json, '') LIKE ?
          OR artifact_id IN (
            SELECT artifact_id FROM artifacts
             WHERE COALESCE(project_ref, '') = ?
                OR COALESCE(title, '') LIKE ?
                OR COALESCE(abs_path, '') LIKE ?
          )
        )
      ORDER BY ts DESC, op_id DESC
      LIMIT 20`,
    [like, like, project, like, like],
  );

  return rows.map((row) => ({
    id: `op:${row.op_id}`,
    kind: row.op_type,
    observed_at: row.ts,
    source_link: row.source_link,
    artifact_id: row.artifact_id,
    summary: summarizePayload(row.payload_json) ?? `${row.op_type} by ${row.actor}`,
  }));
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
      action: input.missingReasons.find((reason) => reason.includes("source link")) ??
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

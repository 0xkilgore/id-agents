import { extname } from "node:path";
import type { ArtifactCatalogRow, OutputsInboxRow } from "./types.js";

export type ArtifactMediaType = "text/markdown" | "text/html" | "text/plain" | "application/pdf" | "unknown";
export type ArtifactFreshness = "current" | "syncing" | "stale" | "event_gap" | "body_unavailable" | "error";
export type ArtifactDiscoveredBy = "agent_done" | "artifact_register" | "filesystem_reconcile" | "manual_fixture";
export type SurfacingHealthCode =
  | "absent_row"
  | "body_unavailable"
  | "body_render_failed"
  | "copy_failed"
  | "download_failed";

export interface OperatorArtifactDelivery {
  artifactId: string;
  stableUrl: string;
  title: string;
  projectRef?: string;
  agentName: string;
  sourcePath: string;
  sourceHost?: string;
  sourceMtime?: string;
  contentHash?: string;
  mediaType: ArtifactMediaType;
  bodyRenderable: boolean;
  bodyPreview?: string;
  bodyText?: string;
  copyTextUrl: string;
  downloadUrl: string;
  discoveredBy: ArtifactDiscoveredBy;
  freshness: ArtifactFreshness;
}

export interface SurfacingHealthEvent {
  schema_version: "artifact.surfacing.health_event.v1";
  code: SurfacingHealthCode;
  severity: "error";
  artifact_id: string;
  title: string;
  message: string;
  operator_visible: true;
  emitted_at: string;
  stable_url: string;
  source_path: string;
  details: Record<string, unknown>;
}

export interface ArtifactActionProbe {
  bodyRenderable: boolean;
  copyAvailable: boolean;
  downloadAvailable: boolean;
  bodyText?: string;
  bodyPreview?: string;
  sourceMtime?: string;
  contentHash?: string;
  error?: string;
}

export interface SurfacingHealthReport {
  schema_version: "artifact.surfacing.health.v1";
  ok: boolean;
  generated_at: string;
  checked: number;
  events: SurfacingHealthEvent[];
  deliveries: OperatorArtifactDelivery[];
}

export function mediaTypeFromPath(absPath: string): ArtifactMediaType {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".txt" || ext === ".log" || ext === ".csv" || ext === ".json") return "text/plain";
  if (ext === ".pdf") return "application/pdf";
  return "unknown";
}

export function discoveredByFromSource(source: ArtifactCatalogRow["source"]): ArtifactDiscoveredBy {
  if (source === "agent-done") return "agent_done";
  if (source === "filesystem") return "filesystem_reconcile";
  if (source === "manual") return "manual_fixture";
  return "artifact_register";
}

export function projectRefFromPath(absPath: string): string | undefined {
  const match = absPath.match(/\/Dropbox\/Code\/([^/]+)\//);
  return match?.[1];
}

export function titleForArtifact(row: ArtifactCatalogRow): string {
  return row.title || row.basename || row.artifact_id;
}

function eventFor(
  code: SurfacingHealthCode,
  row: ArtifactCatalogRow,
  nowIso: string,
  message: string,
  details: Record<string, unknown> = {},
): SurfacingHealthEvent {
  return {
    schema_version: "artifact.surfacing.health_event.v1",
    code,
    severity: "error",
    artifact_id: row.artifact_id,
    title: titleForArtifact(row),
    message,
    operator_visible: true,
    emitted_at: nowIso,
    stable_url: `/artifacts/${encodeURIComponent(row.artifact_id)}/detail`,
    source_path: row.abs_path,
    details,
  };
}

export function deliveryForArtifact(row: ArtifactCatalogRow, probe: ArtifactActionProbe): OperatorArtifactDelivery {
  const bodyText = probe.bodyText;
  const mediaType = mediaTypeFromPath(row.abs_path);
  const bodyRenderable = probe.bodyRenderable && (mediaType === "text/markdown" || mediaType === "text/html" || mediaType === "text/plain");
  return {
    artifactId: row.artifact_id,
    stableUrl: `/artifacts/${encodeURIComponent(row.artifact_id)}/detail`,
    title: titleForArtifact(row),
    projectRef: projectRefFromPath(row.abs_path),
    agentName: row.agent,
    sourcePath: row.abs_path,
    sourceMtime: probe.sourceMtime,
    contentHash: probe.contentHash,
    mediaType,
    bodyRenderable,
    bodyPreview: probe.bodyPreview ?? bodyText?.slice(0, 2000),
    bodyText,
    copyTextUrl: `/artifacts/${encodeURIComponent(row.artifact_id)}/copy-text`,
    downloadUrl: `/artifacts/${encodeURIComponent(row.artifact_id)}/download`,
    discoveredBy: discoveredByFromSource(row.source),
    freshness: bodyRenderable && probe.copyAvailable && probe.downloadAvailable ? "current" : "body_unavailable",
  };
}

export function evaluateSurfacingHealth(input: {
  registered: ArtifactCatalogRow[];
  surfaced: Pick<OutputsInboxRow, "artifact_id">[];
  probes: ReadonlyMap<string, ArtifactActionProbe>;
  nowIso: string;
}): SurfacingHealthReport {
  const surfacedIds = new Set(input.surfaced.map((row) => row.artifact_id));
  const events: SurfacingHealthEvent[] = [];
  const deliveries: OperatorArtifactDelivery[] = [];

  for (const row of input.registered) {
    const probe = input.probes.get(row.artifact_id) ?? {
      bodyRenderable: false,
      copyAvailable: false,
      downloadAvailable: false,
      error: "probe_missing",
    };
    const delivery = deliveryForArtifact(row, probe);
    deliveries.push(delivery);

    if (!surfacedIds.has(row.artifact_id)) {
      events.push(eventFor("absent_row", row, input.nowIso, "Registered artifact is absent from Desk/Recent Output", {
        expected_surface: "outputs/inbox",
      }));
    }
    if (row.availability !== "present" || probe.error === "body_unavailable") {
      events.push(eventFor("body_unavailable", row, input.nowIso, "Artifact body is unavailable through the manager", {
        availability: row.availability,
        error: probe.error ?? null,
      }));
    } else if (!probe.bodyRenderable) {
      events.push(eventFor("body_render_failed", row, input.nowIso, "Artifact body is not renderable in the console", {
        media_type: delivery.mediaType,
        error: probe.error ?? null,
      }));
    }
    if (!probe.copyAvailable) {
      events.push(eventFor("copy_failed", row, input.nowIso, "Artifact fallback copy action is unavailable", {
        copyTextUrl: delivery.copyTextUrl,
        error: probe.error ?? null,
      }));
    }
    if (!probe.downloadAvailable) {
      events.push(eventFor("download_failed", row, input.nowIso, "Artifact fallback download action is unavailable", {
        downloadUrl: delivery.downloadUrl,
        error: probe.error ?? null,
      }));
    }
  }

  return {
    schema_version: "artifact.surfacing.health.v1",
    ok: events.length === 0,
    generated_at: input.nowIso,
    checked: input.registered.length,
    events,
    deliveries,
  };
}

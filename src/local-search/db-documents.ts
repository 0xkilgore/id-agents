import type { DbAdapter } from "../db/db-adapter.js";
import type { LocalSearchDocument, LocalSearchSourceType } from "./contract.js";

export async function loadLocalSearchDocuments(adapter: DbAdapter): Promise<LocalSearchDocument[]> {
  const [artifacts, tasks, projects] = await Promise.all([
    loadArtifactDocuments(adapter),
    loadTaskDocuments(adapter),
    loadProjectDocuments(adapter),
  ]);
  return [...artifacts, ...tasks, ...projects];
}

async function loadArtifactDocuments(adapter: DbAdapter): Promise<LocalSearchDocument[]> {
  try {
    const { rows } = await adapter.query<{
      artifact_id: string;
      title: string | null;
      basename: string;
      agent: string;
      tag: string | null;
      abs_path: string;
      availability: string;
      media_type: string | null;
      source: string;
      source_host: string | null;
      project_ref: string | null;
      dispatch_ref: string | null;
      body_text: string | null;
      body_error: string | null;
      updated_at: string;
      produced_at: string;
    }>(
      `SELECT a.artifact_id, a.title, a.basename, a.agent, a.tag, a.abs_path,
              a.availability, a.media_type, a.source, a.source_host,
              a.project_ref, a.dispatch_ref, b.body_text, b.body_error,
              a.updated_at, a.produced_at
         FROM artifacts a
    LEFT JOIN artifact_bodies b ON b.artifact_id = a.artifact_id
     ORDER BY a.updated_at DESC
        LIMIT 1000`,
    );
    const artifactRoute = (artifactId: string) => `/artifacts/${encodeURIComponent(artifactId)}`;
    return rows.map((row) => ({
      entityType: "artifact",
      id: row.artifact_id,
      title: row.title ?? row.basename,
      project: row.project_ref ?? row.tag,
      track: row.tag,
      task: null,
      agent: row.agent,
      author: row.agent,
      status: row.availability,
      readState: "unknown",
      needsReview: false,
      updatedAt: row.updated_at ?? row.produced_at,
      matchFields: {
        title: row.title ?? row.basename,
        basename: row.basename,
        project: row.project_ref ?? row.tag,
        path: row.abs_path,
        agent: row.agent,
        dispatch: row.dispatch_ref,
        body: row.body_text,
      },
      freshness: row.body_error ? "error" : "current",
      openTarget: { kind: "artifact", ref: row.artifact_id, route: artifactRoute(row.artifact_id) },
      routeMetadata: {
        sourceType: sourceTypeFromPath(row.abs_path, row.media_type, row.title ?? row.basename, row.body_text),
        sourcePath: row.abs_path,
        sourceProof: `${row.source}:${row.source_host ? `${row.source_host}:` : ""}${row.abs_path}`,
        linkedArtifact: row.artifact_id,
        linkedDispatch: row.dispatch_ref,
        stableUrl: `${artifactRoute(row.artifact_id)}/detail`,
        copyTextUrl: `${artifactRoute(row.artifact_id)}/copy-text`,
        downloadUrl: `${artifactRoute(row.artifact_id)}/download`,
        bodyAvailable: Boolean(row.body_text) && !row.body_error,
        bodyCached: Boolean(row.body_text),
        bodySource: row.body_text ? "cache" : "unavailable",
      },
    }));
  } catch {
    return [];
  }
}

async function loadTaskDocuments(adapter: DbAdapter): Promise<LocalSearchDocument[]> {
  try {
    const { rows } = await adapter.query<{
      id: string;
      name: string;
      uuid: string | null;
      title: string;
      description: string | null;
      status: string;
      created_by: string | null;
      owner: string | null;
      track: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, name, uuid, title, description, status, created_by, owner, track, created_at, updated_at
         FROM tasks
     ORDER BY updated_at DESC
        LIMIT 1000`,
    );
    return rows.map((row) => ({
      entityType: "task",
      id: row.uuid && row.uuid !== "" ? row.uuid : row.id,
      title: row.title,
      project: row.track,
      track: row.track,
      task: row.name,
      agent: row.owner,
      author: row.created_by,
      status: row.status,
      readState: "unknown",
      needsReview: false,
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
      matchFields: {
        title: row.title,
        name: row.name,
        description: row.description,
        track: row.track,
        status: row.status,
        owner: row.owner,
        createdBy: row.created_by,
        createdAt: epochToIso(row.created_at),
      },
      freshness: "current",
      openTarget: { kind: "task", ref: row.name, route: `/tasks/${encodeURIComponent(row.name)}` },
    }));
  } catch {
    return [];
  }
}

async function loadProjectDocuments(adapter: DbAdapter): Promise<LocalSearchDocument[]> {
  try {
    const { rows } = await adapter.query<{
      id: string;
      name: string;
      config: string | Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT id, name, config, created_at
         FROM teams
     ORDER BY name ASC
        LIMIT 500`,
    );
    return rows.map((row) => ({
      entityType: "project",
      id: row.id,
      title: row.name,
      project: row.name,
      track: null,
      task: null,
      agent: null,
      author: null,
      status: "active",
      readState: "unknown",
      needsReview: false,
      updatedAt: row.created_at,
      matchFields: {
        name: row.name,
        registry: JSON.stringify(row.config ?? {}),
      },
      freshness: "current",
      openTarget: { kind: "project", ref: row.name, route: `/projects/${encodeURIComponent(row.name)}` },
    }));
  } catch {
    return [];
  }
}

function epochToIso(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function sourceTypeFromPath(
  path: string | null | undefined,
  mediaType: string | null | undefined,
  title: string | null | undefined,
  body: string | null | undefined,
): LocalSearchSourceType {
  const media = (mediaType ?? "").toLowerCase();
  const ext = (path ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const haystack = [path, title, body?.slice(0, 2000)].filter(Boolean).join(" ").toLowerCase();
  if (media.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"].includes(ext)) return "image";
  if (media === "application/pdf" || ext === ".pdf") return "pdf";
  if ([".eml", ".msg"].includes(ext) || /\b(email|mailbox|inbox|subject:|from:)\b/.test(haystack)) return "email";
  if (/\b(transcript|transcription|recording|call notes|meeting notes)\b/.test(haystack)) return "transcript";
  if ([".md", ".markdown", ".txt", ".json", ".html", ".htm"].includes(ext) || media.startsWith("text/") || media === "application/json") return "artifact";
  return "other";
}

import type { DbAdapter } from "../db/db-adapter.js";
import type { LocalSearchDocument } from "./contract.js";

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
      updated_at: string;
      produced_at: string;
    }>(
      `SELECT artifact_id, title, basename, agent, tag, abs_path, availability, updated_at, produced_at
         FROM artifacts
     ORDER BY updated_at DESC
        LIMIT 1000`,
    );
    return rows.map((row) => ({
      entityType: "artifact",
      id: row.artifact_id,
      title: row.title ?? row.basename,
      project: row.tag,
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
        project: row.tag,
        path: row.abs_path,
        agent: row.agent,
      },
      freshness: "current",
      openTarget: { kind: "artifact", ref: row.artifact_id, route: `/artifacts/${encodeURIComponent(row.artifact_id)}` },
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
      updated_at: number;
    }>(
      `SELECT id, name, uuid, title, description, status, created_by, owner, track, updated_at
         FROM tasks
     ORDER BY updated_at DESC
        LIMIT 1000`,
    );
    return rows.map((row) => ({
      entityType: "task",
      id: row.uuid && row.uuid !== "" ? row.uuid : row.id,
      title: row.title,
      project: row.track,
      task: row.name,
      agent: row.owner,
      author: row.created_by,
      status: row.status,
      readState: "unknown",
      needsReview: false,
      updatedAt: epochToIso(row.updated_at),
      matchFields: {
        title: row.title,
        name: row.name,
        description: row.description,
        track: row.track,
        status: row.status,
        owner: row.owner,
        createdBy: row.created_by,
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

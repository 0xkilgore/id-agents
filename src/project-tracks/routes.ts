import type { Application, Request, Response } from "express";
import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildProjectTracksEnvelope, canonicalProjectName } from "./read-model.js";

type ProjectListItem = {
  id: string;
  name: string;
  created_at: string | null;
};

type ProjectDetail = {
  ok: true;
  schema_version: "project.detail.v1";
  generated_at: string;
  version_key: string;
  project: {
    requested: string;
    canonical: string;
    aliases: string[];
  };
  metadata: {
    project_id: string | null;
    name: string;
    created_at: string | null;
    source: "local_project_index";
    local_visual_state: {
      state: "ready";
      tone: "good";
      label: "Current";
      message: string;
    };
  };
  body: {
    kind: "project_tracks";
    text: string;
    data: Awaited<ReturnType<typeof buildProjectTracksEnvelope>>;
  };
  comments: [];
  timeline: [];
};

export function mountProjectTracksRoutes(app: Application, adapter: DbAdapter): void {
  const listCache = new Map<string, { at: number; rows: ProjectListItem[] }>();
  const detailCache = new Map<string, ProjectDetail>();
  const inflight = new Map<string, Promise<ProjectDetail>>();
  const cacheTtlMs = 30_000;
  const detailCacheMax = 100;

  function rememberDetail(key: string, detail: ProjectDetail): void {
    if (detailCache.has(key)) detailCache.delete(key);
    detailCache.set(key, detail);
    while (detailCache.size > detailCacheMax) {
      const oldest = detailCache.keys().next().value;
      if (!oldest) break;
      detailCache.delete(oldest);
    }
  }

  async function listProjects(): Promise<ProjectListItem[]> {
    const hit = listCache.get("projects");
    if (hit && Date.now() - hit.at < cacheTtlMs) return hit.rows;
    const { rows } = await adapter.query<ProjectListItem>(
      `SELECT id, name, created_at
         FROM teams
     ORDER BY name ASC
        LIMIT 500`,
    );
    listCache.set("projects", { at: Date.now(), rows });
    return rows;
  }

  async function buildProjectDetail(project: string): Promise<ProjectDetail> {
    const canonical = canonicalProjectName(project);
    const [projects, envelope] = await Promise.all([
      listProjects(),
      buildProjectTracksEnvelope(adapter, { project }),
    ]);
    const row = projects.find((candidate) => canonicalProjectName(candidate.name) === canonical) ?? null;
    const bodyText = [
      `Project: ${envelope.project.canonical}`,
      `Tracks: ${envelope.tracks.length}`,
      `Associations: ${envelope.drift.total_associations}`,
      `Drift: ${envelope.drift.drift_count}`,
      ...envelope.tracks.slice(0, 10).map((track) => {
        const count = Object.values(track.counts).reduce((sum, value) => sum + value, 0);
        return `- ${track.track}: ${count} item${count === 1 ? "" : "s"}`;
      }),
    ].join("\n");
    const versionPayload = {
      project: envelope.project.canonical,
      aliases: envelope.project.aliases,
      tracks: envelope.tracks.map((track) => ({
        track: track.track,
        counts: track.counts,
        status_counts: track.status_counts,
        latest_activity_at: track.latest_activity_at,
        blockers: track.blockers.map((blocker) => [blocker.kind, blocker.id, blocker.status, blocker.updated_at]),
      })),
      drift: envelope.drift,
      empty: envelope.empty,
      projectRowUpdatedAt: row?.created_at ?? null,
    };
    return {
      ok: true,
      schema_version: "project.detail.v1",
      generated_at: new Date().toISOString(),
      version_key: `project:${crypto.createHash("sha256").update(JSON.stringify(versionPayload)).digest("hex").slice(0, 24)}`,
      project: envelope.project,
      metadata: {
        project_id: row?.id ?? null,
        name: row?.name ?? envelope.project.canonical,
        created_at: row?.created_at ?? null,
        source: "local_project_index",
        local_visual_state: {
          state: "ready",
          tone: "good",
          label: "Current",
          message: "Local project index and project-track projection are available.",
        },
      },
      body: {
        kind: "project_tracks",
        text: bodyText,
        data: envelope,
      },
      comments: [],
      timeline: [],
    };
  }

  async function getProjectDetail(project: string): Promise<{ detail: ProjectDetail; cache: "hit" | "miss" | "deduped" }> {
    const key = canonicalProjectName(project);
    const hit = detailCache.get(key);
    if (hit) return { detail: hit, cache: "hit" };
    const existing = inflight.get(key);
    if (existing) return { detail: await existing, cache: "deduped" };
    const pending = buildProjectDetail(project);
    inflight.set(key, pending);
    try {
      const detail = await pending;
      rememberDetail(key, detail);
      return { detail, cache: "miss" };
    } finally {
      inflight.delete(key);
    }
  }

  app.get("/projects/:project/detail", async (req: Request<{ project: string }>, res: Response) => {
    try {
      const projects = await listProjects();
      const canonical = canonicalProjectName(req.params.project);
      const index = projects.findIndex((row) => canonicalProjectName(row.name) === canonical);
      const previous = index > 0 ? projects[index - 1] : null;
      const next = index >= 0 && index < projects.length - 1 ? projects[index + 1] : null;
      const { detail, cache } = await getProjectDetail(req.params.project);
      await Promise.all(
        [previous, next].filter((row): row is ProjectListItem => Boolean(row)).map((row) =>
          getProjectDetail(row.name).catch(() => null),
        ),
      );
      res.setHeader("X-Project-Detail-Cache", cache);
      res.json({
        ...detail,
        adjacent_prefetch: {
          list_key: "projects",
          index: index >= 0 ? index : null,
          list_length: projects.length,
          previous: previous
            ? { name: previous.name, url: `/projects/${encodeURIComponent(previous.name)}/detail` }
            : null,
          next: next
            ? { name: next.name, url: `/projects/${encodeURIComponent(next.name)}/detail` }
            : null,
        },
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/projects/:project/tracks", async (req: Request<{ project: string }>, res: Response) => {
    try {
      const limitPerKind = Math.min(parseInt(String(req.query.limit_per_kind ?? "50"), 10) || 50, 200);
      const envelope = await buildProjectTracksEnvelope(adapter, {
        project: req.params.project,
        limitPerKind,
      });
      res.json(envelope);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

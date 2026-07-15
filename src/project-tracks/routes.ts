import type { Application, Request, Response } from "express";
import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { localHealthVisualState, type LocalHealthVisual } from "../local-search/visual-state.js";
import { buildProjectTracksEnvelope, canonicalProjectName } from "./read-model.js";
import { buildProjectSourcesEnvelope, type BuildProjectSourcesOptions } from "./sources-read-model.js";
import type {
  ProjectSourceFreshnessStatus,
  ProjectSourceGroup,
  ProjectSourceIndexHealth,
  ProjectSourceIndexState,
  ProjectSourceReadState,
  ProjectSourcesEnvelope,
} from "./sources-types.js";

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
    local_visual_state: LocalHealthVisual;
    local_index: ProjectLocalIndexHealth;
  };
  body: {
    kind: "project_tracks";
    text: string;
    data: Awaited<ReturnType<typeof buildProjectTracksEnvelope>>;
  };
  comments: [];
  timeline: [];
};

type ProjectLocalIndexState = "current" | "syncing" | "stale" | "event_gap" | "error";

type ProjectLocalIndexHealth = {
  state: ProjectLocalIndexState;
  scope: string;
  last_event_seq: number;
  last_synced_at: string | null;
  event_gap: {
    detected_at: string;
    expected_seq: number;
    earliest_available_seq: number | null;
    observed_seq: number | null;
  } | null;
  error: string | null;
};

type EventLogProjectRow = {
  seq: number;
  topic: string;
  subject_kind: string | null;
  subject_id: string | null;
  data: string | Record<string, unknown> | null;
};

type SourceIndexRequest = Pick<
  BuildProjectSourcesOptions,
  "project" | "limit" | "type" | "agent" | "since" | "until" | "readState" | "status" | "q"
>;

const PROJECT_INDEX_EVENT_TOPICS = [
  "task:created",
  "task:claimed",
  "task:updated",
  "task:completed",
  "artifact:created",
  "artifact:registered",
  "artifact:updated",
  "dispatch:queued",
  "dispatch:in_flight",
  "dispatch:updated",
  "dispatch:bounced",
  "dispatch:done",
  "dispatch:failed",
  "backlog:created",
  "backlog:updated",
  "backlog:landed",
  "output:created",
  "output:updated",
] as const;

const projectIndexTopicSet = new Set<string>(PROJECT_INDEX_EVENT_TOPICS);

class ProjectLocalIndex {
  private detailCache = new Map<string, ProjectDetail>();
  private inflight = new Map<string, Promise<ProjectDetail>>();
  private health = new Map<string, ProjectLocalIndexHealth>();
  private lastEventSeq = 0;
  private syncing = false;

  constructor(
    private readonly adapter: DbAdapter,
    private readonly build: (project: string) => Promise<ProjectDetail>,
    private readonly maxCacheEntries: number,
  ) {}

  async get(project: string): Promise<{ detail: ProjectDetail; cache: "hit" | "miss" | "deduped" }> {
    await this.syncEvents();
    const key = canonicalProjectName(project);
    const hit = this.detailCache.get(key);
    if (hit) return { detail: this.withHealth(hit, key), cache: "hit" };
    const existing = this.inflight.get(key);
    if (existing) return { detail: this.withHealth(await existing, key), cache: "deduped" };
    const pending = this.build(project);
    this.inflight.set(key, pending);
    try {
      const detail = await pending;
      this.remember(key, detail);
      this.setCurrent(key);
      return { detail: this.withHealth(detail, key), cache: "miss" };
    } catch (err) {
      this.setError(key, err);
      throw err;
    } finally {
      this.inflight.delete(key);
    }
  }

  async boundedResync(project: string): Promise<ProjectDetail> {
    const key = canonicalProjectName(project);
    this.syncing = true;
    this.setState(key, "syncing");
    try {
      const detail = await this.build(project);
      this.remember(key, detail);
      this.lastEventSeq = await this.maxEventSeq();
      this.setCurrent(key);
      return this.withHealth(detail, key);
    } catch (err) {
      this.setError(key, err);
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  private remember(key: string, detail: ProjectDetail): void {
    if (this.detailCache.has(key)) this.detailCache.delete(key);
    this.detailCache.set(key, detail);
    while (this.detailCache.size > this.maxCacheEntries) {
      const oldest = this.detailCache.keys().next().value;
      if (!oldest) break;
      this.detailCache.delete(oldest);
      this.health.delete(oldest);
    }
  }

  private async syncEvents(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const earliest = await this.earliestEventSeq();
      if (earliest !== null && this.lastEventSeq + 1 < earliest) {
        this.markEventGap(this.lastEventSeq + 1, earliest, null);
        return;
      }
      const { rows } = await this.adapter.query<EventLogProjectRow>(
        `SELECT seq, topic, subject_kind, subject_id, data
           FROM event_log
          WHERE seq > ?
          ORDER BY seq ASC
          LIMIT 100`,
        [this.lastEventSeq],
      );
      for (const row of rows) {
        const seq = Number(row.seq);
        if (seq !== this.lastEventSeq + 1) {
          this.markEventGap(this.lastEventSeq + 1, earliest, seq);
          return;
        }
        this.lastEventSeq = seq;
        if (!projectIndexTopicSet.has(row.topic)) continue;
        for (const scope of this.scopesForEvent(row)) {
          this.detailCache.delete(scope);
          this.setState(scope, "stale");
        }
      }
    } catch (err) {
      for (const key of this.knownScopes()) this.setError(key, err);
    } finally {
      this.syncing = false;
    }
  }

  private scopesForEvent(row: EventLogProjectRow): string[] {
    const data = parseEventData(row.data);
    const candidates = [
      stringValue(data.project),
      stringValue(data.project_name),
      stringValue(data.projectName),
      stringValue(data.team),
      stringValue(data.team_name),
      row.subject_kind === "project" ? row.subject_id : null,
    ].filter((v): v is string => Boolean(v));
    const scopes = candidates.map(canonicalProjectName);
    if (scopes.length > 0) return Array.from(new Set(scopes));
    return this.knownScopes();
  }

  private knownScopes(): string[] {
    return Array.from(new Set([...this.detailCache.keys(), ...this.health.keys()]));
  }

  private async earliestEventSeq(): Promise<number | null> {
    const { rows } = await this.adapter.query<{ seq: number | string | null }>(
      `SELECT MIN(seq) AS seq FROM event_log`,
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? null : Number(seq);
  }

  private async maxEventSeq(): Promise<number> {
    const { rows } = await this.adapter.query<{ seq: number | string | null }>(
      `SELECT MAX(seq) AS seq FROM event_log`,
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? 0 : Number(seq);
  }

  private markEventGap(expectedSeq: number, earliestAvailableSeq: number | null, observedSeq: number | null): void {
    const scopes = this.knownScopes();
    const targetScopes = scopes.length > 0 ? scopes : ["project-tracks"];
    for (const key of targetScopes) {
      this.health.set(key, {
        state: "event_gap",
        scope: key,
        last_event_seq: this.lastEventSeq,
        last_synced_at: null,
        event_gap: {
          detected_at: new Date().toISOString(),
          expected_seq: expectedSeq,
          earliest_available_seq: earliestAvailableSeq,
          observed_seq: observedSeq,
        },
        error: null,
      });
    }
  }

  private setCurrent(key: string): void {
    this.health.set(key, {
      state: "current",
      scope: key,
      last_event_seq: this.lastEventSeq,
      last_synced_at: new Date().toISOString(),
      event_gap: null,
      error: null,
    });
  }

  private setState(key: string, state: ProjectLocalIndexState): void {
    const previous = this.health.get(key);
    this.health.set(key, {
      state,
      scope: key,
      last_event_seq: this.lastEventSeq,
      last_synced_at: previous?.last_synced_at ?? null,
      event_gap: state === "event_gap" ? previous?.event_gap ?? null : null,
      error: null,
    });
  }

  private setError(key: string, err: unknown): void {
    this.health.set(key, {
      state: "error",
      scope: key,
      last_event_seq: this.lastEventSeq,
      last_synced_at: null,
      event_gap: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private healthFor(key: string): ProjectLocalIndexHealth {
    return this.health.get(key) ?? {
      state: "current",
      scope: key,
      last_event_seq: this.lastEventSeq,
      last_synced_at: null,
      event_gap: null,
      error: null,
    };
  }

  private withHealth(detail: ProjectDetail, key: string): ProjectDetail {
    const localIndex = this.healthFor(key);
    return {
      ...detail,
      metadata: {
        ...detail.metadata,
        local_visual_state: visualForProjectIndex(localIndex),
        local_index: localIndex,
      },
    };
  }
}

class ProjectSourceIndex {
  private envelopeCache = new Map<string, ProjectSourcesEnvelope>();
  private inflight = new Map<string, Promise<ProjectSourcesEnvelope>>();
  private health = new Map<string, ProjectSourceIndexHealth>();
  private lastEventSeq = 0;
  private syncing = false;

  constructor(
    private readonly adapter: DbAdapter,
    private readonly build: (request: SourceIndexRequest) => Promise<ProjectSourcesEnvelope>,
    private readonly maxCacheEntries: number,
  ) {}

  async get(request: SourceIndexRequest): Promise<{ envelope: ProjectSourcesEnvelope; cache: "hit" | "miss" | "deduped" }> {
    await this.syncEvents();
    const scope = canonicalProjectName(request.project);
    const cacheKey = this.cacheKey(request);
    const hit = this.envelopeCache.get(cacheKey);
    if (hit) return { envelope: this.withHealth(hit, scope), cache: "hit" };
    const existing = this.inflight.get(cacheKey);
    if (existing) return { envelope: this.withHealth(await existing, scope), cache: "deduped" };
    const pending = this.build(request);
    this.inflight.set(cacheKey, pending);
    try {
      const envelope = await pending;
      this.remember(cacheKey, envelope);
      this.setCurrent(scope);
      return { envelope: this.withHealth(envelope, scope), cache: "miss" };
    } catch (err) {
      this.setError(scope, err);
      throw err;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  async boundedResync(request: SourceIndexRequest): Promise<ProjectSourcesEnvelope> {
    const scope = canonicalProjectName(request.project);
    this.syncing = true;
    this.setState(scope, "syncing");
    try {
      const envelope = await this.build(request);
      this.remember(this.cacheKey(request), envelope);
      this.lastEventSeq = await this.maxEventSeq();
      this.setCurrent(scope);
      return this.withHealth(envelope, scope);
    } catch (err) {
      this.setError(scope, err);
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  healthFor(project: string): ProjectSourceIndexHealth {
    const scope = canonicalProjectName(project);
    return this.health.get(scope) ?? {
      state: "current",
      scope,
      last_event_seq: this.lastEventSeq,
      last_synced_at: null,
      event_gap: null,
      error: null,
    };
  }

  private remember(cacheKey: string, envelope: ProjectSourcesEnvelope): void {
    if (this.envelopeCache.has(cacheKey)) this.envelopeCache.delete(cacheKey);
    this.envelopeCache.set(cacheKey, envelope);
    while (this.envelopeCache.size > this.maxCacheEntries) {
      const oldest = this.envelopeCache.keys().next().value;
      if (!oldest) break;
      this.envelopeCache.delete(oldest);
    }
  }

  private async syncEvents(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const earliest = await this.earliestEventSeq();
      if (earliest !== null && this.lastEventSeq + 1 < earliest) {
        this.markEventGap(this.lastEventSeq + 1, earliest, null);
        return;
      }
      const { rows } = await this.adapter.query<EventLogProjectRow>(
        `SELECT seq, topic, subject_kind, subject_id, data
           FROM event_log
          WHERE seq > ?
          ORDER BY seq ASC
          LIMIT 100`,
        [this.lastEventSeq],
      );
      for (const row of rows) {
        const seq = Number(row.seq);
        if (seq !== this.lastEventSeq + 1) {
          this.markEventGap(this.lastEventSeq + 1, earliest, seq);
          return;
        }
        this.lastEventSeq = seq;
        if (!projectIndexTopicSet.has(row.topic)) continue;
        for (const scope of this.scopesForEvent(row)) {
          this.setState(scope, "stale");
        }
      }
    } catch (err) {
      for (const scope of this.knownScopes()) this.setError(scope, err);
    } finally {
      this.syncing = false;
    }
  }

  private scopesForEvent(row: EventLogProjectRow): string[] {
    const data = parseEventData(row.data);
    const candidates = [
      stringValue(data.project),
      stringValue(data.project_name),
      stringValue(data.projectName),
      stringValue(data.team),
      stringValue(data.team_name),
      row.subject_kind === "project" ? row.subject_id : null,
    ].filter((v): v is string => Boolean(v));
    const scopes = candidates.map(canonicalProjectName);
    if (scopes.length > 0) return Array.from(new Set(scopes));
    return this.knownScopes();
  }

  private knownScopes(): string[] {
    const cachedScopes = Array.from(this.envelopeCache.values()).map((envelope) => envelope.project.canonical);
    return Array.from(new Set([...cachedScopes, ...this.health.keys()]));
  }

  private async earliestEventSeq(): Promise<number | null> {
    const { rows } = await this.adapter.query<{ seq: number | string | null }>(
      `SELECT MIN(seq) AS seq FROM event_log`,
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? null : Number(seq);
  }

  private async maxEventSeq(): Promise<number> {
    const { rows } = await this.adapter.query<{ seq: number | string | null }>(
      `SELECT MAX(seq) AS seq FROM event_log`,
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? 0 : Number(seq);
  }

  private markEventGap(expectedSeq: number, earliestAvailableSeq: number | null, observedSeq: number | null): void {
    const scopes = this.knownScopes();
    const targetScopes = scopes.length > 0 ? scopes : ["project-tracks"];
    for (const scope of targetScopes) {
      this.health.set(scope, {
        state: "event_gap",
        scope,
        last_event_seq: this.lastEventSeq,
        last_synced_at: null,
        event_gap: {
          detected_at: new Date().toISOString(),
          expected_seq: expectedSeq,
          earliest_available_seq: earliestAvailableSeq,
          observed_seq: observedSeq,
        },
        error: null,
      });
    }
  }

  private setCurrent(scope: string): void {
    this.health.set(scope, {
      state: "current",
      scope,
      last_event_seq: this.lastEventSeq,
      last_synced_at: new Date().toISOString(),
      event_gap: null,
      error: null,
    });
  }

  private setState(scope: string, state: ProjectSourceIndexState): void {
    const previous = this.health.get(scope);
    this.health.set(scope, {
      state,
      scope,
      last_event_seq: this.lastEventSeq,
      last_synced_at: previous?.last_synced_at ?? null,
      event_gap: state === "event_gap" ? previous?.event_gap ?? null : null,
      error: null,
    });
  }

  private setError(scope: string, err: unknown): void {
    this.health.set(scope, {
      state: "error",
      scope,
      last_event_seq: this.lastEventSeq,
      last_synced_at: null,
      event_gap: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private withHealth(envelope: ProjectSourcesEnvelope, scope: string): ProjectSourcesEnvelope {
    const sourceIndex = this.healthFor(scope);
    return {
      ...envelope,
      metadata: {
        source: "local_source_index",
        local_visual_state: visualForSourceIndex(sourceIndex),
        source_index: sourceIndex,
      },
    };
  }

  private cacheKey(request: SourceIndexRequest): string {
    const scope = canonicalProjectName(request.project);
    return JSON.stringify({
      project: scope,
      limit: request.limit ?? null,
      type: request.type ?? null,
      agent: request.agent ?? null,
      since: request.since ?? null,
      until: request.until ?? null,
      readState: request.readState ?? null,
      status: request.status ?? null,
      q: request.q ?? null,
    });
  }
}

export function mountProjectTracksRoutes(app: Application, adapter: DbAdapter): void {
  const listCache = new Map<string, { at: number; rows: ProjectListItem[] }>();
  const cacheTtlMs = 30_000;
  const detailCacheMax = 100;

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
        local_visual_state: localHealthVisualState("current", "project index"),
        local_index: {
          state: "current",
          scope: envelope.project.canonical,
          last_event_seq: 0,
          last_synced_at: new Date().toISOString(),
          event_gap: null,
          error: null,
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

  const localIndex = new ProjectLocalIndex(adapter, buildProjectDetail, detailCacheMax);
  const sourceIndex = new ProjectSourceIndex(adapter, (request) => buildProjectSourcesEnvelope(adapter, request), detailCacheMax);

  async function getProjectDetail(project: string): Promise<{ detail: ProjectDetail; cache: "hit" | "miss" | "deduped" }> {
    return localIndex.get(project);
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

  app.get("/projects/:project/sources", async (req: Request<{ project: string }>, res: Response) => {
    const request = sourceRequestFromQuery(req.params.project, req.query);
    try {
      const { envelope, cache } = await sourceIndex.get(request);
      res.setHeader("X-Project-Sources-Cache", cache);
      res.json(envelope);
    } catch (err) {
      const sourceHealth = sourceIndex.healthFor(req.params.project);
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        metadata: {
          source: "local_source_index",
          local_visual_state: visualForSourceIndex(sourceHealth),
          source_index: sourceHealth,
        },
      });
    }
  });

  app.post("/projects/:project/sources/resync", async (req: Request<{ project: string }>, res: Response) => {
    const request = sourceRequestFromQuery(req.params.project, req.query);
    try {
      const envelope = await sourceIndex.boundedResync(request);
      res.json({ ok: true, resync: "bounded", sources: envelope });
    } catch (err) {
      const sourceHealth = sourceIndex.healthFor(req.params.project);
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        metadata: {
          source: "local_source_index",
          local_visual_state: visualForSourceIndex(sourceHealth),
          source_index: sourceHealth,
        },
      });
    }
  });

  app.post("/projects/:project/resync", async (req: Request<{ project: string }>, res: Response) => {
    try {
      const detail = await localIndex.boundedResync(req.params.project);
      res.json({ ok: true, resync: "bounded", detail });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function visualForProjectIndex(health: ProjectLocalIndexHealth): LocalHealthVisual {
  return localHealthVisualState(health.state === "event_gap" ? "event_gap" : health.state, "project index");
}

function visualForSourceIndex(health: ProjectSourceIndexHealth): LocalHealthVisual {
  return localHealthVisualState(health.state === "event_gap" ? "event_gap" : health.state, "source index");
}

function sourceRequestFromQuery(project: string, query: Request["query"]): SourceIndexRequest {
  const limit = Math.min(parseInt(String(query.limit ?? "100"), 10) || 100, 500);
  return {
    project,
    limit,
    type: stringParam(query.type) as ProjectSourceGroup | null,
    agent: stringParam(query.agent),
    since: stringParam(query.since),
    until: stringParam(query.until),
    readState: stringParam(query.read_state) as ProjectSourceReadState | null,
    status: stringParam(query.status) as ProjectSourceFreshnessStatus | null,
    q: stringParam(query.q),
  };
}

function parseEventData(data: EventLogProjectRow["data"]): Record<string, unknown> {
  if (!data) return {};
  if (typeof data === "object") return data;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringParam(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return null;
}

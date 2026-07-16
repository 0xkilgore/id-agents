import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  buildSurfacedArtifactsReadModel,
  executeSurfacedArtifactsSavedView,
  executeSeededSurfacedArtifactsSavedView,
  SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS,
  SURFACED_ARTIFACTS_SAVED_VIEW,
  validateSavedViewPredicateFields,
} from "./read-model.js";
import type { SeededSurfacedArtifactsViewName, SurfacedArtifactHealthEvent, SurfacedArtifactsResponse } from "./types.js";

export interface SurfacedArtifactsRouteDeps {
  resolveTeamId?: (req: Request) => Promise<string>;
  nowMs?: () => number;
}

export function mountSurfacedArtifactsRoutes(app: Application, adapter: DbAdapter, deps: SurfacedArtifactsRouteDeps = {}): void {
  const handler = async (req: Request, res: Response) => {
    try {
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const model = await buildSurfacedArtifactsReadModel(adapter, { limit: Number.isFinite(rawLimit) ? rawLimit : undefined });
      const teamId = deps.resolveTeamId ? await deps.resolveTeamId(req) : "default";
      await recordSurfacingHealthEvents(adapter, teamId, model.health.events, deps.nowMs?.() ?? Date.now());
      const body: SurfacedArtifactsResponse = {
        ok: true,
        schema_version: "surfaced-artifacts.v1",
        generated_at: new Date().toISOString(),
        saved_view: SURFACED_ARTIFACTS_SAVED_VIEW,
        seeded_views: SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS,
        rows: model.rows,
        count: model.rows.length,
        recent_flood: model.recent_flood,
        health: model.health,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.get("/ops/surfaced-artifacts", handler);
  app.get("/surfaced-artifacts", handler);
  app.post("/ops/views/surfaced-artifacts.v1.primary/execute", async (req: Request, res: Response) => {
    try {
      const predicate = (req.body as { query?: unknown; predicate?: unknown } | undefined)?.query
        ?? (req.body as { predicate?: unknown } | undefined)?.predicate
        ?? req.body;
      const errors = validateSavedViewPredicateFields(predicate);
      if (errors.length > 0) {
        res.status(422).json({
          ok: false,
          schema_version: "view-execution.v1",
          view_id: SURFACED_ARTIFACTS_SAVED_VIEW.id,
          generated_at: new Date().toISOString(),
          rows: [],
          count: 0,
          errors,
        });
        return;
      }
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const model = await buildSurfacedArtifactsReadModel(adapter, { limit: Number.isFinite(rawLimit) ? rawLimit : undefined });
      res.json(executeSurfacedArtifactsSavedView(model.rows, predicate));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/ops/views/:viewName/execute", async (req: Request, res: Response) => {
    try {
      const viewName = req.params.viewName as SeededSurfacedArtifactsViewName;
      if (!Object.prototype.hasOwnProperty.call(SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS, viewName)) {
        res.status(404).json({ ok: false, error: "unknown_saved_view", view_name: req.params.viewName });
        return;
      }
      const predicate = (req.body as { query?: unknown; predicate?: unknown } | undefined)?.query
        ?? (req.body as { predicate?: unknown } | undefined)?.predicate
        ?? req.body;
      const seed = SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS[viewName];
      const errors = validateSavedViewPredicateFields({ and: [seed.predicate, predicate] });
      if (errors.length > 0) {
        res.status(422).json({
          ok: false,
          schema_version: "view-execution.v1",
          view_id: seed.id,
          generated_at: new Date().toISOString(),
          rows: [],
          count: 0,
          errors,
        });
        return;
      }
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const model = await buildSurfacedArtifactsReadModel(adapter, { limit: Number.isFinite(rawLimit) ? rawLimit : undefined });
      res.json(executeSeededSurfacedArtifactsSavedView(model.rows, viewName, predicate));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function recordSurfacingHealthEvents(
  adapter: DbAdapter,
  teamId: string,
  events: SurfacedArtifactHealthEvent[],
  occurredAt: number,
): Promise<void> {
  for (const event of events) {
    if (await healthEventAlreadyRecorded(adapter, teamId, event)) continue;
    await adapter.query(
      `INSERT INTO event_log
         (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        event.topic,
        "system:artifact-surfacing",
        event.subject_kind,
        event.subject_id,
        occurredAt,
        JSON.stringify(event.data),
      ],
    );
  }
}

async function healthEventAlreadyRecorded(adapter: DbAdapter, teamId: string, event: SurfacedArtifactHealthEvent): Promise<boolean> {
  const { rows } = await adapter.query<{ c: number | string }>(
    `SELECT COUNT(*) AS c
       FROM event_log
      WHERE team_id = ?
        AND topic = ?
        AND subject_kind = ?
        AND subject_id = ?`,
    [teamId, event.topic, event.subject_kind, event.subject_id],
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

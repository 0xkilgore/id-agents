import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildSurfacedArtifactsReadModel } from "./read-model.js";
import type { SurfacedArtifactsResponse } from "./types.js";

export function mountSurfacedArtifactsRoutes(app: Application, adapter: DbAdapter): void {
  const handler = async (req: Request, res: Response) => {
    try {
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const model = await buildSurfacedArtifactsReadModel(adapter, { limit: Number.isFinite(rawLimit) ? rawLimit : undefined });
      const body: SurfacedArtifactsResponse = {
        ok: true,
        schema_version: "surfaced-artifacts.v1",
        generated_at: new Date().toISOString(),
        rows: model.rows,
        count: model.rows.length,
        recent_flood: model.recent_flood,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.get("/ops/surfaced-artifacts", handler);
  app.get("/surfaced-artifacts", handler);
}

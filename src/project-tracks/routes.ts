import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildProjectTracksEnvelope } from "./read-model.js";

export function mountProjectTracksRoutes(app: Application, adapter: DbAdapter): void {
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

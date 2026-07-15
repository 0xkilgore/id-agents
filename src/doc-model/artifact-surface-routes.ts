// Doc-model substrate slice 2 — HTTP surface for the console's five views.

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  projectActivitySurface,
  projectInboxSurface,
  projectNowSurface,
  projectProjectsSurface,
  projectReportsSurface,
  projectSystemSurface,
} from "./artifact-surfaces.js";

function teamIdParam(req: Request): string {
  const raw = req.query.team_id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "default";
}

export function mountArtifactSurfaceRoutes(app: Application, adapter: DbAdapter): void {
  const route = (
    path: string,
    project: (adapter: DbAdapter, teamId: string) => Promise<unknown>,
  ) => {
    app.get(path, async (req: Request, res: Response) => {
      try {
        res.json(await project(adapter, teamIdParam(req)));
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  route("/doc-model/surfaces/now", projectNowSurface);
  route("/doc-model/surfaces/inbox", projectInboxSurface);
  route("/doc-model/surfaces/activity", projectActivitySurface);
  route("/doc-model/surfaces/projects", projectProjectsSurface);
  route("/doc-model/surfaces/reports", projectReportsSurface);
  route("/doc-model/surfaces/system", projectSystemSurface);
}

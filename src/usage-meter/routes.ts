// Usage Meter — Express routes (GET /usage).
// Read-only; mounts cleanly next to /monitor/* and /metrics/* on the
// manager management app.

import type { Application, Request, Response } from "express";
import type { UsageMeterService } from "./service.js";

export interface UsageMeterRouteOptions {
  service: UsageMeterService;
}

/**
 * Mount usage-meter routes. Pass an Express app (the manager's
 * managementApp) and a configured UsageMeterService instance.
 */
export function mountUsageMeterRoutes(app: Application, opts: UsageMeterRouteOptions): void {
  app.get("/usage", async (_req: Request, res: Response) => {
    try {
      const report = await opts.service.buildReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({
        schema_version: "usage-meter-v2",
        error: err instanceof Error ? err.message : String(err),
        source: "manager-usage-meter",
      });
    }
  });

  // Optional helper: GET /usage/gate returns just the gate snapshot.
  app.get("/usage/gate", async (_req: Request, res: Response) => {
    try {
      const snap = await opts.service.getSnapshotForScheduler();
      res.json(snap);
    } catch (err) {
      res.status(500).json({
        status: "degraded",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

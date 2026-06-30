// Kapelle Fleet Activity — Express route.
//
// GET /fleet/activity — fleet.activity.v1 envelope.
//   ?team=<name>    team to scope to (default "default")
//   ?since=<iso>    inclusive lower-bound watermark ("what changed since I last looked")
//   ?limit=<n>      max events returned (default 50, max 200)
//   ?kinds=<csv>    subset of artifact_produced,dispatch_completed,dispatch_queued

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildFleetActivity, normalizeKinds, normalizeLimit, normalizeSince } from "./read-model.js";

export interface MountFleetActivityRoutesOptions {
  now?: () => Date;
}

export function mountFleetActivityRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountFleetActivityRoutesOptions = {},
): void {
  const now = opts.now ?? (() => new Date());

  app.get("/fleet/activity", async (req: Request, res: Response) => {
    try {
      const generatedAt = now().toISOString();
      const teamName = typeof req.query.team === "string" ? req.query.team : undefined;
      const since = normalizeSince(req.query.since);
      const limit = normalizeLimit(req.query.limit);
      const kinds = normalizeKinds(req.query.kinds) ?? undefined;
      const response = await buildFleetActivity(adapter, {
        generatedAt,
        teamName,
        // Pass the raw value through so the read-model can warn on a bad
        // `since`; it re-normalizes internally.
        since: typeof req.query.since === "string" ? req.query.since : since,
        limit,
        kinds,
      });
      res.json(response);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

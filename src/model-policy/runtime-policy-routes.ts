// SPDX-License-Identifier: MIT

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { ModelPolicyService } from "./policy.js";
import { readRuntimePolicies } from "./runtime-policy.js";

export interface RuntimePolicyRouteOptions {
  adapter: DbAdapter;
  getTeamId: (req: Request) => Promise<string>;
  getModelPolicy?: () => ModelPolicyService | null;
}

export function mountRuntimePolicyRoutes(app: Application, opts: RuntimePolicyRouteOptions): void {
  app.get("/runtime-policy", async (req: Request, res: Response) => {
    try {
      const teamId = await opts.getTeamId(req);
      const readModel = await readRuntimePolicies({
        adapter: opts.adapter,
        teamId,
        modelPolicy: opts.getModelPolicy?.() ?? null,
      });
      return res.json(readModel);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        schema_version: "runtime-policy-v1",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

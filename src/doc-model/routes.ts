// DV3 — GET /search unified doc-model FTS read-model route.

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { planCorpusSearch } from "../corpus-search/lane.js";
import type { ReadModelEnvelope } from "../outputs/entry.js";
import {
  DOC_MODEL_SEARCH_MAX_LIMIT,
  parseDocModelSearchKinds,
  searchDocModel,
  type DocModelSearchHit,
} from "./search.js";

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function mountDocModelSearchRoutes(app: Application, adapter: DbAdapter): void {
  app.get("/search", async (req: Request, res: Response) => {
    try {
      const q = asString(req.query.q) ?? "";
      const limit = Math.min(parseInt(asString(req.query.limit) ?? "50", 10) || 50, DOC_MODEL_SEARCH_MAX_LIMIT);
      const offset = Math.max(parseInt(asString(req.query.offset) ?? "0", 10) || 0, 0);
      const kinds = parseDocModelSearchKinds(asString(req.query.kind) ?? asString(req.query.kinds));

      const plan = planCorpusSearch(q);
      if (!plan.ok && plan.reason === "external_lane_disabled") {
        return res.status(400).json({ error: plan.error, lane: plan.lane, reason: plan.reason });
      }
      const searchQuery = plan.ok ? plan.query : q;

      const { items, limit: boundedLimit, offset: boundedOffset } = await searchDocModel(adapter, searchQuery, {
        limit,
        offset,
        kinds,
      });

      const envelope: ReadModelEnvelope<DocModelSearchHit> = {
        schema_version: "read-model.v1",
        generated_at: new Date().toISOString(),
        items,
        count: items.length,
        limit: boundedLimit,
        offset: boundedOffset,
        source: { read_path: "substrate", projection: "doc_model_search" },
        parity: { status: "unchecked" },
      };
      res.json(envelope);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

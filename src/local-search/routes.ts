import type { Application, Request, Response } from "express";
import {
  LOCAL_SEARCH_MAX_LIMIT,
  createLocalSearchIndex,
  parseLocalSearchBool,
  parseLocalSearchTypes,
  searchLocalIndex,
  type LocalSearchDocument,
  type LocalSearchIndexHealth,
  type LocalSearchQuery,
  type LocalSearchReadState,
  type LocalSearchFreshness,
} from "./index.js";

export interface LocalSearchRouteDeps {
  loadDocuments: () => Promise<LocalSearchDocument[]>;
  loadHealth?: () => Promise<Partial<LocalSearchIndexHealth>>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export function mountLocalSearchRoutes(app: Application, deps: LocalSearchRouteDeps): void {
  app.get("/read-model/search", async (req: Request, res: Response) => {
    try {
      const documents = await deps.loadDocuments();
      const health = deps.loadHealth ? await deps.loadHealth() : {};
      const query: LocalSearchQuery = {
        q: asString(req.query.q) ?? "",
        types: parseLocalSearchTypes(asString(req.query.types) ?? asString(req.query.type)),
        project: asString(req.query.project),
        task: asString(req.query.task),
        status: asString(req.query.status),
        readState: asString(req.query.read_state) as LocalSearchReadState | undefined,
        needsReview: parseLocalSearchBool(asString(req.query.needs_review)),
        author: asString(req.query.author),
        agent: asString(req.query.agent),
        freshness: asString(req.query.freshness) as LocalSearchFreshness | undefined,
        limit: Math.min(parseInt(asString(req.query.limit) ?? "25", 10) || 25, LOCAL_SEARCH_MAX_LIMIT),
        cursor: asString(req.query.cursor),
      };
      res.json(searchLocalIndex(createLocalSearchIndex(documents, health), query));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/read-model/search/health", async (_req: Request, res: Response) => {
    try {
      const documents = await deps.loadDocuments();
      const health = deps.loadHealth ? await deps.loadHealth() : {};
      res.json(createLocalSearchIndex(documents, health).health);
    } catch (err) {
      res.status(500).json({ state: "error", error: err instanceof Error ? err.message : String(err) });
    }
  });
}

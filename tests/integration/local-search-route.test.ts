import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { mountLocalSearchRoutes } from "../../src/local-search/routes.js";
import type { LocalSearchDocument } from "../../src/local-search/index.js";

function artifact(overrides: Partial<LocalSearchDocument> & Pick<LocalSearchDocument, "id" | "title">): LocalSearchDocument {
  return {
    entityType: "artifact",
    project: "kapelle",
    track: "T-LOCALREAD",
    task: null,
    agent: "hopper",
    author: "hopper",
    status: "available",
    readState: "unknown",
    needsReview: false,
    updatedAt: "2026-07-10T15:00:00.000Z",
    matchFields: {},
    freshness: "current",
    openTarget: { kind: "artifact", ref: overrides.id, route: `/artifacts/${encodeURIComponent(overrides.id)}` },
    ...overrides,
  };
}

function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await response.json();
        server.close(() => resolve({ status: response.status, body }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe("local search route", () => {
  it("returns ranked highlighted scoped results without reloading the full index for scope refinement", async () => {
    const documents: LocalSearchDocument[] = [
      artifact({
        id: "artifact:pool-result-ux",
        title: "Backend pool result UX",
        project: "kapelle",
        track: "T-LOCALREAD",
        agent: "hopper",
        updatedAt: "2026-07-10T15:10:00.000Z",
        matchFields: {
          body: "The local-first search result UX should show ranked context with keyboard navigation.",
        },
      }),
      artifact({
        id: "artifact:pool-routing",
        title: "Backend pool routing",
        project: "kapelle",
        track: "T-POOL",
        agent: "hopper",
        updatedAt: "2026-07-10T15:09:00.000Z",
        matchFields: {
          body: "The backend pool owns local-first search routing and queue policy.",
        },
      }),
      artifact({
        id: "artifact:unrelated",
        title: "Cleveland Park notes",
        project: "cleveland-park",
        track: "events",
        agent: "maestra",
        updatedAt: "2026-07-10T15:08:00.000Z",
        matchFields: {
          body: "Search result copy for a different project.",
        },
      }),
    ];
    let loadCount = 0;
    const app = express();
    mountLocalSearchRoutes(app, {
      loadDocuments: async () => {
        loadCount += 1;
        return documents;
      },
      loadHealth: async () => ({
        state: "ready",
        indexedAt: "2026-07-10T15:11:00.000Z",
      }),
    });

    const unscoped = await getJson(app, "/read-model/search?q=search&types=artifact&limit=10");
    const scoped = await getJson(app, "/read-model/search?q=search&types=artifact&project=kapelle&track=T-LOCALREAD&agent=hopper&limit=10");

    expect(unscoped.status).toBe(200);
    expect(unscoped.body.items.map((item: any) => item.id)).toEqual([
      "artifact:pool-result-ux",
      "artifact:pool-routing",
      "artifact:unrelated",
    ]);
    expect(unscoped.body.items[0]).toMatchObject({
      rank: 1,
      resultDomId: "local-search-result-1",
      snippet_highlights: [
        {
          field: "body",
          text: "The local-first search result UX should show ranked context with keyboard navigation.",
          ranges: [{ start: 16, end: 22 }],
        },
      ],
    });
    expect(unscoped.body.ux.keyboardNavigation).toMatchObject({
      role: "listbox",
      itemRole: "option",
      orientation: "vertical",
    });

    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((item: any) => item.id)).toEqual(["artifact:pool-result-ux"]);
    expect(scoped.body.query).toMatchObject({
      project: "kapelle",
      track: "T-LOCALREAD",
      agent: "hopper",
    });
    expect(loadCount).toBe(1);
  });
});

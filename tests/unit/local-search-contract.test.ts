import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import {
  LOCAL_SEARCH_INDEX_SCHEMA_VERSION,
  LOCAL_SEARCH_SCHEMA_VERSION,
  createLocalSearchIndex,
  searchLocalIndex,
  type LocalSearchDocument,
} from "../../src/local-search/index.js";
import { mountLocalSearchRoutes } from "../../src/local-search/routes.js";
import {
  localHealthVisualForFreshness,
  localHealthVisualForIndex,
  localHealthVisualState,
  type LocalHealthVisualState,
} from "../../src/local-search/visual-state.js";

const NOW = new Date("2026-07-07T17:00:00.000Z");

const fixtureDocs: LocalSearchDocument[] = [
  {
    entityType: "artifact",
    id: "artifact:fall-fest-rundown",
    title: "Same-Morning Fall Fest Rundown for Chris",
    project: "cleveland-park",
    task: "fall-fest-load-loop",
    agent: "maestra",
    author: "rams",
    status: "available",
    readState: "unread",
    needsReview: true,
    updatedAt: "2026-07-07T15:40:00.000Z",
    matchFields: {
      title: "Same-Morning Fall Fest Rundown for Chris",
      body: "Cached body contains vendor staging phrase only present in hydrated artifact text.",
      tags: ["urgent", "project-critical"],
      path: "/cleveland-park/output/fall-fest.md",
    },
    freshness: "current",
    openTarget: { kind: "artifact", ref: "artifact:fall-fest-rundown", route: "/artifacts/artifact:fall-fest-rundown" },
  },
  {
    entityType: "project",
    id: "project:cleveland-park",
    title: "Cleveland Park",
    project: "cleveland-park",
    status: "active",
    updatedAt: "2026-07-07T14:00:00.000Z",
    matchFields: {
      name: "Cleveland Park",
      watchedRoots: ["/Users/kilgore/Dropbox/Code/cleveland-park/output"],
    },
    freshness: "current",
    openTarget: { kind: "project", ref: "cleveland-park", route: "/projects/cleveland-park" },
  },
  {
    entityType: "task",
    id: "task:dispatch-title",
    title: "Dispatch title: prep Zach safe-haven readout",
    project: "kapelle",
    task: "prep-zach-safe-haven",
    agent: "continuous-orchestration",
    author: "substrate-api-codex",
    status: "doing",
    readState: "read",
    updatedAt: "2026-07-07T16:10:00.000Z",
    matchFields: {
      title: "Dispatch title: prep Zach safe-haven readout",
      dispatchTitle: "Task/dispatch title fixture for local search",
      description: "Needs substrate contract follow-up.",
    },
    freshness: "current",
    openTarget: { kind: "task", ref: "prep-zach-safe-haven", route: "/tasks/prep-zach-safe-haven" },
  },
  {
    entityType: "artifact",
    id: "artifact:stale-closeout",
    title: "Stale closeout with index gap",
    project: "kapelle",
    task: "stale-index-gap",
    agent: "substrate-api-codex",
    author: "substrate-api-codex",
    status: "needs_review",
    readState: "read_but_has_new_activity",
    needsReview: true,
    updatedAt: "2026-07-07T13:00:00.000Z",
    matchFields: {
      title: "Stale closeout with index gap",
      body: "Index gap recovery should keep stale rows labeled stale.",
    },
    freshness: "stale",
    openTarget: { kind: "artifact", ref: "artifact:stale-closeout", route: "/artifacts/artifact:stale-closeout" },
  },
];

function ids(q: Parameters<typeof searchLocalIndex>[1]) {
  return searchLocalIndex(createLocalSearchIndex(fixtureDocs), q, NOW).items.map((item) => item.id);
}

async function bootApp() {
  const app = express();
  mountLocalSearchRoutes(app, {
    loadDocuments: async () => fixtureDocs,
    loadHealth: async () => ({
      state: "index_partial",
      indexedAt: "2026-07-07T16:59:00.000Z",
      partialScopes: ["artifact"],
      staleReason: "artifact body cache catch-up in progress",
    }),
  });
  return app;
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

describe("local search v0 contract", () => {
  it("returns the frontend-facing schema and required hit fields", () => {
    const response = searchLocalIndex(createLocalSearchIndex(fixtureDocs), { q: "Fall Fest", limit: 5 }, NOW);

    expect(response.schemaVersion).toBe(LOCAL_SEARCH_SCHEMA_VERSION);
    expect(response.indexSchemaVersion).toBe(LOCAL_SEARCH_INDEX_SCHEMA_VERSION);
    expect(response.items[0]).toMatchObject({
      entityType: "artifact",
      id: "artifact:fall-fest-rundown",
      title: "Same-Morning Fall Fest Rundown for Chris",
      project: "cleveland-park",
      task: "fall-fest-load-loop",
      agent: "maestra",
      author: "rams",
      status: "available",
      readState: "unread",
      freshness: "current",
      local_visual_state: {
        state: "current",
        label: "Current",
        tone: "neutral",
        scope: "artifact",
      },
      openTarget: { kind: "artifact" },
    });
    expect(response.items[0].matchFields).toContain("title");
    expect(response.items[0].snippet).toContain("Fall Fest");
  });

  it("finds a known artifact title", () => {
    expect(ids({ q: "Same Morning Fall Fest", types: ["artifact"] })).toEqual(["artifact:fall-fest-rundown"]);
  });

  it("finds a cached body-only phrase and reports body as the match field", () => {
    const response = searchLocalIndex(createLocalSearchIndex(fixtureDocs), { q: "vendor staging phrase" }, NOW);

    expect(response.items.map((item) => item.id)).toEqual(["artifact:fall-fest-rundown"]);
    expect(response.items[0].matchFields).toContain("body");
    expect(response.items[0].snippet).toContain("vendor staging phrase");
  });

  it("finds project names", () => {
    expect(ids({ q: "Cleveland Park", types: ["project"] })).toEqual(["project:cleveland-park"]);
  });

  it("finds task and dispatch titles", () => {
    expect(ids({ q: "safe haven readout", types: ["task"] })).toEqual(["task:dispatch-title"]);
    expect(ids({ q: "dispatch title fixture", types: ["task"] })).toEqual(["task:dispatch-title"]);
  });

  it("filters unread and needs-review rows", () => {
    expect(ids({ readState: "unread", needsReview: true })).toEqual(["artifact:fall-fest-rundown"]);
  });

  it("filters by author and agent independently", () => {
    expect(ids({ author: "rams" })).toEqual(["artifact:fall-fest-rundown"]);
    expect(ids({ agent: "continuous-orchestration" })).toEqual(["task:dispatch-title"]);
  });

  it("surfaces stale rows and index_partial health", () => {
    const response = searchLocalIndex(
      createLocalSearchIndex(fixtureDocs, {
        state: "index_partial",
        indexedAt: "2026-07-07T16:59:00.000Z",
        partialScopes: ["artifact"],
        staleReason: "artifact body cache catch-up in progress",
      }),
      { freshness: "stale" },
      NOW,
    );

    expect(response.items.map((item) => item.id)).toEqual(["artifact:stale-closeout"]);
    expect(response.items[0].freshness).toBe("stale");
    expect(response.index).toMatchObject({
      state: "index_partial",
      partialScopes: ["artifact"],
      staleReason: "artifact body cache catch-up in progress",
    });
    expect(response.index_visual_state).toMatchObject({
      state: "index_partial",
      label: "Partial index",
      tone: "warning",
      scope: "artifact index",
    });
  });

  it("mounts /read-model/search with query filters", async () => {
    const app = await bootApp();
    const { status, body } = await getJson(app, "/read-model/search?q=vendor%20staging&types=artifact&author=rams");

    expect(status).toBe(200);
    expect(body.schemaVersion).toBe("read_model.search.v1");
    expect(body.items.map((item: any) => item.id)).toEqual(["artifact:fall-fest-rundown"]);
    expect(body.index.state).toBe("index_partial");
    expect(body.index_visual_state.state).toBe("index_partial");
  });

  it("covers every restrained local health visual state", () => {
    const states: LocalHealthVisualState[] = [
      "current",
      "syncing",
      "stale",
      "event_gap",
      "index_building",
      "index_partial",
      "mutation_failed",
      "error",
    ];

    for (const state of states) {
      const visual = localHealthVisualState(state, "fixture");
      expect(visual).toMatchObject({ state, scope: "fixture" });
      expect(visual.label.length).toBeGreaterThan(0);
      expect(visual.message).toContain(".");
    }

    expect(localHealthVisualForFreshness("syncing", "artifact").state).toBe("syncing");
    expect(localHealthVisualForFreshness("event_gap", "task").state).toBe("event_gap");
    expect(localHealthVisualForFreshness("mutation_failed", "artifact").state).toBe("mutation_failed");
    expect(localHealthVisualForFreshness("error", "project").state).toBe("error");
    expect(localHealthVisualForIndex({
      state: "indexing",
      indexedAt: NOW.toISOString(),
      documentCount: 0,
    }).state).toBe("index_building");
    expect(localHealthVisualForIndex({
      state: "index_partial",
      indexedAt: NOW.toISOString(),
      documentCount: 2,
      partialScopes: ["task", "artifact"],
    })).toMatchObject({ state: "index_partial", scope: "task, artifact index" });
  });
});

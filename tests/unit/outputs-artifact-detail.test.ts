import express, { type Express } from "express";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { artifactIdFromPath, migrateOutputsTables, registerArtifact, registerArtifactPathDelivery } from "../../src/outputs/storage.js";
import type { FilesystemArtifactReconcileResult } from "../../src/outputs/filesystem-reconciler.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";

let app: Express;
let adapter: SqliteAdapter;
let tmp: string;

async function setup(): Promise<void> {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    autoIngest: false,
    actionCooldownMs: 0,
    env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
  });
  tmp = mkdtempSync(path.join(tmpdir(), "artifact-detail-"));
}

afterEach(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await adapter.close();
});

beforeEach(setup);

async function call(
  method: "GET" | "POST",
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; body: any; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${requestPath}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        const parsed = text ? JSON.parse(text) : null;
        server.close(() => resolve({ status: response.status, body: parsed, headers: response.headers }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function callRaw(
  requestPath: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${requestPath}`);
        const text = await response.text();
        server.close(() => resolve({ status: response.status, text, headers: response.headers }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function catalogFile(
  name: string,
  title = "Human artifact title",
  producedAt = "2026-06-27T12:00:00.000Z",
): Promise<{ filePath: string; artifactId: string }> {
  const filePath = path.join(tmp, name);
  writeFileSync(filePath, "# Detail Body\n\nFast switch content.\n");
  const artifactId = artifactIdFromPath(filePath);
  await registerArtifact(
    adapter,
    {
      artifact_id: artifactId,
      basename: name,
      agent: "regina",
      tag: "report",
      abs_path: filePath,
      title,
      produced_at: producedAt,
      source: "manual",
      availability: "present",
    },
    "2026-06-27T12:01:00.000Z",
  );
  return { filePath, artifactId };
}

function emptyReconcileResult(): FilesystemArtifactReconcileResult {
  return {
    roots_seen: 0,
    roots_scanned: 0,
    files_seen: 0,
    files_recent: 0,
    inserted: 0,
    updated: 0,
    evidence_inserted: 0,
    evidence_updated: 0,
    skipped: 0,
    marked_missing: 0,
    restored_present: 0,
  };
}

async function seedQueryResultArtifact(name: string, body: string): Promise<{ artifactId: string; filePath: string }> {
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('default', 'default')`, []);
  const agents = new SqliteAgentsRepo(adapter);
  await agents.upsert({
    team_id: "default",
    id: "agent_1",
    name: "cursor-coder-pilot",
    type: "claude",
    model: "test",
    port: 0,
    endpoint: "http://localhost:0",
    working_directory: null,
    status: "running",
    created_at: Date.now(),
    metadata: {},
  });

  const outputDir = path.join(tmp, "agent_1781286770776_sq6usr9", "output");
  mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, name);
  writeFileSync(filePath, body);

  const queries = new SqliteQueriesRepo(adapter);
  await queries.upsert("default", "agent_1", {
    query_id: "query_1783708383412_bfv84pi",
    status: "completed",
    completed: Date.now(),
    result: { result: `Wrote the reconciled key to ${filePath}` },
    manager_dispatch_id: "phid:disp-93238fa4a6d93e91",
  });

  return { artifactId: `query:query_1783708383412_bfv84pi:${name}`, filePath };
}

function remountWithDefaultTeam(): Express {
  const app2 = express();
  app2.use(express.json());
  mountOutputsRoutes(app2, adapter, {
    autoIngest: false,
    actionCooldownMs: 0,
    env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
    resolveTeamId: async () => "default",
  });
  return app2;
}

describe("GET /artifacts/:id/detail", () => {
  it("hydrates the reader pane from one bounded detail projection", async () => {
    const { artifactId } = await catalogFile("normal.md", "Readable title");
    await call("POST", `/artifacts/${artifactId}/approve`, {
      actor_ref: "user:chris",
      note: "approved",
      comment: "ready",
    });

    const res = await call("GET", `/artifacts/${artifactId}/detail`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-artifact-detail-cache")).toBe("miss");
    expect(res.body).toMatchObject({
      ok: true,
      schema_version: "artifact.detail.v1",
      artifact_id: artifactId,
      displayTitle: "Readable title",
      metadata: {
        display_title: "Readable title",
        basename: "normal.md",
        agent: "regina",
        tag: "report",
        availability: "present",
        local_visual_state: {
          state: "current",
          label: "Current",
          tone: "neutral",
          scope: "artifact detail",
        },
      },
      body: {
        kind: "markdown",
        source: "file",
        truncated: false,
      },
      render: {
        renderer: "markdown",
      },
      review: {
        is_approved: true,
        comments_count: 1,
        timeline_count: 2,
      },
    });
    expect(res.body.body.text).toContain("Fast switch content.");
    expect(res.body.comments[0].body).toBe("ready");
    expect(res.body.timeline.map((e: any) => e.kind)).toEqual(["comment", "approval"]);
    expect(res.body.provenance.entry.title).toBe("Readable title");
    expect(res.body.provenance.entry.local_visual_state.state).toBe("current");
  });

  it("includes restrained local health state on artifact list rows", async () => {
    const { artifactId } = await catalogFile("list.md", "Listed title");

    const res = await call("GET", "/outputs/inbox");

    expect(res.status).toBe(200);
    expect(res.body.items.find((item: any) => item.artifact_id === artifactId)).toMatchObject({
      artifact_id: artifactId,
      local_visual_state: {
        state: "current",
        label: "Current",
        tone: "neutral",
        scope: "artifact",
      },
    });
  });

  it("returns cache hits for repeated reads and invalidates after comments", async () => {
    const { artifactId } = await catalogFile("cache.md");

    const first = await call("GET", `/artifacts/${artifactId}/detail`);
    const second = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(first.headers.get("x-artifact-detail-cache")).toBe("miss");
    expect(second.headers.get("x-artifact-detail-cache")).toBe("hit");
    expect(second.body.review.comments_count).toBe(0);

    const comment = await call("POST", `/artifacts/${artifactId}/comments`, {
      actor_ref: "user:liz",
      body: "invalidate this artifact",
    });
    expect(comment.status).toBe(200);

    const after = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(after.headers.get("x-artifact-detail-cache")).toBe("miss");
    expect(after.body.review.comments_count).toBe(1);
    expect(after.body.comments[0].body).toBe("invalidate this artifact");
  });

  it("serves body cached during direct artifact registration after the source file is removed", async () => {
    const filePath = path.join(tmp, "registered-direct.md");
    writeFileSync(filePath, "# Direct Registration\n\nReadable from registration cache.\n");
    const artifactId = artifactIdFromPath(filePath);

    await registerArtifact(
      adapter,
      {
        artifact_id: artifactId,
        basename: "registered-direct.md",
        agent: "backend-pool",
        tag: "checkpoint",
        abs_path: filePath,
        title: "Direct Registration",
        produced_at: "2026-07-09T12:00:00.000Z",
        source: "manual",
      },
      "2026-07-09T12:01:00.000Z",
    );
    unlinkSync(filePath);

    const detail = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body.body).toMatchObject({
      kind: "markdown",
      source: "artifact_body_cache",
      body_unavailable: false,
      cache: {
        freshness: "current",
      },
    });
    expect(detail.body.body.text).toContain("Readable from registration cache.");
    expect(detail.body.metadata.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.body.body.cache.content_hash).toBe(detail.body.metadata.content_hash);

    const copy = await callRaw(`/artifacts/${artifactId}/copy-text`);
    expect(copy.status).toBe(200);
    expect(copy.text).toContain("Readable from registration cache.");
  });

  it("serves body cached by the artifact registration API after the source file is removed", async () => {
    const filePath = path.join(tmp, "registered-api.md");
    writeFileSync(filePath, "# API Registration\n\nReadable from API cache.\n");
    const artifactId = artifactIdFromPath(filePath);

    const registered = await call("POST", "/artifacts/register", {
      basename: "registered-api.md",
      agent: "backend-pool",
      tag: "checkpoint",
      abs_path: filePath,
      title: "API Registration",
      produced_at: "2026-07-09T12:10:00.000Z",
      source: "manual",
    });
    expect(registered.status).toBe(200);
    expect(registered.body.artifact_id).toBe(artifactId);

    unlinkSync(filePath);

    const detail = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body.displayTitle).toBe("API Registration");
    expect(detail.body.body).toMatchObject({
      kind: "markdown",
      source: "artifact_body_cache",
      body_unavailable: false,
      cache: {
        freshness: "current",
      },
    });
    expect(detail.body.body.text).toContain("Readable from API cache.");
    expect(detail.body.metadata.content_hash).toMatch(/^[a-f0-9]{64}$/);

    const copy = await callRaw(`/artifacts/${artifactId}/copy-text`);
    expect(copy.status).toBe(200);
    expect(copy.text).toContain("Readable from API cache.");
  });

  it("preserves encoded-path fallback for uncataloged artifacts", async () => {
    const filePath = path.join(tmp, "encoded.md");
    writeFileSync(filePath, "# Encoded\n\nPath fallback.\n");
    const encoded = Buffer.from(filePath, "utf8").toString("base64url");
    const artifactId = artifactIdFromPath(filePath);

    const res = await call("GET", `/artifacts/detail?path=${encodeURIComponent(encoded)}`);

    expect(res.status).toBe(200);
    expect(res.body.artifact_id).toBe(artifactId);
    expect(res.body.resolved_from).toBe("encoded_path");
    expect(res.body.displayTitle).toBe("encoded.md");
    expect(res.body.body.text).toContain("Path fallback.");
    expect(res.body.metadata.abs_path).toBe(filePath);
    expect(res.body.metadata.local_visual_state).toMatchObject({
      state: "stale",
      scope: "artifact catalog",
    });
  });

  it("returns a typed 404 for missing artifacts", async () => {
    const res = await call("GET", "/artifacts/art-missing/detail");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      ok: false,
      code: "artifact_not_found",
      artifact_id: "art-missing",
    });
  });

  it("does not full-scan again when navigating to an adjacent already-indexed artifact", async () => {
    const first = await catalogFile("seeded-a.md", "Seeded A", "2026-06-27T12:00:00.000Z");
    const second = await catalogFile("seeded-b.md", "Seeded B", "2026-06-27T12:01:00.000Z");
    let fullScanCalls = 0;
    let catalogListCalls = 0;
    const originalQuery = adapter.query.bind(adapter);
    adapter.query = (async (...args: Parameters<typeof originalQuery>) => {
      if (
        typeof args[0] === "string" &&
        /\bFROM artifacts\b[\s\S]*\bORDER BY produced_at DESC\b/i.test(args[0])
      ) {
        catalogListCalls += 1;
      }
      return originalQuery(...args);
    }) as typeof adapter.query;

    app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, {
      autoIngest: false,
      actionCooldownMs: 0,
      env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
      filesystemArtifactRoots: async () => [{ agent: "regina", workingDirectory: tmp }],
      filesystemReconciler: async () => {
        fullScanCalls += 1;
        return emptyReconcileResult();
      },
    });

    try {
      const firstDetail = await call("GET", `/artifacts/${first.artifactId}/detail`);
      const secondDetail = await call("GET", `/artifacts/${second.artifactId}/detail`);
      const coldDetail = await call("GET", "/artifacts/art-cold-miss/detail");

      expect(firstDetail.status).toBe(200);
      expect(firstDetail.headers.get("x-artifact-detail-cache")).toBe("miss");
      expect(firstDetail.body.body.text).toContain("Fast switch content.");
      expect(firstDetail.body.adjacent_prefetch.previous.artifact_id).toBe(second.artifactId);
      expect(secondDetail.status).toBe(200);
      expect(secondDetail.headers.get("x-artifact-detail-cache")).toBe("hit");
      expect(secondDetail.body.adjacent_prefetch.next.artifact_id).toBe(first.artifactId);
      expect(coldDetail.status).toBe(404);
      expect(fullScanCalls).toBe(1);
      expect(catalogListCalls).toBe(1);
    } finally {
      adapter.query = originalQuery as typeof adapter.query;
    }
  });

  it("serves registered html body, copy text, and download from cache when the source path disappears", async () => {
    const filePath = path.join(tmp, "fresh-report.html");
    writeFileSync(filePath, "<h1>Coming Month Cash-Flow Preview</h1><p>Readable without sync.</p>");
    const registered = await registerArtifactPathDelivery(
      adapter,
      {
        abs_path: filePath,
        agent: "finances",
        produced_at: "2026-07-08T12:00:00.000Z",
        title: "Coming Month Cash-Flow Preview",
        project_ref: "finances",
        dispatch_ref: "phid:disp-fixture",
        source_host: "M4",
      },
      "2026-07-08T12:01:00.000Z",
    );
    unlinkSync(filePath);

    const detail = await call("GET", `/artifacts/${registered.row.artifact_id}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      artifact_id: registered.row.artifact_id,
      stableUrl: `/artifacts/${registered.row.artifact_id}/detail`,
      copyTextUrl: `/artifacts/${registered.row.artifact_id}/copy-text`,
      downloadUrl: `/artifacts/${registered.row.artifact_id}/download`,
      metadata: {
        media_type: "text/html",
        project_ref: "finances",
        dispatch_ref: "phid:disp-fixture",
        source_host: "M4",
        availability: "missing",
      },
      body: {
        kind: "html",
        source: "artifact_body_cache",
        error: "ENOENT",
        cache: {
          freshness: "current",
        },
      },
      render: {
        renderer: "html",
        mime_type: "text/html; charset=utf-8",
      },
      delivery: {
        bodyRenderable: true,
        bodyUnavailable: false,
        sourceStatus: "missing",
        discoveredBy: "agent_done",
        freshness: "current",
      },
    });
    expect(detail.body.metadata.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.body.body.cache.content_hash).toBe(detail.body.metadata.content_hash);
    expect(detail.body.body.cache.version_key).toBe(`sha256:${detail.body.metadata.content_hash}`);
    expect(detail.body.body.text).toContain("Readable without sync.");

    const copy = await callRaw(`/artifacts/${registered.row.artifact_id}/copy-text`);
    expect(copy.status).toBe(200);
    expect(copy.headers.get("content-type")).toContain("text/plain");
    expect(copy.text).toContain("Coming Month Cash-Flow Preview");

    const download = await callRaw(`/artifacts/${registered.row.artifact_id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("fresh-report.html");
    expect(download.text).toContain("Readable without sync.");
  });
});

// 2026-07-10 Spencer-demo bug: clicking a surfaced artifact link whose id came
// from GET /artifacts (the bulk catalog feed, which synthesizes rows for
// query-result and dispatch-result artifacts read-time from the queries /
// dispatch_scheduler_queue tables) 404'd on GET /artifacts/:id/detail with
// "Moved or unavailable artifact", even though the manager's own bulk feed
// reported the exact same id as status "available" / exists true. Root cause:
// getArtifact() looks the id up in the persisted `artifacts` catalog table,
// which query:/dispatch: synthesized ids are never written to. These tests
// pin the fix: buildArtifactDetail must fall back to the live queries /
// dispatch_scheduler_queue source rows when the direct catalog lookup misses.
describe("GET /artifacts/:id/detail — query:/dispatch: synthesized ids", () => {
  it("downloads a query:<query_id>:<basename> id the direct catalog table never received a row for", async () => {
    const { artifactId } = await seedQueryResultArtifact(
      "download-live-source.md",
      "# Live Download\n\nDownload body from query result source.\n",
    );
    const prevApp = app;
    app = remountWithDefaultTeam();
    try {
      const res = await callRaw(`/artifacts/${encodeURIComponent(artifactId)}/download`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("download-live-source.md");
      expect(res.text).toContain("Download body from query result source.");
    } finally {
      app = prevApp;
    }
  });

  it("reports present review availability for a query:<query_id>:<basename> id with only a live source row", async () => {
    const { artifactId } = await seedQueryResultArtifact(
      "review-live-source.md",
      "# Live Review\n\nReview body from query result source.\n",
    );
    const prevApp = app;
    app = remountWithDefaultTeam();
    try {
      const res = await call("GET", `/artifacts/${encodeURIComponent(artifactId)}/review`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        schema_version: "artifact.review.v1",
        artifact_id: artifactId,
        availability: "present",
        catalog: {
          artifact_id: artifactId,
          basename: "review-live-source.md",
          agent: "cursor-coder-pilot",
          availability: "present",
          dispatch_ref: "phid:disp-93238fa4a6d93e91",
        },
      });
    } finally {
      app = prevApp;
    }
  });

  it("hydrates a query:<query_id>:<basename> id the direct catalog table never received a row for", async () => {
    await adapter.query(`INSERT INTO teams (id, name) VALUES ('default', 'default')`, []);
    const agents = new SqliteAgentsRepo(adapter);
    await agents.upsert({
      team_id: "default",
      id: "agent_1",
      name: "cursor-coder-pilot",
      type: "claude",
      model: "test",
      port: 0,
      endpoint: "http://localhost:0",
      working_directory: null,
      status: "running",
      created_at: Date.now(),
      metadata: {},
    });

    // extractOutputPaths() only recognizes absolute paths with an `/output/`
    // segment (matching real agent working-directory output layout).
    const outputDir = path.join(tmp, "agent_1781286770776_sq6usr9", "output");
    mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, "cleveland-park-2026-07-09-reconciled-speaker-key.md");
    writeFileSync(filePath, "# Reconciled Speaker Key\n\nBrand new query-result artifact.\n");

    const queries = new SqliteQueriesRepo(adapter);
    await queries.upsert("default", "agent_1", {
      query_id: "query_1783708383412_bfv84pi",
      status: "completed",
      completed: Date.now(),
      result: { result: `Wrote the reconciled key to ${filePath}` },
      manager_dispatch_id: "phid:disp-93238fa4a6d93e91",
    });

    const artifactId = `query:query_1783708383412_bfv84pi:cleveland-park-2026-07-09-reconciled-speaker-key.md`;

    let app2 = express();
    app2.use(express.json());
    mountOutputsRoutes(app2, adapter, {
      autoIngest: false,
      actionCooldownMs: 0,
      env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
      resolveTeamId: async () => "default",
    });
    const prevApp = app;
    app = app2;
    try {
      const res = await call("GET", `/artifacts/${encodeURIComponent(artifactId)}/detail`);

      expect(res.status).toBe(200);
      expect(res.body.artifact_id).toBe(artifactId);
      expect(res.body.resolved_from).toBe("artifact_id");
      expect(res.body.metadata).toMatchObject({
        basename: "cleveland-park-2026-07-09-reconciled-speaker-key.md",
        agent: "cursor-coder-pilot",
        dispatch_ref: "phid:disp-93238fa4a6d93e91",
        availability: "present",
      });
      expect(res.body.body.kind).toBe("markdown");
      expect(res.body.body.body_unavailable).toBe(false);
      expect(res.body.body.text).toContain("Brand new query-result artifact.");
      expect(res.body.delivery.bodyUnavailable).toBe(false);
    } finally {
      app = prevApp;
    }
  });

  it("hydrates a dispatch:<dispatch_phid> id the direct catalog table never received a row for", async () => {
    const filePath = path.join(tmp, "dispatch-result-report.md");
    writeFileSync(filePath, "# Dispatch Result\n\nSynthesized from dispatch_scheduler_queue.\n");
    const dispatchPhid = "phid:disp-live-source-fixture";
    const nowIso = new Date().toISOString();

    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown,
          provider, runtime, status, not_before_at, completed_at, updated_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dispatchPhid,
        "default",
        "query_live_source_fixture",
        "backend-pool",
        "user:chris",
        "manager",
        "Dispatch result fixture",
        "body",
        "manager",
        "claude",
        "done",
        nowIso,
        nowIso,
        nowIso,
        JSON.stringify({ artifact_path: filePath, tl_dr: "dispatch fixture" }),
      ],
    );

    const artifactId = `dispatch:${dispatchPhid}`;

    let app2 = express();
    app2.use(express.json());
    mountOutputsRoutes(app2, adapter, {
      autoIngest: false,
      actionCooldownMs: 0,
      env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
      resolveTeamId: async () => "default",
    });
    const prevApp = app;
    app = app2;
    try {
      const res = await call("GET", `/artifacts/${encodeURIComponent(artifactId)}/detail`);

      expect(res.status).toBe(200);
      expect(res.body.artifact_id).toBe(artifactId);
      expect(res.body.metadata).toMatchObject({
        basename: "dispatch-result-report.md",
        agent: "backend-pool",
      });
      expect(res.body.body.kind).toBe("markdown");
      expect(res.body.body.body_unavailable).toBe(false);
      expect(res.body.body.text).toContain("Synthesized from dispatch_scheduler_queue.");
    } finally {
      app = prevApp;
    }
  });

  it("still returns a typed 404 for a query:-shaped id with no matching live source row", async () => {
    await adapter.query(`INSERT INTO teams (id, name) VALUES ('default', 'default')`, []);
    let app2 = express();
    app2.use(express.json());
    mountOutputsRoutes(app2, adapter, {
      autoIngest: false,
      actionCooldownMs: 0,
      env: { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv,
      resolveTeamId: async () => "default",
    });
    const prevApp = app;
    app = app2;
    try {
      const res = await call("GET", "/artifacts/query:query_never_existed:missing.md/detail");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: "artifact_not_found" });
    } finally {
      app = prevApp;
    }
  });
});

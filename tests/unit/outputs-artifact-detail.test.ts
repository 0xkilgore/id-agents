import express, { type Express } from "express";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { artifactIdFromPath, getArtifact, getArtifactBodyCache, migrateOutputsTables, registerArtifact, registerArtifactPathDelivery } from "../../src/outputs/storage.js";

let app: Express;
let adapter: SqliteAdapter;
let tmp: string;

async function setup(): Promise<void> {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { autoIngest: false, actionCooldownMs: 0 });
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

async function catalogFile(name: string, title = "Human artifact title"): Promise<{ filePath: string; artifactId: string }> {
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
      produced_at: "2026-06-27T12:00:00.000Z",
      source: "manual",
      availability: "present",
    },
    "2026-06-27T12:01:00.000Z",
  );
  return { filePath, artifactId };
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
        availability: "present",
      },
      body: {
        kind: "html",
        source: "artifact_body_cache",
      },
      render: {
        renderer: "html",
        mime_type: "text/html; charset=utf-8",
      },
      delivery: {
        bodyRenderable: true,
        bodyUnavailable: false,
        discoveredBy: "agent_done",
        freshness: "current",
      },
    });
    expect(detail.body.metadata.content_hash).toMatch(/^[a-f0-9]{64}$/);
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

  it("caches readable body and exposes stable delivery fields from /artifacts/register", async () => {
    const filePath = path.join(tmp, "registered-output.md");
    writeFileSync(filePath, "# Registered Output\n\nReadable after source removal.\n");
    const artifactId = artifactIdFromPath(filePath);

    const res = await call("POST", "/artifacts/register", {
      basename: "registered-output.md",
      agent: "finances",
      abs_path: filePath,
      title: "Registered Output",
      produced_at: "2026-07-08T13:00:00.000Z",
      source: "manual",
      project_ref: "finances",
      dispatch_ref: "phid:disp-register",
      source_host: "M4",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schema_version: "artifact.register.v1",
      artifact_id: artifactId,
      title: "Registered Output",
      source_path: filePath,
      freshness: "current",
      stable_url: `/artifacts/${artifactId}/detail`,
      copy_text_url: `/artifacts/${artifactId}/copy-text`,
      download_url: `/artifacts/${artifactId}/download`,
      cached_body: true,
      body_unavailable: false,
      body_error: null,
      source_proof: {
        source: "manual",
        source_badges: ["manual"],
        dispatch_ref: "phid:disp-register",
        source_host: "M4",
      },
    });
    expect(res.body.content_hash).toMatch(/^[a-f0-9]{64}$/);

    unlinkSync(filePath);
    const detail = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      displayTitle: "Registered Output",
      metadata: {
        content_hash: res.body.content_hash,
        source: "manual",
        project_ref: "finances",
      },
      body: {
        kind: "markdown",
        source: "artifact_body_cache",
      },
      delivery: {
        bodyRenderable: true,
        bodyUnavailable: false,
        freshness: "current",
        discoveredBy: "manual_fixture",
      },
    });
    expect(detail.body.body.text).toContain("Readable after source removal.");
  });

  it("backfills the two finance outputs with stable urls and cached bodies without Dropbox fixtures", async () => {
    const htmlPath = path.join(tmp, "2026-07-08-coming-month-cash-flow-preview.html");
    const mdPath = path.join(tmp, "2026-07-08-cash-flow-cobra-boxx-addendum.md");
    writeFileSync(htmlPath, "<h1>Coming Month Cash-Flow Preview</h1><p>Cache me.</p>");
    writeFileSync(mdPath, "# Cash-Flow Preview Correction Addendum\n\nCOBRA + BOXX lots.\n");

    const res = await call("POST", "/artifacts/finance/backfill", {
      artifacts: [
        {
          path: htmlPath,
          title: "Coming Month Cash-Flow Preview",
          project: "finances",
          source_host: "M4",
        },
        {
          path: mdPath,
          title: "Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots",
          project: "finances",
          source_host: "M4",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      schema_version: "artifact.finance_backfill.v1",
      count: 2,
    });
    const htmlResult = res.body.results[0];
    const mdResult = res.body.results[1];
    expect(htmlResult).toMatchObject({
      source_path: htmlPath,
      media_type: "text/html",
      stable_artifact_id: artifactIdFromPath(htmlPath),
      stable_url: `/artifacts/${artifactIdFromPath(htmlPath)}/detail`,
      cached_body: true,
      body_unavailable: false,
      body_error: null,
    });
    expect(mdResult).toMatchObject({
      source_path: mdPath,
      media_type: "text/markdown",
      stable_artifact_id: artifactIdFromPath(mdPath),
      cached_body: true,
      body_unavailable: false,
      body_error: null,
    });
    expect(htmlResult.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(mdResult.source_mtime).toBeTruthy();

    unlinkSync(htmlPath);
    unlinkSync(mdPath);

    const htmlDetail = await call("GET", `/artifacts/${artifactIdFromPath(htmlPath)}/detail`);
    expect(htmlDetail.status).toBe(200);
    expect(htmlDetail.body).toMatchObject({
      metadata: {
        project_ref: "finances",
        source: "filesystem",
        source_host: "M4",
        media_type: "text/html",
      },
      body: {
        kind: "html",
        source: "artifact_body_cache",
      },
      delivery: {
        discoveredBy: "filesystem_reconcile",
        bodyRenderable: true,
        freshness: "current",
      },
    });
    expect(htmlDetail.body.body.text).toContain("Cache me.");

    const copy = await callRaw(`/artifacts/${artifactIdFromPath(mdPath)}/copy-text`);
    expect(copy.status).toBe(200);
    expect(copy.text).toContain("COBRA + BOXX lots");
  });

  it("records body_unavailable explicitly when a finance source path is unreachable", async () => {
    const missingPath = path.join(tmp, "2026-07-08-missing-finance.md");
    const artifactId = artifactIdFromPath(missingPath);

    const res = await call("POST", "/artifacts/finance/backfill", {
      artifacts: [
        {
          path: missingPath,
          title: "Missing Finance Output",
          project: "finances",
          source_host: "M4",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      source_path: missingPath,
      stable_artifact_id: artifactId,
      media_type: "text/markdown",
      cached_body: false,
      body_unavailable: true,
    });
    expect(res.body.results[0].body_error).toBeTruthy();

    const row = await getArtifact(adapter, artifactId);
    expect(row).toMatchObject({
      artifact_id: artifactId,
      abs_path: missingPath,
      availability: "missing",
      source: "filesystem",
      project_ref: "finances",
      source_host: "M4",
      media_type: "text/markdown",
    });
    expect(row?.content_hash).toBeNull();
    expect(row?.source_mtime).toBeNull();

    const cache = await getArtifactBodyCache(adapter, artifactId);
    expect(cache).toMatchObject({
      artifact_id: artifactId,
      media_type: "text/markdown",
      body_text: null,
    });
    expect(cache?.body_error).toBeTruthy();

    const detail = await call("GET", `/artifacts/${artifactId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      delivery: {
        bodyRenderable: false,
        bodyUnavailable: true,
        freshness: "body_unavailable",
        discoveredBy: "filesystem_reconcile",
      },
      body: {
        kind: "missing",
      },
    });
  });
});

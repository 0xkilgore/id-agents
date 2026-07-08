import express, { type Express } from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { artifactIdFromPath, migrateOutputsTables, registerAgentDoneArtifact, registerArtifact } from "../../src/outputs/storage.js";

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

  it("serves a registered markdown artifact by stable id after the source path disappears", async () => {
    const filePath = path.join(tmp, "fresh-finance.md");
    writeFileSync(filePath, "# Finance\n\nFresh markdown body.\n");
    const registered = await registerAgentDoneArtifact(
      adapter,
      {
        abs_path: filePath,
        agent: "substrate-api-codex",
        dispatch_id: "phid:disp-md",
        title: "Fresh finance markdown",
        produced_at: "2026-07-08T12:00:00.000Z",
      },
      "2026-07-08T12:00:01.000Z",
    );
    rmSync(filePath);

    const res = await call("GET", `/artifacts/${registered.row.artifact_id}/detail`);

    expect(res.status).toBe(200);
    expect(res.body.metadata).toMatchObject({
      agent: "substrate-api-codex",
      dispatch_id: "phid:disp-md",
      media_type: "text/markdown; charset=utf-8",
      body_unavailable: null,
    });
    expect(res.body.body).toMatchObject({
      kind: "markdown",
      text: "# Finance\n\nFresh markdown body.\n",
      error: "cached_after_ENOENT",
    });
  });

  it("serves a registered HTML artifact by stable id from the cached body", async () => {
    const filePath = path.join(tmp, "fresh-finance.html");
    writeFileSync(filePath, "<main><h1>Finance</h1><p>Fresh HTML body.</p></main>");
    const registered = await registerAgentDoneArtifact(
      adapter,
      {
        abs_path: filePath,
        agent: "substrate-api-codex",
        dispatch_id: "phid:disp-html",
        title: "Fresh finance HTML",
        produced_at: "2026-07-08T12:00:00.000Z",
      },
      "2026-07-08T12:00:01.000Z",
    );
    rmSync(filePath);

    const res = await call("GET", `/artifacts/${registered.row.artifact_id}/detail`);

    expect(res.status).toBe(200);
    expect(res.body.render).toMatchObject({
      renderer: "html",
      mime_type: "text/html; charset=utf-8",
    });
    expect(res.body.body).toMatchObject({
      kind: "html",
      text: "<main><h1>Finance</h1><p>Fresh HTML body.</p></main>",
      error: "cached_after_ENOENT",
    });
  });

  it("records explicit body_unavailable when an agent-done path cannot be read", async () => {
    const filePath = path.join(tmp, "missing.md");
    const registered = await registerAgentDoneArtifact(
      adapter,
      {
        abs_path: filePath,
        agent: "substrate-api-codex",
        dispatch_id: "phid:disp-missing",
        produced_at: "2026-07-08T12:00:00.000Z",
      },
      "2026-07-08T12:00:01.000Z",
    );

    expect(registered.row).toMatchObject({
      availability: "missing",
      body_unavailable: "ENOENT",
      cached_body: null,
    });
    const res = await call("GET", `/artifacts/${registered.row.artifact_id}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.body).toMatchObject({
      kind: "unavailable",
      text: null,
      error: "ENOENT",
    });
  });
});

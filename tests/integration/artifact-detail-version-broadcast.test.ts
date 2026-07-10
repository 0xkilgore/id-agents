import express, { type Express } from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { artifactIdFromPath, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";

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
  tmp = mkdtempSync(path.join(tmpdir(), "artifact-detail-version-"));
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
  sessionId = "session-a",
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
          headers: { "content-type": "application/json", "x-test-session": sessionId },
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

async function seedArtifact(): Promise<string> {
  const filePath = path.join(tmp, "versioned.md");
  writeFileSync(filePath, "# Versioned\n\nInitial body.\n");
  const artifactId = artifactIdFromPath(filePath);
  await registerArtifact(
    adapter,
    {
      artifact_id: artifactId,
      basename: "versioned.md",
      agent: "regina",
      tag: "report",
      abs_path: filePath,
      title: "Versioned artifact",
      produced_at: "2026-07-10T12:00:00.000Z",
      source: "manual",
      availability: "present",
    },
    "2026-07-10T12:01:00.000Z",
  );
  return artifactId;
}

describe("artifact detail version checks", () => {
  it("returns a bumped version key to a second session after another session comments", async () => {
    const artifactId = await seedArtifact();

    const firstOpen = await call("GET", `/artifacts/${artifactId}/detail`, undefined, "session-a");
    const secondOpen = await call("GET", `/artifacts/${artifactId}/detail`, undefined, "session-b");
    expect(firstOpen.status).toBe(200);
    expect(secondOpen.status).toBe(200);
    expect(secondOpen.body.version_key).toBe(firstOpen.body.version_key);

    const before = await call("GET", `/artifacts/${artifactId}/detail/version`, undefined, "session-b");
    expect(before.status).toBe(200);
    expect(before.body.version_key).toBe(firstOpen.body.version_key);

    const comment = await call("POST", `/artifacts/${artifactId}/comments`, {
      actor_ref: "user:chris",
      body: "Second tab needs to refetch.",
    }, "session-a");
    expect(comment.status).toBe(200);

    const after = await call("GET", `/artifacts/${artifactId}/detail/version`, undefined, "session-b");
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      ok: true,
      schema_version: "artifact.detail.version.v1",
      artifact_id: artifactId,
    });
    expect(after.body.version_key).not.toBe(before.body.version_key);
  });

  it("reconciles local-first artifact comments with clientMutationId, baseVersion, replay, and stale-base conflict", async () => {
    const artifactId = await seedArtifact();

    const initial = await call("GET", `/artifacts/${artifactId}/comments`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ version: 0, count: 0 });

    const first = await call("POST", `/artifacts/${artifactId}/comments`, {
      actor_ref: "user:chris",
      body: "Optimistic comment.",
      clientMutationId: "comment-local-first-1",
      baseVersion: 0,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      version: 1,
      reconciliation: {
        schema_version: "artifact.local_first_write.v1",
        clientMutationId: "comment-local-first-1",
        baseVersion: 0,
        ackVersion: 1,
        status: "acked",
        idempotent: false,
      },
    });

    const replay = await call("POST", `/artifacts/${artifactId}/comments`, {
      actor_ref: "user:chris",
      body: "Optimistic comment.",
      clientMutationId: "comment-local-first-1",
      baseVersion: 0,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.op_id).toBe(first.body.op_id);
    expect(replay.body.reconciliation).toMatchObject({
      clientMutationId: "comment-local-first-1",
      ackVersion: 1,
      idempotent: true,
    });

    const stale = await call("POST", `/artifacts/${artifactId}/comments`, {
      actor_ref: "user:chris",
      body: "This stale write must not record.",
      clientMutationId: "comment-local-first-2",
      baseVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      ok: false,
      visible_state: "not-recorded",
      reconciliation: {
        status: "conflict",
        clientMutationId: "comment-local-first-2",
        baseVersion: 0,
        ackVersion: 1,
        conflict: { code: "stale_base_version", currentVersion: 1 },
      },
    });

    const after = await call("GET", `/artifacts/${artifactId}/comments`);
    expect(after.body).toMatchObject({ version: 1, count: 1 });
  });

  it("reconciles local-first artifact timeline writes and exposes timeline version", async () => {
    const artifactId = await seedArtifact();

    const initial = await call("GET", `/artifacts/${artifactId}/timeline`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ version: 0, count: 0 });

    const write = await call("POST", `/artifacts/${artifactId}/timeline`, {
      actor_ref: "user:chris",
      kind: "dispatch_follow_up",
      body: "Routed from optimistic timeline UI.",
      target_agent: "regina",
      dispatch_phid: "phid:disp-local-first",
      query_id: "query_local_first",
      status: "queued",
      clientMutationId: "timeline-local-first-1",
      baseVersion: 0,
    });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({
      version: 1,
      reconciliation: {
        schema_version: "artifact.local_first_write.v1",
        clientMutationId: "timeline-local-first-1",
        baseVersion: 0,
        ackVersion: 1,
        status: "acked",
      },
    });

    const stale = await call("POST", `/artifacts/${artifactId}/timeline`, {
      actor_ref: "user:chris",
      kind: "dispatch_follow_up",
      body: "Stale timeline write.",
      clientMutationId: "timeline-local-first-2",
      baseVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.reconciliation).toMatchObject({
      status: "conflict",
      ackVersion: 1,
    });

    const after = await call("GET", `/artifacts/${artifactId}/timeline`);
    expect(after.body).toMatchObject({ version: 1, count: 1 });
  });
});

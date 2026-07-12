import express, { type Express } from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
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
  mountOutputsRoutes(app, adapter, { autoIngest: false, actionCooldownMs: 0 });
  tmp = mkdtempSync(path.join(tmpdir(), "detail-version-freshness-"));
}

beforeEach(setup);

afterEach(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await adapter.close();
});

function withSession(sessionId: string) {
  return async function request(method: "GET" | "POST", requestPath: string, body?: unknown) {
    return new Promise<{ status: number; body: any; headers: Headers }>((resolve, reject) => {
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
            headers: {
              "content-type": "application/json",
              "x-test-session": sessionId,
            },
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
  };
}

describe("detail version-key freshness probes", () => {
  it("lets a second artifact session detect a comment mutation via the version endpoint", async () => {
    const filePath = path.join(tmp, "two-session-artifact.md");
    writeFileSync(filePath, "# Two Sessions\n\nInitial body.\n");
    const artifactId = artifactIdFromPath(filePath);
    await registerArtifact(
      adapter,
      {
        artifact_id: artifactId,
        basename: "two-session-artifact.md",
        agent: "regina",
        abs_path: filePath,
        title: "Two Session Artifact",
        produced_at: "2026-07-10T12:00:00.000Z",
        source: "manual",
        availability: "present",
      },
      "2026-07-10T12:01:00.000Z",
    );

    const sessionA = withSession("session-a");
    const sessionB = withSession("session-b");
    const first = await sessionB("GET", `/artifacts/${encodeURIComponent(artifactId)}/detail`);
    expect(first.status).toBe(200);
    const before = await sessionB("GET", `/artifacts/${encodeURIComponent(artifactId)}/version`);
    expect(before.status).toBe(200);
    expect(before.body.version_key).toBe(first.body.version_key);

    const comment = await sessionA("POST", `/artifacts/${encodeURIComponent(artifactId)}/comments`, {
      actor_ref: "user:chris",
      body: "Comment from another open tab.",
    });
    expect(comment.status).toBe(200);

    const after = await sessionB("GET", `/artifacts/${encodeURIComponent(artifactId)}/version`);
    expect(after.status).toBe(200);
    expect(after.body.version_key).not.toBe(before.body.version_key);
    expect(after.body).toMatchObject({
      schema_version: "artifact.detail.version.v1",
      artifact_id: artifactId,
    });
  });
});

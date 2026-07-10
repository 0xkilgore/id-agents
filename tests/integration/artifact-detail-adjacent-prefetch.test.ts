// SPDX-License-Identifier: MIT
/**
 * GET /artifacts/:id/detail adjacent prefetch.
 *
 * Boots the real outputs route stack against in-memory SQLite and counts the
 * catalog-list query. The first detail read builds the selected artifact,
 * scans the local artifact index once for adjacency, and prefetches the
 * neighbor. Switching to that neighbor must be served from the detail cache
 * without another catalog-list query.
 */

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
let catalogListCalls = 0;

async function setup(): Promise<void> {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);

  const originalQuery = adapter.query.bind(adapter);
  adapter.query = (async (...args: Parameters<typeof adapter.query>) => {
    const sql = String(args[0]);
    if (
      sql.includes("FROM artifacts") &&
      sql.includes("ORDER BY produced_at DESC") &&
      sql.includes("LIMIT ? OFFSET ?")
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
  });
  tmp = mkdtempSync(path.join(tmpdir(), "artifact-detail-prefetch-"));
  catalogListCalls = 0;
}

afterEach(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await adapter.close();
});

beforeEach(setup);

async function call(requestPath: string): Promise<{ status: number; body: any; headers: Headers }> {
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
        const parsed = text ? JSON.parse(text) : null;
        server.close(() => resolve({ status: response.status, body: parsed, headers: response.headers }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function catalogFile(
  name: string,
  title: string,
  producedAt: string,
): Promise<{ artifactId: string }> {
  const filePath = path.join(tmp, name);
  writeFileSync(filePath, `# ${title}\n\nReal detail body for ${title}.\n`);
  const artifactId = artifactIdFromPath(filePath);
  await registerArtifact(
    adapter,
    {
      artifact_id: artifactId,
      basename: name,
      agent: "backend-pool",
      tag: "checkpoint",
      abs_path: filePath,
      title,
      produced_at: producedAt,
      source: "manual",
      availability: "present",
    },
    "2026-07-10T19:45:00.000Z",
  );
  return { artifactId };
}

describe("GET /artifacts/:id/detail adjacent prefetch", () => {
  it("serves an adjacent artifact from prefetch cache without a fresh catalog scan", async () => {
    const oldest = await catalogFile("oldest.md", "Oldest", "2026-07-10T17:00:00.000Z");
    const middle = await catalogFile("middle.md", "Middle", "2026-07-10T18:00:00.000Z");
    const newest = await catalogFile("newest.md", "Newest", "2026-07-10T19:00:00.000Z");

    const first = await call(`/artifacts/${middle.artifactId}/detail`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-artifact-detail-cache")).toBe("miss");
    expect(first.body.artifact_id).toBe(middle.artifactId);
    expect(first.body.body.text).toContain("Real detail body for Middle.");
    expect(first.body.version_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.body.adjacent_prefetch).toMatchObject({
      list_key: "artifacts",
      list_length: 3,
      previous: { artifact_id: newest.artifactId },
      next: { artifact_id: oldest.artifactId },
    });
    expect(catalogListCalls).toBe(1);

    const second = await call(`/artifacts/${newest.artifactId}/detail`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-artifact-detail-cache")).toBe("hit");
    expect(second.body.artifact_id).toBe(newest.artifactId);
    expect(second.body.body.text).toContain("Real detail body for Newest.");
    expect(second.body.adjacent_prefetch.next.artifact_id).toBe(middle.artifactId);
    expect(catalogListCalls).toBe(1);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { appendOperation, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { upsertReviewNextMetadata } from "../../src/review-next/storage.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("GET /artifacts/review-next", () => {
  it("admits a production artifact registered through the public nested metadata contract", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateOutputsTables(adapter);
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, { now: () => NOW, autoIngest: false });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/artifacts/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact_id: "art-http-registered",
        basename: "review.md",
        agent: "cane",
        abs_path: "/operator/output/review.md",
        title: "HTTP registered operator artifact",
        produced_at: "2026-08-05T11:00:00.000Z",
        source: "manual",
        project_ref: "kapelle",
        review_next: {
          audience: "operator",
          environment: "production",
          owner: "cane",
          canonical_url: "/ops/artifacts/art-http-registered",
          effective_lifecycle: "needs_review",
          source_as_of: "2026-08-05T11:00:00.000Z",
          attention_state: "needs_review",
          attention_reason: "fresh operator artifact",
          attention_priority: 0,
          admission_reason: "explicit operator registration",
          permitted_actions: ["open", "comment"],
        },
      }),
    });
    expect(registered.status).toBe(200);
    const response = await fetch(`${base}/artifacts/review-next`);
    const body = await response.json();
    expect(body.rows.map((item: { id: string }) => item.id)).toEqual(["art-http-registered"]);
  });

  it("returns only explicit authoritative IDs and performs no body/filesystem list reads", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateOutputsTables(adapter);
    await register(adapter, "art-fresh-august", "2026-08-05T10:00:00.000Z", true);
    await register(adapter, "art-revalidated-decision", "2026-07-20T12:00:00.000Z", true, {
      revalidated_at: "2026-08-05T06:00:00.000Z",
      effective_lifecycle: "open",
      attention_priority: 2,
    });
    await register(adapter, "expired", "2026-07-28T11:59:59.999Z", true);
    await register(adapter, "terminal", "2026-08-05T09:00:00.000Z", true, { effective_lifecycle: "resolved" });
    for (let index = 1; index <= 4; index += 1) {
      await register(adapter, `approval-test-july-21-${index}`, "2026-07-21T12:00:00.000Z", false);
    }
    await appendOperation(adapter, "expired", "view", "user:chris", NOW.toISOString(), null, null);
    await appendOperation(adapter, "expired", "comment_recorded", "user:chris", NOW.toISOString(), JSON.stringify({ body: "still old" }), null);

    const sql: string[] = [];
    const originalQuery = adapter.query.bind(adapter);
    adapter.query = async <T>(statement: string, params?: unknown[]) => {
      sql.push(statement);
      return originalQuery<T>(statement, params);
    };

    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, { now: () => NOW, autoIngest: false });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    sql.length = 0;
    const response = await fetch(`http://127.0.0.1:${address.port}/artifacts/review-next`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rows.map((item: { id: string }) => item.id)).toEqual(["art-fresh-august", "art-revalidated-decision"]);
    expect(body.payload_bytes).toBeLessThanOrEqual(64 * 1024);
    expect(response.headers.get("server-timing")).toMatch(/review-next-projection/);
    expect(response.headers.get("x-review-next-payload-bytes")).toBe(String(body.payload_bytes));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("artifact_review_next_metadata");
    expect(sql[0]).not.toMatch(/artifact_bodies|body_text|abs_path\s*\)|readfile/i);

    const latencyMs: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const startedAt = performance.now();
      const repeat = await fetch(`http://127.0.0.1:${address.port}/artifacts/review-next`);
      const repeatedBody = await repeat.json();
      latencyMs.push(performance.now() - startedAt);
      expect(repeatedBody.rows.map((item: { id: string }) => item.id)).toEqual(["art-fresh-august", "art-revalidated-decision"]);
    }
    expect(sql).toHaveLength(51);
    expect(sql.every((statement) => statement.includes("artifact_review_next_metadata"))).toBe(true);
    expect(sql.every((statement) => !/artifact_bodies|body_text|readfile/i.test(statement))).toBe(true);
    const sorted = [...latencyMs].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    await mkdir("output/review-next-a1", { recursive: true });
    await writeFile("output/review-next-a1/manager-response.json", `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await writeFile("output/review-next-a1/manager-performance.json", `${JSON.stringify({
      protocol: "50 sequential HTTP GETs against an in-memory SQLite manager route after warmup",
      samples_ms: latencyMs,
      p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95_ms: p95,
      payload_bytes: body.payload_bytes,
      request_count_per_sample: 1,
      list_sql_queries_per_sample: 1,
    }, null, 2)}\n`, "utf8");
  });
});

async function register(
  adapter: SqliteAdapter,
  id: string,
  sourceAsOf: string,
  explicit: boolean,
  overrides: Partial<{ revalidated_at: string; effective_lifecycle: string; attention_priority: number }> = {},
) {
  await registerArtifact(adapter, {
    artifact_id: id,
    basename: `${id}.md`,
    agent: "cane",
    abs_path: `/operator/output/${id}.md`,
    title: id.startsWith("approval") ? `Approval test ${id}` : id,
    produced_at: sourceAsOf,
    source: "manual",
    availability: "present",
    project_ref: "kapelle",
  }, NOW.toISOString());
  if (!explicit) return;
  await upsertReviewNextMetadata(adapter, id, {
    audience: "operator",
    environment: "production",
    owner: "cane",
    canonical_url: `/ops/artifacts/${id}`,
    effective_lifecycle: overrides.effective_lifecycle ?? "needs_review",
    source_as_of: sourceAsOf,
    revalidated_at: overrides.revalidated_at,
    attention_state: "needs_review",
    attention_reason: "registered operator artifact",
    attention_priority: overrides.attention_priority ?? 1,
    admission_reason: "explicit operator registration",
    permitted_actions: ["open", "comment", "approve"],
  }, NOW.toISOString());
}

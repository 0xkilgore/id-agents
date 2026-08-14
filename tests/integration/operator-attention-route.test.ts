import { createServer } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { mountOperatorAttentionRoutes } from "../../src/operator-attention/routes.js";
import type { OperatorAttentionCandidate, OperatorAttentionSourceSet } from "../../src/operator-attention/types.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("operator-attention routes", () => {
  it("serves one bounded projection and inspectable suppression reasons", async () => {
    const app = express();
    mountOperatorAttentionRoutes(app, {} as never, {
      tasks: {} as never,
      resolveTeamId: async () => "synthetic-team",
      now: () => new Date("2026-08-13T15:00:00.000Z"),
      loadSources: async () => fixture(),
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/operator-attention`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.schema_version).toBe("operator-attention.v1");
    expect(body.bands.next.map((row: any) => row.ref)).toEqual(["visible"]);
    expect(response.headers.get("server-timing")).toMatch(/operator-attention-db-serialize/);
    expect(response.headers.get("x-operator-attention-payload-bytes")).toBe(String(body.payload_bytes));

    const suppression = await fetch(`${base}/operator-attention/suppressions?ref=hidden-test`);
    expect(suppression.status).toBe(200);
    expect(await suppression.json()).toMatchObject({ suppression: { ref: "hidden-test", reason: "test_material" } });
    expect((await fetch(`${base}/operator-attention/suppressions`)).status).toBe(400);
    expect((await fetch(`${base}/operator-attention/suppressions?ref=unknown`)).status).toBe(404);
  });

  it("returns 503 instead of an authoritative empty day when sources are unavailable", async () => {
    const app = express();
    mountOperatorAttentionRoutes(app, {} as never, {
      tasks: {} as never,
      resolveTeamId: async () => "synthetic-team",
      loadSources: async () => ({
        ...fixture(),
        candidates: [],
        source_health: "unavailable",
        source_health_reason: "manager source unavailable",
      }),
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");

    const response = await fetch(`http://127.0.0.1:${address.port}/operator-attention`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      schema_version: "operator-attention.v1",
      error: {
        code: "OPERATOR_ATTENTION_SOURCE_UNAVAILABLE",
        message: "manager source unavailable",
      },
    });
  });
});

function fixture(): OperatorAttentionSourceSet {
  return {
    daily_desk: { today: [], review_next_source: [], needs_response: [], follow_through: [] },
    candidates: [candidate("visible"), candidate("hidden-test", { environment: "test" })],
  };
}

function candidate(ref: string, overrides: Partial<OperatorAttentionCandidate> = {}): OperatorAttentionCandidate {
  return {
    ref, title: `Synthetic ${ref}`, owner: "synthetic-owner", audience: "operator", environment: "production",
    authority_owner: "manager", canonical_url: `/ops/synthetic/${ref}`, lifecycle: "open",
    source_as_of: "2026-08-13T14:00:00.000Z", meaningful_at: "2026-08-13T12:00:00.000Z",
    expires_at: "2026-08-14T00:00:00.000Z", source_kind: "report", attention_kind: "read",
    actions: ["open"], admission_code: "synthetic_explicit_request",
    admission_detail: "synthetic fixture carries an explicit bounded request", ...overrides,
  };
}

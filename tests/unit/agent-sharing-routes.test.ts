// T-CKPT.agent-sharing / F4 — the share/delegate HTTP endpoints end-to-end:
// POST /shares, POST /delegations, GET /grants[/:id], POST /grants/:id/revoke.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { mountAgentSharingRoutes } from "../../src/agent-sharing/routes.js";
import { migrateAgentSharingTables } from "../../src/agent-sharing/storage.js";

let adapter: SqliteAdapter;
let server: Server;
let port: number;
let counter = 0;

async function startServer(a: SqliteAdapter): Promise<number> {
  const app = express();
  app.use(express.json());
  mountAgentSharingRoutes(app, a, {
    nowIso: () => "2026-06-24T12:00:00.000Z",
    idGen: () => `grant-${++counter}`,
  });
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateAgentSharingTables(adapter);
  counter = 0;
  port = await startServer(adapter);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await adapter.close();
});

const base = () => `http://localhost:${port}`;
const post = (path: string, body: unknown) =>
  fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /shares", () => {
  it("shares blowout → Liz (201 created)", async () => {
    const res = await post("/shares", {
      actor_ref: "user:chris",
      subject_kind: "project",
      subject_ref: "blowout",
      grantee_ref: "user:liz",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.created).toBe(true);
    expect(json.grant).toMatchObject({ kind: "share", grantee_kind: "user", grantee_ref: "user:liz" });
  });

  it("is idempotent on re-share (200, created:false)", async () => {
    const body = { actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz" };
    await post("/shares", body);
    const res = await post("/shares", body);
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(false);
  });

  it("rejects an unknown actor (400)", async () => {
    const res = await post("/shares", {
      actor_ref: "user:bob",
      subject_kind: "project",
      subject_ref: "blowout",
      grantee_ref: "user:liz",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /delegations", () => {
  it("delegates to the finances agent via the `agent` alias (201)", async () => {
    const res = await post("/delegations", {
      actor_ref: "user:chris",
      subject_kind: "project",
      subject_ref: "q2-close",
      agent: "finances",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.grant).toMatchObject({ kind: "delegate", grantee_kind: "agent", grantee_ref: "finances" });
  });

  it("rejects delegating to a Monday user (400)", async () => {
    const res = await post("/delegations", {
      actor_ref: "user:chris",
      subject_kind: "project",
      subject_ref: "q2",
      agent: "user:liz",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /grants", () => {
  it("lists and filters grants", async () => {
    await post("/shares", { actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz" });
    await post("/delegations", { actor_ref: "user:chris", subject_kind: "project", subject_ref: "q2", agent: "finances" });

    const all = await (await fetch(`${base()}/grants`)).json();
    expect(all.count).toBe(2);

    const delegations = await (await fetch(`${base()}/grants?kind=delegate`)).json();
    expect(delegations.count).toBe(1);
    expect(delegations.grants[0].grantee_ref).toBe("finances");

    const bySubject = await (await fetch(`${base()}/grants?subject_ref=blowout`)).json();
    expect(bySubject.count).toBe(1);
  });
});

describe("POST /grants/:id/revoke", () => {
  it("revokes a grant by the granting actor and drops it from the active list", async () => {
    const created = await (
      await post("/shares", { actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz" })
    ).json();
    const id = created.grant.grant_id;

    const rev = await post(`/grants/${id}/revoke`, { actor_ref: "user:chris" });
    expect(rev.status).toBe(200);
    expect((await rev.json()).grant.revoked_by).toBe("user:chris");

    const active = await (await fetch(`${base()}/grants`)).json();
    expect(active.count).toBe(0);
  });

  it("forbids revoke by a non-grantor non-chris actor (403)", async () => {
    const created = await (
      await post("/shares", { actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz" })
    ).json();
    const rev = await post(`/grants/${created.grant.grant_id}/revoke`, { actor_ref: "user:liz" });
    expect(rev.status).toBe(403);
  });

  it("404s revoking a missing grant", async () => {
    const rev = await post(`/grants/nope/revoke`, { actor_ref: "user:chris" });
    expect(rev.status).toBe(404);
  });
});

// T-CKPT.8 edit-in-product — HTTP round trip over the real outputs routes:
// flag-gating, the substrate-only edit capture, and reading the latest edit back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import * as net from "net";
import type { Server } from "http";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function boot(env: NodeJS.ProcessEnv): Promise<{ base: string; server: Server }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { env });
  const port = await freePort();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${port}`, server };
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe("POST/GET /artifacts/:id/edit", () => {
  it("404s when the capability flag is OFF (reversible no-op)", async () => {
    const b = await boot({}); server = b.server;
    const res = await fetch(`${b.base}/artifacts/art_1/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("edit_in_product_disabled");
  });

  it("captures an edit and reads the latest body back (source file never touched)", async () => {
    const b = await boot({ ARTIFACTS_EDIT_IN_PRODUCT: "1" }); server = b.server;

    const post = await fetch(`${b.base}/artifacts/art_42/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "first body", actor: "user:chris" }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).ok).toBe(true);

    // A second edit supersedes the first.
    await fetch(`${b.base}/artifacts/art_42/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "newer body", actor: "user:liz", note: "polish" }),
    });

    const get = await fetch(`${b.base}/artifacts/art_42/edit`);
    const { edit } = await get.json();
    expect(edit.content).toBe("newer body");
    expect(edit.note).toBe("polish");
    expect(edit.editor).toEqual({ type: "user", id: "liz" });
  });

  it("400s when content is missing", async () => {
    const b = await boot({ ARTIFACTS_EDIT_IN_PRODUCT: "1" }); server = b.server;
    const res = await fetch(`${b.base}/artifacts/art_1/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:chris" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns edit:null for an artifact that was never edited", async () => {
    const b = await boot({ ARTIFACTS_EDIT_IN_PRODUCT: "1" }); server = b.server;
    const res = await fetch(`${b.base}/artifacts/never_edited/edit`);
    expect((await res.json()).edit).toBeNull();
  });
});

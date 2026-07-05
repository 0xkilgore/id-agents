// POST /orchestration/backlog — register-native-ID duplicate guard.
//
// maestra (and any future importer) authors new backlog items directly from
// kapelle-feedback-register.md, minting a FRESH logical_key per item — so the
// existing exact-logical_key dedup can never catch a duplicate authored this
// way. This guard flags a probable duplicate whenever a proposed item's
// title/source_refs contains a register-native ID substring (arf:, t-ckpt:,
// kfb:, ...) already present in an EXISTING backlog row, in ANY
// readiness_state (including `done` — re-dispatching already-shipped work is
// exactly the failure mode this guards against).

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import {
  findProbableDuplicateByRegisterId,
  insertBacklogItem,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon: {} as unknown as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

describe("POST /orchestration/backlog register-ID duplicate guard", () => {
  it("refuses a second item authored under a DIFFERENT fresh logical_key for the SAME register ID", async () => {
    const first = await call("POST", "/orchestration/backlog", {
      title: "KF3-05 — Bulk select + bulk read",
      logical_key: "refuel-20260704-roger-kf3-05",
      source_refs: ["t-ckpt:ui-needs-attention-inbox-filter"],
    });
    expect(first.status).toBe(200);

    const second = await call("POST", "/orchestration/backlog", {
      title: "KF3-05 — Bulk select + bulk read (re-authored)",
      logical_key: "refuel-20260705-roger-kf3-05-again", // deliberately DIFFERENT key
      source_refs: ["t-ckpt:ui-needs-attention-inbox-filter"],
    });
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(second.body.error).toBe("probable_duplicate");
    expect(second.body.existing_item.item_id).toBe(first.body.item.item_id);

    // No second row was created.
    const { rows } = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM orchestration_backlog_item WHERE team_id = 'default'`,
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it("blocks the duplicate even when the existing item is already `done` — re-dispatching shipped work", async () => {
    const first = await call("POST", "/orchestration/backlog", {
      title: "ARF4-04 — Outlook-style metadata row",
      logical_key: "refuel-20260704-roger-arf4-04",
      source_refs: ["arf:v4:metadata-outlook-style"],
    });
    await setItemState(adapter, first.body.item.item_id, "done");

    const second = await call("POST", "/orchestration/backlog", {
      title: "ARF4-04 — metadata row polish (re-dispatch)",
      logical_key: "refuel-20260705-roger-arf4-04-b",
      source_refs: ["arf:v4:metadata-outlook-style"],
    });
    expect(second.status).toBe(409);
    expect(second.body.existing_item.readiness_state).toBe("done");
  });

  it("matches when the register ID appears in the TITLE rather than source_refs", async () => {
    await call("POST", "/orchestration/backlog", {
      title: "kfb:v3:artifact-split-layout-right-rail — right rail split",
      logical_key: "refuel-20260704-a",
    });
    const second = await call("POST", "/orchestration/backlog", {
      title: "Follow-up on kfb:v3:artifact-split-layout-right-rail",
      logical_key: "refuel-20260705-b",
    });
    expect(second.status).toBe(409);
  });

  it("does NOT block an item with no register-native ID at all (nothing to compare)", async () => {
    await call("POST", "/orchestration/backlog", { title: "Some unrelated item" });
    const second = await call("POST", "/orchestration/backlog", { title: "Another unrelated item" });
    expect(second.status).toBe(200);
  });

  it("does NOT block two DIFFERENT register IDs from each getting their own item", async () => {
    const a = await call("POST", "/orchestration/backlog", {
      title: "item A",
      source_refs: ["t-ckpt:aaa"],
    });
    const b = await call("POST", "/orchestration/backlog", {
      title: "item B",
      source_refs: ["t-ckpt:bbb"],
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("does NOT interfere with this repo's own roadmap: scheme", async () => {
    // roadmap-import.ts's own logical_key scheme is excluded from
    // register-ID extraction, so two roadmap-derived titles referencing
    // "roadmap:..." text should never trip this guard.
    await call("POST", "/orchestration/backlog", {
      title: "T-ORCH item",
      source_refs: ["roadmap:t-orch:some-title"],
    });
    const second = await call("POST", "/orchestration/backlog", {
      title: "Another T-ORCH item",
      source_refs: ["roadmap:t-orch:some-title"],
    });
    expect(second.status).toBe(200);
  });

  it("force:true inserts anyway despite a probable duplicate", async () => {
    await call("POST", "/orchestration/backlog", {
      title: "first",
      source_refs: ["kfb:v3:reopened-item"],
    });
    const second = await call("POST", "/orchestration/backlog", {
      title: "second, deliberately re-authored",
      source_refs: ["kfb:v3:reopened-item"],
      force: true,
    });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);

    const { rows } = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM orchestration_backlog_item WHERE team_id = 'default'`,
    );
    expect(Number(rows[0].c)).toBe(2);
  });
});

describe("findProbableDuplicateByRegisterId (storage-level)", () => {
  it("returns null when no backlog rows exist yet", async () => {
    const dup = await findProbableDuplicateByRegisterId(adapter, "default", {
      title: "anything",
      source_refs: ["arf:v4:x"],
    });
    expect(dup).toBeNull();
  });

  it("finds a match across title vs source_refs in either direction", async () => {
    await insertBacklogItem(adapter, {
      team_id: "default",
      title: "existing item mentions arf:v4:cross-field in its title",
      logical_key: "k1",
    });
    const dup = await findProbableDuplicateByRegisterId(adapter, "default", {
      title: "new item",
      source_refs: ["arf:v4:cross-field"],
    });
    expect(dup?.logical_key).toBe("k1");
  });

  it("is scoped to the team_id", async () => {
    await insertBacklogItem(adapter, {
      team_id: "other-team",
      title: "other team's item",
      source_refs: ["t-ckpt:shared-id"],
      logical_key: "k2",
    });
    const dup = await findProbableDuplicateByRegisterId(adapter, "default", {
      title: "candidate",
      source_refs: ["t-ckpt:shared-id"],
    });
    expect(dup).toBeNull();
  });
});

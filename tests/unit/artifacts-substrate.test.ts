// ARTIFACTS substrate proof-cut — projection + parity + flag + routes.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import {
  artifactRowToEntry,
  parseActorRef,
  projectFromPath,
  provenanceFromOps,
} from "../../src/outputs/entry-projection.js";
import { computeArtifactParity, parseDeliveryLogRows } from "../../src/outputs/parity.js";
import { useDocumentModel } from "../../src/config/feature-flags.js";
import type { ArtifactCatalogRow, ArtifactOpRow, ArtifactReviewStateRow } from "../../src/outputs/types.js";

function catalogRow(over: Partial<ArtifactCatalogRow> = {}): ArtifactCatalogRow {
  return {
    artifact_id: "art_abc123",
    basename: "report.md",
    agent: "roger",
    tag: "spec",
    abs_path: "/Users/kilgore/Dropbox/Code/kapelle-site/output/report.md",
    title: "A report tl_dr",
    produced_at: "2026-06-23T10:00:00.000Z",
    source: "delivery-log",
    availability: "present",
    source_badges: '["delivery-log"]',
    reconciled_at: null,
    created_at: "2026-06-23T10:00:00.000Z",
    updated_at: "2026-06-23T10:00:00.000Z",
    ...over,
  };
}

function opRow(over: Partial<ArtifactOpRow> = {}): ArtifactOpRow {
  return {
    op_id: 1,
    artifact_id: "art_abc123",
    op_type: "view",
    actor: "user:chris",
    ts: "2026-06-23T11:00:00.000Z",
    payload_json: null,
    source_link: null,
    ...over,
  };
}

// ── Step 1: projection ──

describe("parseActorRef", () => {
  it("maps prefixed + bare actors", () => {
    expect(parseActorRef("user:chris")).toEqual({ type: "user", id: "chris" });
    expect(parseActorRef("agent:regina")).toEqual({ type: "agent", id: "regina" });
    expect(parseActorRef("system")).toEqual({ type: "system", id: "system" });
    expect(parseActorRef("operator")).toEqual({ type: "user", id: "operator" });
    expect(parseActorRef("roger")).toEqual({ type: "agent", id: "roger" });
    expect(parseActorRef("")).toEqual({ type: "system", id: "system" });
  });
});

describe("projectFromPath", () => {
  it("derives a project slug from the canonical roots", () => {
    expect(projectFromPath("/Users/kilgore/Dropbox/Code/roger/output/x.md")).toBe("roger");
    expect(projectFromPath("/Users/kilgore/Dropbox/Obsidian/notes/x.md")).toBe("obsidian");
    expect(projectFromPath("/tmp/x.md")).toBeNull();
    expect(projectFromPath(null)).toBeNull();
  });
});

describe("provenanceFromOps", () => {
  it("builds revisions + distinct contributors in op order", () => {
    const prov = provenanceFromOps([
      opRow({ op_id: 2, actor: "user:liz", op_type: "approve", ts: "t2" }),
      opRow({ op_id: 1, actor: "user:chris", op_type: "view", ts: "t1" }),
    ]);
    expect(prov.revisions.map((r) => r.at)).toEqual(["t1", "t2"]);
    expect(prov.revisions[0].by).toEqual({ type: "user", id: "chris" });
    expect(prov.revisions[1].note).toBe("approve");
    expect(prov.contributors).toEqual([
      { type: "user", id: "chris" },
      { type: "user", id: "liz" },
    ]);
  });

  it("prefers a JSON payload note over the op type", () => {
    const prov = provenanceFromOps([opRow({ payload_json: JSON.stringify({ note: "looks good" }) })]);
    expect(prov.revisions[0].note).toBe("looks good");
  });
});

describe("artifactRowToEntry", () => {
  it("maps catalog + review + ops to a DV1 ArtifactEntry", () => {
    const review: ArtifactReviewStateRow = {
      artifact_id: "art_abc123",
      source_link: null,
      first_viewed_at: "2026-06-23T11:00:00.000Z",
      last_viewed_at: "2026-06-23T11:00:00.000Z",
      viewed_by_last: "user:chris",
      viewed_count: 1,
      approved_at: null,
      approved_by: null,
      approval_note: null,
      rejected_at: null,
      rejected_by: null,
      reject_note: null,
      shipped_at: null,
      shipped_by: null,
      ship_blockers_json: null,
      created_at: "2026-06-23T11:00:00.000Z",
      updated_at: "2026-06-23T12:00:00.000Z",
    };
    const entry = artifactRowToEntry(catalogRow(), review, [opRow()]);
    expect(entry.kind).toBe("artifact");
    expect(entry.schema_version).toBe(1);
    expect(entry.phid).toBe("art_abc123");
    expect(entry.title).toBe("A report tl_dr");
    expect(entry.artifact_kind).toBe("spec");
    expect(entry.project).toBe("kapelle-site");
    expect(entry.path).toBe("/Users/kilgore/Dropbox/Code/kapelle-site/output/report.md");
    expect(entry.produced_by_agent).toBe("roger");
    expect(entry.created_by).toEqual({ type: "agent", id: "roger" });
    expect(entry.created_at).toBe("2026-06-23T10:00:00.000Z");
    expect(entry.updated_at).toBe("2026-06-23T12:00:00.000Z");
    expect(entry.provenance.revisions).toHaveLength(1);
    expect(entry.provenance.contributors).toEqual([{ type: "user", id: "chris" }]);
  });

  it("falls back title→basename and tag→'artifact' when absent", () => {
    const entry = artifactRowToEntry(catalogRow({ title: null, tag: null }), null, []);
    expect(entry.title).toBe("report.md");
    expect(entry.artifact_kind).toBe("artifact");
    expect(entry.updated_at).toBe(entry.created_at);
  });
});

// ── Step 3: parity (pure) ──

describe("parseDeliveryLogRows", () => {
  it("parses pipe rows and skips comments/blank/short lines", () => {
    const text = [
      "# header",
      '2026-06-23T10:00:00.000Z | roger | spec | report.md | /a/report.md | "A report tl_dr"',
      "",
      "too | few",
      "2026-06-23T09:00:00.000Z | regina | - | x.md | /a/x.md | plain title",
    ].join("\n");
    const rows = parseDeliveryLogRows(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agent: "roger", tag: "spec", abs_path: "/a/report.md", title: "A report tl_dr" });
    expect(rows[1].tag).toBeNull(); // "-" → null
  });
});

describe("computeArtifactParity", () => {
  const sub = [
    { abs_path: "/a/1.md", agent: "roger", tag: "spec", title: "one", produced_at: "2026-06-23T10:00:00Z" },
    { abs_path: "/a/2.md", agent: "regina", tag: "build", title: "two", produced_at: "2026-06-23T11:00:00Z" },
    // substrate-only extra (filesystem-reconciled) — must NOT cause drift
    { abs_path: "/a/3.md", agent: "cane", tag: "note", title: "three", produced_at: "2026-06-23T12:00:00Z" },
  ];
  const log = [
    { abs_path: "/a/1.md", agent: "roger", tag: "spec", title: "one", produced_at: "2026-06-23T10:00:00Z" },
    { abs_path: "/a/2.md", agent: "regina", tag: "build", title: "two", produced_at: "2026-06-23T11:00:00Z" },
  ];

  it("is ok when every delivery row is faithfully present (substrate may be a superset)", () => {
    const r = computeArtifactParity(sub, log, "now");
    expect(r.status).toBe("ok");
    expect(r.drift).toEqual([]);
  });

  it("drifts when a delivery-log-only row is missing from substrate", () => {
    const r = computeArtifactParity(sub, [...log, { abs_path: "/a/missing.md", agent: "x", tag: null, title: "m", produced_at: "2026-06-23T13:00:00Z" }], "now");
    expect(r.status).toBe("drift");
    expect(r.drift.some((d) => d.includes("/a/missing.md"))).toBe(true);
  });

  it("drifts on tl_dr title mismatch", () => {
    const drifted = [{ ...log[0], title: "DIFFERENT" }, log[1]];
    const r = computeArtifactParity(sub, drifted, "now");
    expect(r.status).toBe("drift");
    expect(r.drift.some((d) => d.toLowerCase().includes("title"))).toBe(true);
  });
});

// ── Step 4: flag ──

describe("useDocumentModel", () => {
  it("is off by default and parses truthy values", () => {
    expect(useDocumentModel("artifacts", {})).toBe(false);
    expect(useDocumentModel("artifacts", { ARTIFACTS_USE_DOCUMENT_MODEL: "true" })).toBe(true);
    expect(useDocumentModel("artifacts", { ARTIFACTS_USE_DOCUMENT_MODEL: "1" })).toBe(true);
    expect(useDocumentModel("artifacts", { ARTIFACTS_USE_DOCUMENT_MODEL: "off" })).toBe(false);
    expect(useDocumentModel("tasks", { TASKS_USE_DOCUMENT_MODEL: "yes" })).toBe(true);
  });
});

// ── Step 2: routes (substrate read) ──

async function bootApp(readDeliveryLog: () => Promise<string | null>) {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const now = "2026-06-23T10:00:00.000Z";
  await registerArtifact(adapter, { basename: "1.md", agent: "roger", tag: "spec", abs_path: "/a/1.md", title: "one", produced_at: "2026-06-23T10:00:00.000Z", source: "delivery-log" }, now);
  await registerArtifact(adapter, { basename: "2.md", agent: "regina", tag: "build", abs_path: "/a/2.md", title: "two", produced_at: "2026-06-23T11:00:00.000Z", source: "delivery-log" }, now);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { readDeliveryLog, autoIngest: false });
  return app;
}

function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await r.json();
        server.close(() => resolve({ status: r.status, body }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

const alignedLog = [
  '2026-06-23T10:00:00.000Z | roger | spec | 1.md | /a/1.md | "one"',
  '2026-06-23T11:00:00.000Z | regina | build | 2.md | /a/2.md | "two"',
].join("\n");

describe("GET /artifacts/entries + /artifacts/parity", () => {
  it("serves the DV1 envelope from substrate (read_path:substrate)", async () => {
    const app = await bootApp(async () => alignedLog);
    const { status, body } = await getJson(app, "/artifacts/entries");
    expect(status).toBe(200);
    expect(body.schema_version).toBe("read-model.v1");
    expect(body.source.read_path).toBe("substrate");
    expect(body.source.projection).toBe("artifact_entries");
    expect(body.count).toBe(2);
    expect(body.items[0].kind).toBe("artifact");
    // newest-first by produced_at
    expect(body.items[0].path).toBe("/a/2.md");
  });

  it("parity is ok against an aligned delivery-log walk", async () => {
    const app = await bootApp(async () => alignedLog);
    const { body } = await getJson(app, "/artifacts/parity");
    expect(body.status).toBe("ok");
  });

  it("parity drifts (blocks the flag) when the log has a row the substrate lacks", async () => {
    const app = await bootApp(async () => alignedLog + '\n2026-06-23T12:00:00.000Z | cane | note | 3.md | /a/3.md | "three"');
    const { body } = await getJson(app, "/artifacts/parity");
    expect(body.status).toBe("drift");
  });

  it("PROOF: moving delivery-log.md aside does not change the substrate feed", async () => {
    const app = await bootApp(async () => null); // file gone
    const entries = await getJson(app, "/artifacts/entries");
    expect(entries.body.count).toBe(2); // feed unchanged — reads substrate, not the file
    const parity = await getJson(app, "/artifacts/parity");
    expect(parity.body.status).toBe("drift"); // can't confirm parity w/o the file
  });
});

describe("GET /artifacts/search (L-1/L-2 FTS5)", () => {
  it("returns ranked ArtifactEntry results in the read-model envelope", async () => {
    const app = await bootApp(async () => alignedLog); // seeds 'one' (roger/spec) + 'two' (regina/build)
    const { status, body } = await getJson(app, "/artifacts/search?q=one");
    expect(status).toBe(200);
    expect(body.schema_version).toBe("read-model.v1");
    expect(body.source).toEqual({ read_path: "substrate", projection: "artifact_search" });
    expect(body.count).toBe(1);
    expect(body.items[0].kind).toBe("artifact");
    expect(body.items[0].path).toBe("/a/1.md"); // the 'one' artifact
    expect(body.items[0].provenance).toBeTruthy(); // DV2 provenance carried through
  });

  it("matches across tag and agent, not just title", async () => {
    const app = await bootApp(async () => alignedLog);
    expect((await getJson(app, "/artifacts/search?q=build")).body.items.map((i: any) => i.path)).toEqual(["/a/2.md"]);
    expect((await getJson(app, "/artifacts/search?q=regina")).body.items.map((i: any) => i.path)).toEqual(["/a/2.md"]);
  });

  it("empty / missing query returns an empty envelope (no 500)", async () => {
    const app = await bootApp(async () => alignedLog);
    const { status, body } = await getJson(app, "/artifacts/search?q=");
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });
});

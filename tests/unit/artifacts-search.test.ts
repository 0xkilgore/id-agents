// L-1/L-2 — full-text search over the artifacts substrate (SQLite FTS5).

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  migrateOutputsTables,
  registerArtifact,
  searchArtifacts,
  toFtsMatch,
} from "../../src/outputs/storage.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateOutputsTables(adapter);
});

async function artifact(over: {
  id: string;
  title?: string | null;
  basename?: string;
  agent?: string;
  tag?: string | null;
}) {
  await registerArtifact(
    adapter,
    {
      artifact_id: over.id,
      abs_path: `/out/${over.id}.md`,
      basename: over.basename ?? `${over.id}.md`,
      agent: over.agent ?? "roger",
      tag: over.tag ?? null,
      title: over.title ?? null,
      produced_at: new Date().toISOString(),
    },
    new Date().toISOString(),
  );
}

describe("toFtsMatch (input sanitization)", () => {
  it("turns words into ANDed prefix terms", () => {
    expect(toFtsMatch("deploy automation")).toBe("deploy* automation*");
  });
  it("strips FTS5 operators/punctuation so input can't break MATCH", () => {
    expect(toFtsMatch('foo" OR bar; DROP*')).toBe("foo* or* bar* drop*");
  });
  it("returns null for empty / punctuation-only input", () => {
    expect(toFtsMatch("")).toBeNull();
    expect(toFtsMatch("  !!! ")).toBeNull();
  });
});

describe("searchArtifacts (FTS5)", () => {
  it("creates the FTS index and returns matches across artifacts", async () => {
    await artifact({ id: "a1", title: "Deploy automation pipeline" });
    await artifact({ id: "a2", title: "Quarterly finance report" });
    await artifact({ id: "a3", title: "Deploy runbook" });

    const hits = await searchArtifacts(adapter, "deploy");
    const ids = hits.map((h) => h.artifact_id).sort();
    expect(ids).toEqual(["a1", "a3"]); // a2 excluded
  });

  it("ranks the stronger match first (bm25)", async () => {
    await artifact({ id: "strong", title: "deploy deploy deploy", tag: "deploy" });
    await artifact({ id: "weak", title: "a note", basename: "deploy.md" });

    const hits = await searchArtifacts(adapter, "deploy");
    expect(hits[0].artifact_id).toBe("strong");
    expect(hits.map((h) => h.artifact_id)).toContain("weak");
  });

  it("matches on prefix (token*)", async () => {
    await artifact({ id: "p1", title: "automation framework" });
    const hits = await searchArtifacts(adapter, "auto");
    expect(hits.map((h) => h.artifact_id)).toEqual(["p1"]);
  });

  it("searches across basename, tag and agent — not just title", async () => {
    await artifact({ id: "b1", title: null, basename: "kapelle-roadmap.md" });
    await artifact({ id: "t1", title: "x", tag: "trinity" });
    await artifact({ id: "g1", title: "y", agent: "regina" });

    expect((await searchArtifacts(adapter, "kapelle")).map((h) => h.artifact_id)).toEqual(["b1"]);
    expect((await searchArtifacts(adapter, "trinity")).map((h) => h.artifact_id)).toEqual(["t1"]);
    expect((await searchArtifacts(adapter, "regina")).map((h) => h.artifact_id)).toEqual(["g1"]);
  });

  it("stays in sync when an artifact's title is updated (trigger)", async () => {
    await artifact({ id: "u1", title: "original heading" });
    expect((await searchArtifacts(adapter, "original")).length).toBe(1);
    await artifact({ id: "u1", title: "revised heading" }); // re-register = update
    expect((await searchArtifacts(adapter, "original")).length).toBe(0);
    expect((await searchArtifacts(adapter, "revised")).map((h) => h.artifact_id)).toEqual(["u1"]);
  });

  it("returns the full catalog row shape for each hit", async () => {
    await artifact({ id: "shape", title: "deploy", agent: "roger", tag: "trinity" });
    const [hit] = await searchArtifacts(adapter, "deploy");
    expect(hit.artifact_id).toBe("shape");
    expect(hit.agent).toBe("roger");
    expect(hit.tag).toBe("trinity");
    expect(hit.abs_path).toBe("/out/shape.md");
  });

  it("returns [] for a query with no searchable tokens", async () => {
    await artifact({ id: "x", title: "deploy" });
    expect(await searchArtifacts(adapter, "   ?!?  ")).toEqual([]);
  });

  it("respects limit/offset", async () => {
    for (let i = 0; i < 5; i++) await artifact({ id: `m${i}`, title: "deploy match" });
    expect((await searchArtifacts(adapter, "deploy", { limit: 2 })).length).toBe(2);
    expect((await searchArtifacts(adapter, "deploy", { limit: 10 })).length).toBe(5);
  });
});

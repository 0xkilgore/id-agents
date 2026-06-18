// NW-6 / T11.6+T11.7 — artifact accessibility: project-ROOT scanning, the
// missing-sweep (404 fix), source_badges + reconciled_at.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, getArtifact, registerArtifact } from "../../src/outputs/storage.js";
import {
  reconcileFilesystemArtifacts,
  artifactRootIds,
} from "../../src/outputs/filesystem-reconciler.js";
import { artifactIdFromPath } from "../../src/outputs/storage.js";

let adapter: SqliteAdapter;
let dir: string;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "artacc-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, body = "x") {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe("reconcileFilesystemArtifacts — accessibility", () => {
  it("catalogs a project-ROOT file AND a drafts/ file (the findability fix)", async () => {
    const rootFile = write("2026-06-17-one-pager.md"); // at the project root
    const draftFile = write("drafts/2026-06-17-draft.md");
    const codeFile = write("node_modules/pkg/index.js"); // must NOT be cataloged

    const r = await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "rams", workingDirectory: dir }],
    });

    expect(await getArtifact(adapter, artifactIdFromPath(rootFile))).not.toBeNull();
    expect(await getArtifact(adapter, artifactIdFromPath(draftFile))).not.toBeNull();
    expect(await getArtifact(adapter, artifactIdFromPath(codeFile))).toBeNull();
    expect(r.inserted).toBeGreaterThanOrEqual(2);

    const rootRow = await getArtifact(adapter, artifactIdFromPath(rootFile));
    expect(rootRow?.tag).toBe("root"); // ROOT_LEVEL surfaced as 'root'
  });

  it("sets source_badges + reconciled_at; unions badges across sources", async () => {
    const f = write("output/2026-06-17-report.md");
    const id = artifactIdFromPath(f);
    // Pre-cataloged by agent-done.
    await registerArtifact(adapter, { basename: "2026-06-17-report.md", agent: "roger", abs_path: f, produced_at: new Date().toISOString(), source: "agent-done" }, new Date().toISOString());

    await reconcileFilesystemArtifacts(adapter, { roots: [{ agent: "roger", workingDirectory: dir }] });

    const row = await getArtifact(adapter, id);
    expect(row?.reconciled_at).not.toBeNull();
    expect(JSON.parse(row!.source_badges).sort()).toEqual(["agent-done", "filesystem"]);
  });

  it("missing-sweep flips a vanished file to availability='missing', restores on reappear", async () => {
    const f = write("output/2026-06-17-vanishing.md");
    const id = artifactIdFromPath(f);
    await reconcileFilesystemArtifacts(adapter, { roots: [{ agent: "roger", workingDirectory: dir }] });
    expect((await getArtifact(adapter, id))?.availability).toBe("present");

    fs.rmSync(f);
    const r2 = await reconcileFilesystemArtifacts(adapter, { roots: [{ agent: "roger", workingDirectory: dir }] });
    expect(r2.marked_missing).toBeGreaterThanOrEqual(1);
    expect((await getArtifact(adapter, id))?.availability).toBe("missing"); // NOT 404

    write("output/2026-06-17-vanishing.md"); // reappears
    const r3 = await reconcileFilesystemArtifacts(adapter, { roots: [{ agent: "roger", workingDirectory: dir }] });
    expect(r3.restored_present).toBeGreaterThanOrEqual(1);
    expect((await getArtifact(adapter, id))?.availability).toBe("present");
  });

  it("does not descend into node_modules at the project root", async () => {
    write("node_modules/big/a.md");
    write("2026-06-17-keep.md");
    const r = await reconcileFilesystemArtifacts(adapter, { roots: [{ agent: "x", workingDirectory: dir }] });
    // only the root-level keep file (+ no node_modules) — root scan is shallow.
    expect(await getArtifact(adapter, artifactIdFromPath(path.join(dir, "node_modules/big/a.md")))).toBeNull();
  });
});

describe("artifactRootIds", () => {
  it("exposes the configured roots incl. project ROOT + drafts", () => {
    expect(artifactRootIds()).toContain(".");
    expect(artifactRootIds()).toContain("drafts");
    expect(artifactRootIds()).toContain("output");
  });
});

// GET /artifacts feed must order + DISPLAY by the catalog's frozen produced_at
// (the real first-seen file mtime), NOT the live re-stat'd modified_at.
//
// Bug: readArtifacts() stat'd each file live and sorted/exposed modified_at.
// When old files get re-touched/re-synced (e.g. the noon catalog sweep / Dropbox
// re-sync), their live mtime jumps to "now", so genuinely-old artifacts sorted
// to the top of the feed and displayed today's noon instead of their real date.
//
// enrichArtifactsWithProducedAt() pins produced_at as the canonical "when": it
// prefers the catalog's frozen produced_at, then completed_at, then (last) the
// volatile modified_at — and orders newest-first by it.

import { describe, it, expect } from "vitest";
import { enrichArtifactsWithProducedAt } from "../../src/dispatch-scheduler/read-model.js";

describe("enrichArtifactsWithProducedAt", () => {
  it("uses the catalog's frozen produced_at, not the live modified_at", () => {
    const artifacts = [
      // An old artifact (produced 6/22) whose file was re-touched at noon today.
      { path: "/a/old.md", modified_at: "2026-06-24T17:31:00.000Z", completed_at: null },
    ];
    const catalog = new Map([["/a/old.md", "2026-06-22T14:03:00.000Z"]]);
    const [row] = enrichArtifactsWithProducedAt(artifacts, catalog);
    expect(row.produced_at).toBe("2026-06-22T14:03:00.000Z");
  });

  it("orders newest-first by produced_at, dispersing a re-stat'd noon batch", () => {
    const noon = "2026-06-24T17:31:00.000Z"; // every file's live mtime after the sweep
    const artifacts = [
      { path: "/a/jun20.md", modified_at: noon, completed_at: null },
      { path: "/a/jun24.md", modified_at: noon, completed_at: null },
      { path: "/a/jun22.md", modified_at: noon, completed_at: null },
    ];
    const catalog = new Map([
      ["/a/jun20.md", "2026-06-20T09:00:00.000Z"],
      ["/a/jun24.md", "2026-06-24T08:00:00.000Z"],
      ["/a/jun22.md", "2026-06-22T11:00:00.000Z"],
    ]);
    const ordered = enrichArtifactsWithProducedAt(artifacts, catalog).map((a) => a.path);
    expect(ordered).toEqual(["/a/jun24.md", "/a/jun22.md", "/a/jun20.md"]);
  });

  it("falls back to completed_at, then modified_at, when not cataloged", () => {
    const artifacts = [
      { path: "/a/dispatch.md", modified_at: "2026-06-24T17:31:00.000Z", completed_at: "2026-06-23T10:00:00.000Z" },
      { path: "/a/bare.md", modified_at: "2026-06-21T10:00:00.000Z", completed_at: null },
    ];
    const out = enrichArtifactsWithProducedAt(artifacts, new Map());
    const byPath = Object.fromEntries(out.map((a) => [a.path, a.produced_at]));
    expect(byPath["/a/dispatch.md"]).toBe("2026-06-23T10:00:00.000Z"); // completed_at preferred over live mtime
    expect(byPath["/a/bare.md"]).toBe("2026-06-21T10:00:00.000Z");     // modified_at last resort
  });

  it("does not mutate the input rows", () => {
    const artifacts = [{ path: "/a/x.md", modified_at: "2026-06-24T17:31:00.000Z", completed_at: null }];
    enrichArtifactsWithProducedAt(artifacts, new Map([["/a/x.md", "2026-06-22T00:00:00.000Z"]]));
    expect("produced_at" in artifacts[0]).toBe(false);
  });
});

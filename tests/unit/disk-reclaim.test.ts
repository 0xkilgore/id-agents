import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSafeDiskReclaim } from "../../src/disk-reclaim.js";

describe("runSafeDiskReclaim", () => {
  it("removes stale lsof-clean scratch and keeps fresh scratch", () => {
    const root = mkdtempSync(path.join(tmpdir(), "disk-reclaim-test-"));
    const tmpRoot = path.join(root, "scratch");
    const home = path.join(root, "home");
    mkdirSync(path.join(tmpRoot, "promotions"), { recursive: true });
    mkdirSync(home, { recursive: true });

    const stale = path.join(tmpRoot, "promotions", "old");
    const fresh = path.join(tmpRoot, "promotions", "fresh");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(path.join(stale, "payload.bin"), "x".repeat(1024));
    writeFileSync(path.join(fresh, "payload.bin"), "x".repeat(1024));

    const now = Date.parse("2026-07-15T18:00:00Z");
    utimesSync(stale, new Date(now - 8 * 60 * 60 * 1000), new Date(now - 8 * 60 * 60 * 1000));
    utimesSync(fresh, new Date(now - 30 * 60 * 1000), new Date(now - 30 * 60 * 1000));

    try {
      const result = runSafeDiskReclaim({
        root: tmpRoot,
        homeDir: home,
        repoRoots: [],
        nowMs: now,
      });

      expect(result.schema_version).toBe("disk-reclaim.v2");
      expect(result.removed).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(result.items.some((item) => item.path === fresh && item.action !== "kept")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts oldest entries until below the configured cap", () => {
    const root=mkdtempSync(path.join(tmpdir(),"scratch-cap-test-")); mkdirSync(path.join(root,"builds"));
    const old=path.join(root,"builds","old"), fresh=path.join(root,"builds","fresh"); mkdirSync(old);mkdirSync(fresh);
    writeFileSync(path.join(old,"x"),"x".repeat(2048)); writeFileSync(path.join(fresh,"x"),"x".repeat(2048));
    const now=Date.now();utimesSync(old,new Date(now-1000),new Date(now-1000));
    try { const result=runSafeDiskReclaim({root,capBytes:3000,ttlMs:9999999,nowMs:now}); expect(result.items.some(i=>i.kind==="scratch_over_cap"&&i.path===old&&i.action==="removed")).toBe(true); expect(existsSync(fresh)).toBe(true); } finally {rmSync(root,{recursive:true,force:true});}
  });
});

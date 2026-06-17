// Claude Code session rotation — pre-launch transcript rotation/compaction.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  rotateSessionsIfNeeded,
  encodeProjectDir,
  loadSessionRotationConfig,
  type SessionRotationConfig,
} from "../../src/harness/session-rotation.js";

const CWD = "/Users/kilgore/Dropbox/Code/sentinel";
const ENCODED = "-Users-kilgore-Dropbox-Code-sentinel";

let root: string;
let cfg: SessionRotationConfig;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sessrot-"));
  cfg = {
    enabled: true,
    max_bytes: 1000,
    max_age_days: 14,
    projects_root: path.join(root, "projects"),
    archive_root: path.join(root, "archive"),
  };
  fs.mkdirSync(path.join(cfg.projects_root, ENCODED), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSession(id: string, bytes: number, ageMs = 0) {
  const p = path.join(cfg.projects_root, ENCODED, `${id}.jsonl`);
  fs.writeFileSync(p, "x".repeat(bytes));
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

function exists(id: string): boolean {
  return fs.existsSync(path.join(cfg.projects_root, ENCODED, `${id}.jsonl`));
}

describe("encodeProjectDir", () => {
  it("maps / and . to - (Claude Code project dir scheme)", () => {
    expect(encodeProjectDir(CWD)).toBe(ENCODED);
    expect(encodeProjectDir("/a/b.c")).toBe("-a-b-c");
  });
});

describe("loadSessionRotationConfig", () => {
  it("conservative defaults; env-tunable; disable flag", () => {
    const d = loadSessionRotationConfig({ HOME: "/home/x" } as NodeJS.ProcessEnv);
    expect(d.enabled).toBe(true);
    expect(d.max_bytes).toBe(3_000_000);
    expect(d.projects_root).toBe("/home/x/.claude/projects");
    const off = loadSessionRotationConfig({ CLAUDE_SESSION_ROTATION_ENABLED: "false" } as NodeJS.ProcessEnv);
    expect(off.enabled).toBe(false);
    const tuned = loadSessionRotationConfig({ CLAUDE_SESSION_MAX_BYTES: "500" } as NodeJS.ProcessEnv);
    expect(tuned.max_bytes).toBe(500);
  });
});

describe("rotateSessionsIfNeeded", () => {
  it("rotates an OVERSIZE resume target and forces a fresh session", () => {
    writeSession("big", 5000);
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, resume: "big", config: cfg });
    expect(r.resume).toBeUndefined(); // forced fresh
    expect(r.rotated).toContain("big.jsonl");
    expect(exists("big")).toBe(false); // moved out
    expect(r.reason).toMatch(/starting fresh/);
    // archived (moved, not deleted)
    const archived = fs.readdirSync(cfg.archive_root, { recursive: true } as { recursive: true });
    expect(archived.some((f) => String(f).endsWith("big.jsonl"))).toBe(true);
  });

  it("keeps a SMALL resume target untouched", () => {
    writeSession("small", 200);
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, resume: "small", config: cfg });
    expect(r.resume).toBe("small");
    expect(r.rotated).toHaveLength(0);
    expect(exists("small")).toBe(true);
  });

  it("never rotates a small active session for age alone", () => {
    writeSession("active", 200, 90 * 86_400_000); // old but small + being resumed
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, resume: "active", config: cfg });
    expect(r.resume).toBe("active");
    expect(exists("active")).toBe(true);
  });

  it("sweeps dead (non-resumed) transcripts that are oversize or stale", () => {
    writeSession("active", 200); // small, resumed -> kept
    writeSession("deadBig", 5000); // oversize dead -> swept
    writeSession("deadOld", 100, 30 * 86_400_000); // stale dead -> swept
    writeSession("deadFresh", 100, 0); // small + recent dead -> kept
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, resume: "active", config: cfg });
    expect(r.resume).toBe("active");
    expect(exists("active")).toBe(true);
    expect(exists("deadFresh")).toBe(true);
    expect(exists("deadBig")).toBe(false);
    expect(exists("deadOld")).toBe(false);
    expect(r.rotated.sort()).toEqual(["deadBig.jsonl", "deadOld.jsonl"]);
  });

  it("no-ops when disabled", () => {
    writeSession("big", 5000);
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, resume: "big", config: { ...cfg, enabled: false } });
    expect(r.resume).toBe("big");
    expect(exists("big")).toBe(true);
  });

  it("no-ops cleanly when the project dir does not exist (fresh agent)", () => {
    const r = rotateSessionsIfNeeded({ workingDirectory: "/nope/never", resume: "x", config: cfg });
    expect(r.resume).toBe("x");
    expect(r.rotated).toHaveLength(0);
  });

  it("returns resume unchanged when no resume id is given (fresh launch)", () => {
    writeSession("orphanBig", 5000); // dead oversize -> still swept
    const r = rotateSessionsIfNeeded({ workingDirectory: CWD, config: cfg });
    expect(r.resume).toBeUndefined();
    expect(r.rotated).toContain("orphanBig.jsonl");
  });
});

// T11.1 build-stamp: the running build identity + behind-origin staleness signal
// that surfaces on /health + /monitor/fleet.

import { describe, it, expect } from "vitest";
import {
  computeBuildStatus,
  loadBuildStatus,
  type BuildStatusInput,
} from "../../src/build-info.js";

function input(over: Partial<BuildStatusInput> = {}): BuildStatusInput {
  return {
    build_sha: "aaaaaaa",
    build_time: "2026-06-16T12:00:00.000Z",
    local_main_sha: "aaaaaaa",
    origin_main_sha: "aaaaaaa",
    source: "build_stamp",
    ...over,
  };
}

describe("computeBuildStatus", () => {
  it("is up-to-date when the build SHA equals origin/main", () => {
    const s = computeBuildStatus(input());
    expect(s.behind_origin).toBe(false);
    expect(s.build_sha).toBe("aaaaaaa");
  });

  it("flags behind_origin when the build SHA differs from origin/main", () => {
    const s = computeBuildStatus(input({ build_sha: "old1234", origin_main_sha: "new5678" }));
    expect(s.behind_origin).toBe(true);
  });

  it("returns behind_origin=null when build SHA is unknown", () => {
    expect(computeBuildStatus(input({ build_sha: null })).behind_origin).toBeNull();
  });

  it("returns behind_origin=null when origin/main is unknown (no remote ref)", () => {
    expect(computeBuildStatus(input({ origin_main_sha: null })).behind_origin).toBeNull();
  });

  it("passes through the resolved fields unchanged", () => {
    const s = computeBuildStatus(input({ source: "runtime_fallback", local_main_sha: "bbbb" }));
    expect(s.source).toBe("runtime_fallback");
    expect(s.local_main_sha).toBe("bbbb");
    expect(s.build_time).toBe("2026-06-16T12:00:00.000Z");
  });
});

describe("loadBuildStatus (runtime resolution against this repo)", () => {
  it("falls back to git HEAD for build_sha when no build-info.json stamp exists", () => {
    // distDir points somewhere with no build-info.json → runtime fallback path.
    const s = loadBuildStatus({ repoDir: process.cwd(), distDir: "/nonexistent-dist-dir" });
    // In a git checkout this resolves the current HEAD; tolerate non-git envs.
    if (s.build_sha) {
      expect(s.build_sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(s.source).toBe("runtime_fallback");
    } else {
      expect(s.source).toBe("unknown");
    }
  });
});

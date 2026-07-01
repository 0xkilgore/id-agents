// T11.1 build-stamp: the running build identity + behind-origin staleness signal
// that surfaces on /health + /monitor/fleet.

import { describe, it, expect } from "vitest";
import {
  classifyBuildFreshness,
  computeBuildStatus,
  loadBuildStatus,
  type BuildStatusInput,
} from "../../src/build-info.js";

function input(over: Partial<BuildStatusInput> = {}): BuildStatusInput {
  return {
    build_sha: "aaaaaaa",
    build_time: "2026-06-16T12:00:00.000Z",
    source_branch_sha: "aaaaaaa",
    source_branch_name: "main",
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
    expect(s.freshness.classification).toBe("fresh");
    expect(s.build_sha).toBe("aaaaaaa");
  });

  it("flags behind_origin when the build SHA differs from origin/main", () => {
    const s = computeBuildStatus(input({ build_sha: "old1234", origin_main_sha: "new5678" }));
    expect(s.behind_origin).toBe(true);
    expect(s.freshness.classification).toBe("server_stale_and_source_unpromoted");
  });

  it("returns behind_origin=null when build SHA is unknown", () => {
    const s = computeBuildStatus(input({ build_sha: null }));
    expect(s.behind_origin).toBeNull();
    expect(s.freshness.classification).toBe("unknown");
  });

  it("returns behind_origin=null when origin/main is unknown (no remote ref)", () => {
    const s = computeBuildStatus(input({ origin_main_sha: null }));
    expect(s.behind_origin).toBeNull();
    expect(s.freshness.classification).toBe("unknown");
  });

  it("passes through the resolved fields unchanged", () => {
    const s = computeBuildStatus(input({ source: "runtime_fallback", local_main_sha: "bbbb" }));
    expect(s.source).toBe("runtime_fallback");
    expect(s.local_main_sha).toBe("bbbb");
    expect(s.build_time).toBe("2026-06-16T12:00:00.000Z");
    expect(s.freshness.running_manager_build_sha).toBe("aaaaaaa");
    expect(s.freshness.promoted_main_sha).toBe("aaaaaaa");
  });

  it("classifies shipped-but-server-not-rebuilt when promoted main is ahead of the running build", () => {
    const s = computeBuildStatus(input({
      build_sha: "old1234",
      source_branch_sha: "new5678",
      origin_main_sha: "new5678",
    }));
    expect(s.freshness.classification).toBe("server_not_rebuilt");
    expect(s.freshness.running_manager_build_sha).toBe("old1234");
    expect(s.freshness.source_branch_sha).toBe("new5678");
    expect(s.freshness.promoted_main_sha).toBe("new5678");
  });

  it("classifies source-branch drift as stale-by-design when the running manager matches promoted main", () => {
    const s = computeBuildStatus(input({
      build_sha: "main999",
      source_branch_sha: "feature111",
      source_branch_name: "build/reliability-gap",
      origin_main_sha: "main999",
    }));
    expect(s.behind_origin).toBe(false);
    expect(s.freshness.classification).toBe("stale_by_design_cross_repo_diff");
    expect(s.freshness.source_branch_name).toBe("build/reliability-gap");
  });

  it("classifies the combined failure when both the server and source branch differ from promoted main", () => {
    const s = classifyBuildFreshness({
      running_manager_build_sha: "oldserver",
      source_branch_sha: "feature",
      source_branch_name: "feature/work",
      promoted_main_sha: "main",
      behind_promoted_main: true,
      source_differs_from_promoted_main: true,
    });
    expect(s.classification).toBe("server_stale_and_source_unpromoted");
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

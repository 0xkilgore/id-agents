// T11.1 build-stamp: the running build identity + behind-origin staleness signal
// that surfaces on /health + /monitor/fleet.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyBuildFreshness,
  buildSourceDiagnostic,
  computeBuildStatus,
  isRuntimeOnlyPath,
  isRuntimePolicyOnlyDelta,
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

  it("projects server_stale_and_source_unpromoted as System/Diagnostics redeploy state", () => {
    const s = computeBuildStatus(input({
      build_sha: "old1234",
      source_branch_sha: "feature999",
      source_branch_name: "wave91-build-behind-origin-health",
      origin_main_sha: "main9999",
    }));

    const diagnostic = buildSourceDiagnostic(s, "2026-07-12T00:00:00.000Z");

    expect(diagnostic).toMatchObject({
      schema_version: "manager.build_source_diagnostic.v1",
      surface: "System/Diagnostics",
      state: "diagnostic",
      classification: "server_stale_and_source_unpromoted",
      build_sha: "old1234",
      origin_main_sha: "main9999",
      behind_origin_since: "2026-07-12T00:00:00.000Z",
    });
    expect(diagnostic.recommended_redeploy_action).toContain("Promote");
    expect(diagnostic.recommended_redeploy_action).toContain("redeploy the manager");
  });

  it("projects nominal build source as ok with no redeploy action", () => {
    const s = computeBuildStatus(input());

    const diagnostic = buildSourceDiagnostic(s, null);

    expect(diagnostic).toMatchObject({
      surface: "System/Diagnostics",
      state: "ok",
      classification: "fresh",
      build_sha: "aaaaaaa",
      origin_main_sha: "aaaaaaa",
      behind_origin_since: null,
      recommended_redeploy_action: null,
    });
  });
});

describe("computeBuildStatus — exact promoted-sha delta (no false-stale)", () => {
  it("is NOT behind when the running build is ahead of / even with promoted main (empty delta)", () => {
    // build differs from origin only because the build is AHEAD (the local origin
    // ref lags a just-promoted build): the three-dot delta is empty → not stale.
    const s = computeBuildStatus(input({ build_sha: "ahead99", origin_main_sha: "old0001" }), []);
    expect(s.behind_origin).toBe(false);
    expect(s.freshness.classification).not.toBe("server_not_rebuilt");
    expect(s.freshness.classification).not.toBe("server_stale_and_source_unpromoted");
  });

  it("is NOT behind when promoted main is ahead only by a runtime-policy/config commit", () => {
    // The 4644345 false drift: origin advanced by configs/model-policy.json only,
    // which the running manager reads live — no rebuild required, so not stale.
    const s = computeBuildStatus(
      input({ build_sha: "old0001", origin_main_sha: "cfg9999" }),
      ["configs/model-policy.json"],
    );
    expect(s.behind_origin).toBe(false);
  });

  it("is NOT behind when the behind-delta is docs-only", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", origin_main_sha: "doc9999" }),
      ["README.md", "docs/manager-deploy-runbook.md"],
    );
    expect(s.behind_origin).toBe(false);
  });

  it("is NOT behind when promoted main only changes the external deploy watchdog", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", origin_main_sha: "watch999" }),
      [
        "scripts/deploy-freshness-watchdog.mjs",
        "scripts/lib/deploy-watchdog-decision.mjs",
        "tests/unit/deploy-watchdog-node-modules-fix.test.ts",
      ],
    );
    expect(s.behind_origin).toBe(false);
  });

  it("is NOT behind when promoted main only changes tests", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", origin_main_sha: "test999" }),
      ["tests/unit/build-info.test.ts"],
    );
    expect(s.behind_origin).toBe(false);
  });

  it("IS behind (server_not_rebuilt) when promoted main is ahead by a build-affecting src/ commit", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", source_branch_sha: "src9999", origin_main_sha: "src9999" }),
      ["src/agent-manager-db.ts"],
    );
    expect(s.behind_origin).toBe(true);
    expect(s.freshness.classification).toBe("server_not_rebuilt");
  });

  it("IS behind when a mixed delta touches any build-affecting path", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", origin_main_sha: "mix9999" }),
      ["configs/model-policy.json", "src/loops/registry.ts"],
    );
    expect(s.behind_origin).toBe(true);
  });

  it("falls back to the raw sha comparison when the exact delta is unavailable (null)", () => {
    const s = computeBuildStatus(input({ build_sha: "old0001", origin_main_sha: "new9999" }), null);
    expect(s.behind_origin).toBe(true);
  });

  it("still resolves to fresh when build equals promoted main regardless of delta arg", () => {
    const s = computeBuildStatus(input(), []); // build === origin
    expect(s.behind_origin).toBe(false);
    expect(s.freshness.classification).toBe("fresh");
  });
});

describe("computeBuildStatus — RD-012 squash/rebase promotion (tree-identical override)", () => {
  it("is NOT behind when a squash-merge's three-dot delta looks build-affecting but the trees are identical", () => {
    // A squash merge on main is a NEW commit with no history relationship to the
    // feature-branch SHA the build was compiled from — three-dot diffs against
    // their merge-base, so it can list every file the feature branch ever
    // touched (including src/) even though main's final tree is byte-identical
    // to what's already running. treeIdentical=true must win.
    const s = computeBuildStatus(
      input({ build_sha: "feat0001", source_branch_sha: "squash999", origin_main_sha: "squash999" }),
      ["src/agent-manager-db.ts", "src/build-info.ts"],
      true,
    );
    expect(s.behind_origin).toBe(false);
    expect(s.freshness.classification).toBe("fresh");
  });

  it("is NOT behind when the three-dot delta is unresolvable (unrelated histories) but the trees are identical", () => {
    // git failed to compute the three-dot delta at all (behindPaths=null) — the
    // documented "unrelated histories" case a squash/rebase can produce. Without
    // treeIdentical this used to fall back to the raw-SHA comparison (stale).
    const s = computeBuildStatus(
      input({ build_sha: "feat0001", source_branch_sha: "squash999", origin_main_sha: "squash999" }),
      null,
      true,
    );
    expect(s.behind_origin).toBe(false);
  });

  it("still uses the behindPaths verdict when trees are NOT identical (treeIdentical=false)", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", source_branch_sha: "src9999", origin_main_sha: "src9999" }),
      ["src/agent-manager-db.ts"],
      false,
    );
    expect(s.behind_origin).toBe(true);
    expect(s.freshness.classification).toBe("server_not_rebuilt");
  });

  it("still uses the behindPaths verdict when treeIdentical is unknown (null) — no behavior change from before RD-012", () => {
    const s = computeBuildStatus(
      input({ build_sha: "old0001", source_branch_sha: "src9999", origin_main_sha: "src9999" }),
      ["src/agent-manager-db.ts"],
      null,
    );
    expect(s.behind_origin).toBe(true);
  });

  it("treeIdentical cannot override an exact SHA match short-circuit (already fresh either way)", () => {
    const s = computeBuildStatus(input(), [], false);
    expect(s.behind_origin).toBe(false);
  });
});

describe("runtime-only path classification", () => {
  it("isRuntimeOnlyPath: configs/, docs/, and top-level *.md are runtime-only", () => {
    expect(isRuntimeOnlyPath("configs/model-policy.json")).toBe(true);
    expect(isRuntimeOnlyPath("docs/manager-deploy-runbook.md")).toBe(true);
    expect(isRuntimeOnlyPath("README.md")).toBe(true);
    expect(isRuntimeOnlyPath("tests/unit/build-info.test.ts")).toBe(true);
    expect(isRuntimeOnlyPath("scripts/deploy-freshness-watchdog.mjs")).toBe(true);
    expect(isRuntimeOnlyPath("scripts/lib/deploy-watchdog-decision.mjs")).toBe(true);
    expect(isRuntimeOnlyPath("scripts/launchd/com.kilgore.deploy-freshness-watchdog.plist")).toBe(true);
    expect(isRuntimeOnlyPath("src/build-info.ts")).toBe(false);
    expect(isRuntimeOnlyPath("scripts/write-build-info.mjs")).toBe(false);
    expect(isRuntimeOnlyPath("package.json")).toBe(false);
    expect(isRuntimeOnlyPath("tsconfig.json")).toBe(false);
    expect(isRuntimeOnlyPath("")).toBe(false);
  });

  it("isRuntimePolicyOnlyDelta: true only when EVERY path is runtime-only; [] is not policy-only", () => {
    expect(isRuntimePolicyOnlyDelta(["configs/a.json", "docs/x.md", "README.md"])).toBe(true);
    expect(isRuntimePolicyOnlyDelta(["configs/a.json", "src/x.ts"])).toBe(false);
    expect(isRuntimePolicyOnlyDelta(["scripts/build.mjs"])).toBe(false);
    expect(isRuntimePolicyOnlyDelta([])).toBe(false);
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

  it("uses the pushed remote main tip even when local origin/main has not been fetched", () => {
    const root = mkdtempSync(join(tmpdir(), "build-info-remote-tip-"));
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    const manager = join(root, "manager");
    const dist = join(manager, "dist");

    const git = (cwd: string, args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, seed], { stdio: "ignore" });
    git(seed, ["checkout", "-b", "main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test User"]);
    writeFileSync(join(seed, "package.json"), "{}\n", "utf8");
    git(seed, ["add", "package.json"]);
    git(seed, ["commit", "-m", "initial"]);
    git(seed, ["push", "-u", "origin", "main"]);

    execFileSync("git", ["clone", remote, manager], { stdio: "ignore" });
    git(manager, ["checkout", "main"]);
    const oldSha = git(manager, ["rev-parse", "HEAD"]);
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "build-info.json"),
      JSON.stringify({ build_sha: oldSha, build_time: "2026-07-07T00:00:00.000Z" }, null, 2) + "\n",
      "utf8",
    );

    writeFileSync(join(seed, "package.json"), "{\"scripts\":{\"start\":\"node dist/index.js\"}}\n", "utf8");
    git(seed, ["add", "package.json"]);
    git(seed, ["commit", "-m", "promote build-affecting change"]);
    git(seed, ["push", "origin", "main"]);
    const newSha = git(seed, ["rev-parse", "HEAD"]);

    expect(git(manager, ["rev-parse", "origin/main"])).toBe(oldSha);

    const s = loadBuildStatus({ repoDir: manager, distDir: dist });
    expect(s.origin_main_sha).toBe(newSha);
    expect(s.build_sha).toBe(oldSha);
    expect(s.behind_origin).toBe(true);
    expect(s.freshness.promoted_main_sha).toBe(newSha);
  });
});

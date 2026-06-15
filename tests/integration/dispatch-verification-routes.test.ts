// W2-1 DispatchVerification — Task 7 integration test.
//
// Drives the full pipeline against a real sqlite db: seed dispatches through
// the SqliteDispatchReactor (enqueue → claim → start → done/failed/promotion),
// run the DispatchVerificationJob.runOnce() with a real fs-backed statArtifact,
// then read the projection back through the route handlers and assert the
// public effectiveness/dispatches shapes (including fleet↔agent reconciliation).
//
// The DB harness (mkdtemp + SqliteAdapter + migrateSqlite + teams row +
// SqliteDispatchReactor/DispatchDocClient with an injected clock) is copied
// from tests/unit/dispatch-artifact-path.test.ts. The clock is MUTABLE here so
// the delivery window [started_at, completed_at] can be advanced per dispatch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rmSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";
import { DispatchVerificationStorage } from "../../src/dispatch-verification/storage.js";
import { DispatchVerificationJob } from "../../src/dispatch-verification/job.js";
import {
  getAgentsEffectiveness,
  getAgentDispatches,
  type DispatchVerificationRouteDeps,
} from "../../src/dispatch-verification/routes.js";
import type { ArtifactStat } from "../../src/dispatch-verification/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "dispatch-verification", "output");

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

// Clock anchors for the delivery window. started_at <= mtime <= completed_at+60s
// is "fresh".
const T_START = "2026-06-15T20:00:00.000Z"; // started_at for every dispatch
const T_COMPLETE = "2026-06-15T20:10:00.000Z"; // completed_at for every dispatch
const T_RUN = "2026-06-15T20:15:00.000Z"; // job + handler "now" (after all completions)
const FRESH_MTIME = "2026-06-15T20:05:00.000Z"; // inside the window
const STALE_MTIME = "2026-06-13T20:00:00.000Z"; // started_at - 2 days

let tmpDir: string;
let outDir: string;
let adapter: SqliteAdapter;
let nowVal = T_START;

function realFsStat(path: string): ArtifactStat {
  try {
    const s = statSync(path);
    return { exists: true, is_file: s.isFile(), mtime_iso: new Date(s.mtimeMs).toISOString() };
  } catch {
    return { exists: false, is_file: false, mtime_iso: null };
  }
}

function setMtime(path: string, iso: string): void {
  const t = new Date(iso);
  utimesSync(path, t, t);
}

beforeEach(async () => {
  nowVal = T_START;
  tmpDir = mkdtempSync(join(tmpdir(), "dv-routes-"));
  outDir = join(tmpDir, "output");
  mkdirSync(outDir, { recursive: true });
  // Copy fixtures into a temp output dir so we can mutate their mtimes without
  // dirtying the committed repo fixtures.
  copyFileSync(join(FIXTURE_DIR, "fresh-report.md"), join(outDir, "fresh-report.md"));
  copyFileSync(join(FIXTURE_DIR, "stale-report.md"), join(outDir, "stale-report.md"));

  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness() {
  const reactor = new SqliteDispatchReactor({
    adapter,
    teamId: "team-test",
    now: () => nowVal,
  });
  const client = new DispatchDocClient({ reactor, now: () => nowVal });
  return { reactor, client };
}

/**
 * Enqueue → claim → start a single dispatch for `toAgent`, returning its phid.
 * started_at is set to the current `nowVal` (both claim and recordAgentStart
 * read the live clock).
 */
async function enqueueInFlight(
  client: DispatchDocClient,
  reactor: SqliteDispatchReactor,
  queryId: string,
  agentQueryId: string,
  toAgent: string,
  extra: Partial<EnqueueInput> = {},
): Promise<string> {
  const enq = await client.enqueueDispatch({
    ...base,
    query_id: queryId,
    to_agent: toAgent,
    ...extra,
  });
  if (!enq.ok) throw new Error("enqueue failed");
  const phid = enq.value.dispatch_phid;
  await client.claimForStart({ limit: 1 });
  await reactor.recordAgentStart(phid, agentQueryId);
  return phid;
}

describe("W2-1 DispatchVerification — integration (routes + job + reactor)", () => {
  it("classifies four agents end-to-end and reconciles fleet totals", async () => {
    const { reactor, client } = harness();
    const freshPath = join(outDir, "fresh-report.md");
    const stalePath = join(outDir, "stale-report.md");
    const missingPath = join(outDir, "does-not-exist.md");

    // ── roger: VERIFIED FRESH REPORT ──────────────────────────────────────
    nowVal = T_START;
    const rogerFresh = await enqueueInFlight(
      client,
      reactor,
      "q-roger-fresh",
      "aq-roger-fresh",
      "roger",
    );
    nowVal = T_COMPLETE;
    await reactor.markDoneWithResult(rogerFresh, {
      success: true,
      artifact_path: freshPath,
      tl_dr: "weekly digest",
    });

    // ── roger: MISSING ARTIFACT ───────────────────────────────────────────
    nowVal = T_START;
    const rogerMissing = await enqueueInFlight(
      client,
      reactor,
      "q-roger-missing",
      "aq-roger-missing",
      "roger",
    );
    nowVal = T_COMPLETE;
    await reactor.markDoneWithResult(rogerMissing, {
      success: true,
      artifact_path: missingPath,
      tl_dr: "x",
    });

    // ── regina: STALE ARTIFACT ────────────────────────────────────────────
    nowVal = T_START;
    const reginaStale = await enqueueInFlight(
      client,
      reactor,
      "q-regina-stale",
      "aq-regina-stale",
      "regina",
    );
    nowVal = T_COMPLETE;
    await reactor.markDoneWithResult(reginaStale, {
      success: true,
      artifact_path: stalePath,
      tl_dr: "y",
    });

    // ── cursor-coder-pilot: FAILED STRICT-MODE RATE LIMIT ─────────────────
    nowVal = T_START;
    const cursorRate = await enqueueInFlight(
      client,
      reactor,
      "q-cursor-rate",
      "aq-cursor-rate",
      "cursor-coder-pilot",
    );
    nowVal = T_COMPLETE;
    await reactor.markFailed(cursorRate, {
      failure_kind: "strict_mode_classified",
      detail: "strict_mode:rate_limit_error:structured:error.type=rate_limit_error",
    });

    // ── rams: BUILD DISPATCH WITH VALID PROMOTION ─────────────────────────
    nowVal = T_START;
    const ramsBuild = await enqueueInFlight(
      client,
      reactor,
      "q-rams-build",
      "aq-rams-build",
      "rams",
      { promote: true },
    );
    // Belt-and-suspenders: ensure promote=1 on the row regardless of enqueue path.
    await adapter.query(
      "UPDATE dispatch_scheduler_queue SET promote = 1 WHERE dispatch_phid = ?",
      [ramsBuild],
    );
    await reactor.recordPromotionResult(ramsBuild, {
      result: {
        required: true,
        completed: true,
        repos: [
          {
            path: "/repo",
            base: "main",
            source_branch: "feat-x",
            strategy: "fast_forward",
            promoted_sha: "abc",
            remote_main_sha: "abc",
            pushed: true,
            verified: true,
          },
        ],
      },
    });
    nowVal = T_COMPLETE;
    await reactor.markDoneWithResult(ramsBuild, {
      success: true,
      artifact_path: freshPath,
      tl_dr: "shipped",
    });

    // ── Artifact mtimes ───────────────────────────────────────────────────
    // fresh-report.md is reused by roger-fresh and rams; both share the same
    // [started_at, completed_at] window, so one in-window mtime fits both.
    setMtime(freshPath, FRESH_MTIME);
    setMtime(stalePath, STALE_MTIME);

    // ── Run the verification job ──────────────────────────────────────────
    nowVal = T_RUN; // after all completions → nothing spuriously 'expired'
    const storage = new DispatchVerificationStorage(adapter);
    const job = new DispatchVerificationJob({
      teamId: "team-test",
      reactor,
      storage,
      statArtifact: realFsStat,
      now: () => nowVal,
      lookbackDays: 30,
      expiredAfterMs: 300_000,
    });
    await storage.migrate();
    await job.runOnce();

    // Sanity: inspect the raw projection rows so a failure is debuggable.
    const projected = await storage.readWindow("team-test", T_START, T_RUN);
    const byPhid = new Map(projected.map((r) => [r.dispatch_id, r]));
    expect(byPhid.get(rogerFresh)?.verified).toBe(true);
    expect(byPhid.get(rogerFresh)?.failure_type).toBeNull();
    expect(byPhid.get(rogerMissing)?.failure_type).toBe("artifact_missing");
    expect(byPhid.get(reginaStale)?.failure_type).toBe("artifact_stale");
    expect(byPhid.get(cursorRate)?.failure_type).toBe("rate_limited");
    expect(byPhid.get(ramsBuild)?.verified).toBe(true);
    expect(byPhid.get(ramsBuild)?.promotion_required).toBe(true);
    expect(byPhid.get(ramsBuild)?.promotion_verified).toBe(true);

    // ── Route deps ────────────────────────────────────────────────────────
    const deps: DispatchVerificationRouteDeps = {
      storage,
      listRoster: async () => [
        { name: "roger", status: "online" },
        { name: "regina", status: "online" },
        { name: "cursor-coder-pilot", status: "online" },
        { name: "rams", status: "online" },
      ],
      now: () => nowVal,
    };

    // ── Effectiveness assertions ──────────────────────────────────────────
    const eff = await getAgentsEffectiveness(deps, "team-test", { window: "7d" });
    expect(eff.status).toBe(200);
    if (eff.status !== 200 || "error" in eff.body) {
      throw new Error("effectiveness did not return 200");
    }
    const body = eff.body;
    const agents = body.agents;
    const fleet = body.fleet;

    // Reconciliation: fleet totals === sum of per-agent rollups (exact).
    const sumCompleted = agents.reduce((n, a) => n + a.dispatches_completed, 0);
    const sumVerified = agents.reduce((n, a) => n + a.verified_landings, 0);
    expect(fleet.dispatches_completed).toBe(sumCompleted);
    expect(fleet.verified_landings).toBe(sumVerified);

    // roger fresh + rams = at least 2 verified landings.
    expect(fleet.verified_landings).toBeGreaterThanOrEqual(2);

    // Per-agent verified-landing expectations.
    const agentByName = new Map(agents.map((a) => [a.name, a]));
    expect(agentByName.get("roger")?.verified_landings).toBe(1);
    expect(agentByName.get("regina")?.verified_landings).toBe(0);
    expect(agentByName.get("cursor-coder-pilot")?.verified_landings).toBe(0);
    expect(agentByName.get("rams")?.verified_landings).toBe(1);

    // Failure breakdown has at least one of each expected type.
    expect(fleet.failure_breakdown.artifact_missing).toBeGreaterThanOrEqual(1);
    expect(fleet.failure_breakdown.artifact_stale).toBeGreaterThanOrEqual(1);
    expect(fleet.failure_breakdown.rate_limited).toBeGreaterThanOrEqual(1);

    // Failure breakdown reconciliation: fleet[x] === sum over agents of x.
    // (Per-agent failure breakdown is not exposed on the public shape, so we
    //  reconstruct per-agent counts from the projection rows and sum them.)
    for (const ft of ["artifact_missing", "artifact_stale", "rate_limited"] as const) {
      const agentCounts = new Map<string, number>();
      for (const r of projected) {
        if (r.failure_type === ft) {
          agentCounts.set(r.agent_name, (agentCounts.get(r.agent_name) ?? 0) + 1);
        }
      }
      const summed = [...agentCounts.values()].reduce((n, c) => n + c, 0);
      expect(fleet.failure_breakdown[ft]).toBe(summed);
    }

    // ── roger dispatches list ─────────────────────────────────────────────
    const rogerDisp = await getAgentDispatches(deps, "team-test", "roger", {
      window: "7d",
    });
    expect(rogerDisp.status).toBe(200);
    if (rogerDisp.status !== 200 || "error" in rogerDisp.body) {
      throw new Error("roger dispatches did not return 200");
    }
    const items = rogerDisp.body.items;
    const verifiedFresh = items.find(
      (i) => i.verified && i.artifact_path?.endsWith("fresh-report.md"),
    );
    expect(verifiedFresh).toBeDefined();
    const missing = items.find((i) => i.failure_type === "artifact_missing");
    expect(missing).toBeDefined();

    // ── 400: invalid window ───────────────────────────────────────────────
    const bad = await getAgentsEffectiveness(deps, "team-test", { window: "bogus" });
    expect(bad.status).toBe(400);
    if (!("error" in bad.body)) throw new Error("expected error body");
    expect(bad.body.error).toBe("invalid_window");
  });
});

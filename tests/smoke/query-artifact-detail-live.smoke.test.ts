// SPDX-License-Identifier: MIT
//
// 2026-07-10 Spencer-demo bug (coitem_395a544d, commits 21342f9 + 36820a7):
// GET /artifacts/:id/detail 404'd on a query:<query_id>:<basename> id even
// though the bulk feed (GET /artifacts) reported the same id as available —
// because the direct-catalog lookup (`artifacts` table) never receives a row
// for query:/dispatch: synthesized ids, and the fix (a live-source fallback
// in buildArtifactDetail / getArtifactOrLiveSourceCatalog) is what closes the
// gap. tests/unit/outputs-artifact-detail.test.ts already pins this at the
// route-handler level against an in-memory DB + in-process app — real
// regression coverage, but it can't catch a gap between that code path and
// what's actually running on :4100 (wrong build deployed, stale dist/,
// dead code path in production wiring, etc.). This file is the missing
// end-to-end layer: it seeds the exact repro condition directly into the
// LIVE manager's database (a completed `queries` row referencing a real file
// on disk, deliberately WITHOUT an `artifacts` catalog row — the natural
// state of every query-result artifact today, not a fabricated edge case)
// and asserts all four artifact-detail-family endpoints resolve it correctly
// over real HTTP against the live process, not an in-process app.
//
// Gated OFF by default (skipped unless RUN_LIVE_SMOKE=1) because it requires
// a live manager on MANAGER_URL and briefly writes one synthetic row into the
// live `queries` table — safe (WAL mode, unique test-tagged query_id, always
// cleaned up in `finally`), but not something a normal `vitest run` / CI pass
// should do implicitly.
//
//   RUN_LIVE_SMOKE=1 npx vitest run tests/smoke/query-artifact-detail-live.smoke.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";

const RUN_LIVE_SMOKE = process.env.RUN_LIVE_SMOKE === "1";
const MANAGER_URL = process.env.MANAGER_URL || "http://127.0.0.1:4100";
const DB_PATH = process.env.ID_AGENTS_DB_PATH || path.join(homedir(), ".id-agents", "id-agents.db");

async function isManagerLive(): Promise<boolean> {
  try {
    const res = await fetch(`${MANAGER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN_LIVE_SMOKE)("query:/dispatch: artifact-detail — live end-to-end smoke", () => {
  let adapter: SqliteAdapter;
  let tmp: string;
  let queryId: string;
  let basename: string;
  let filePath: string;
  let artifactId: string;
  let realTeamId: string;
  let realAgentId: string;
  let liveManagerUp = false;
  let setupComplete = false;
  const body = "# Live Smoke Artifact\n\nSynthetic incident smoke: seeded via a completed `queries` row with no `artifacts` catalog row, exactly the pre-fix repro condition.\n";

  beforeAll(async () => {
    liveManagerUp = await isManagerLive();
    if (!liveManagerUp) return;

    adapter = new SqliteAdapter(DB_PATH);

    // Discover a real, currently-live team_id/agent_id rather than assuming
    // "default" — the live DB's `queries.team_id` is not the literal string
    // "default" (unlike the in-memory unit-test fixture); it's whatever this
    // deployment's actual team UUID is. Reusing a real row's values avoids
    // writing a fabricated team/agent into production tables — this test
    // only ever inserts into `queries`, and deletes that one row afterward.
    const teamRow = await adapter.query<{ team_id: string }>(
      `SELECT team_id FROM queries ORDER BY created DESC LIMIT 1`,
    );
    const agentRow = await adapter.query<{ agent_id: string }>(
      `SELECT agent_id FROM queries WHERE agent_id IS NOT NULL ORDER BY created DESC LIMIT 1`,
    );
    if (!teamRow.rows[0] || !agentRow.rows[0]) {
      throw new Error("live smoke setup: could not discover a real team_id/agent_id from the queries table");
    }
    realTeamId = teamRow.rows[0].team_id;
    realAgentId = agentRow.rows[0].agent_id;

    tmp = mkdtempSync(path.join(tmpdir(), "query-artifact-detail-live-smoke-"));
    // extractOutputPaths() (src/dispatch-scheduler/read-model.ts) only
    // recognizes absolute paths containing an /output/ segment — matches the
    // real agent working-directory layout this fix targets.
    const outputDir = path.join(tmp, "output");
    mkdirSync(outputDir, { recursive: true });
    basename = `smoke-${Date.now()}.md`;
    filePath = path.join(outputDir, basename);
    writeFileSync(filePath, body);

    queryId = `smoketest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    artifactId = `query:${queryId}:${basename}`;

    const queries = new SqliteQueriesRepo(adapter);
    await queries.upsert(realTeamId, realAgentId, {
      query_id: queryId,
      status: "completed",
      completed: Date.now(),
      result: { result: `Wrote the smoke-test artifact to ${filePath}` },
      manager_dispatch_id: null,
    });
    setupComplete = true;
  });

  afterAll(async () => {
    if (!liveManagerUp || !setupComplete) return;
    // Deliberately unconditional cleanup — always remove the synthetic row
    // and temp file even if assertions above failed, so this test never
    // leaves residue in the live manager's database. Guarded on
    // setupComplete so a failure mid-beforeAll (e.g. DB open error) doesn't
    // throw a second, more confusing error out of a half-initialized cleanup.
    try {
      await adapter.query(`DELETE FROM queries WHERE query_id = ?`, [queryId]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      await adapter.close();
    }
  });

  it("live manager is reachable (precondition — real failure here means the smoke test itself can't run, not a fix regression)", () => {
    expect(liveManagerUp, `${MANAGER_URL}/health did not respond — is the manager running?`).toBe(true);
  });

  it.skipIf(!RUN_LIVE_SMOKE)("GET /artifacts/:id/detail resolves the seeded query: id without a catalog row", async () => {
    if (!liveManagerUp) return;
    const res = await fetch(`${MANAGER_URL}/artifacts/${encodeURIComponent(artifactId)}/detail`);
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.body?.kind, "pre-fix regression: body.kind is 'unavailable' when the live-source fallback is missing").toBe("markdown");
    expect(json.body?.text).toContain("Live Smoke Artifact");
  });

  it.skipIf(!RUN_LIVE_SMOKE)("GET /artifacts/:id/copy-text returns the real file body", async () => {
    if (!liveManagerUp) return;
    const res = await fetch(`${MANAGER_URL}/artifacts/${encodeURIComponent(artifactId)}/copy-text`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain("Live Smoke Artifact");
  });

  it.skipIf(!RUN_LIVE_SMOKE)("GET /artifacts/:id/download streams the real file with the right filename", async () => {
    if (!liveManagerUp) return;
    const res = await fetch(`${MANAGER_URL}/artifacts/${encodeURIComponent(artifactId)}/download`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(basename);
    expect(text).toContain("Live Smoke Artifact");
  });

  it.skipIf(!RUN_LIVE_SMOKE)("GET /artifacts/:id/review reports present availability, not unknown", async () => {
    if (!liveManagerUp) return;
    const res = await fetch(`${MANAGER_URL}/artifacts/${encodeURIComponent(artifactId)}/review`);
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.availability, "pre-fix regression: availability stays 'unknown' when the live-source fallback is missing").toBe("present");
    expect(json.catalog?.basename).toBe(basename);
  });
});

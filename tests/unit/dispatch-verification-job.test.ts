// Task 4 — DispatchVerificationJob integration test against the REAL
// SqliteDispatchReactor + a real DispatchVerificationStorage on an in-memory
// SqliteAdapter. Seeds dispatches through the normal lifecycle
// (enqueue → claim → markDoneWithResult) and asserts the projection rows the
// job writes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";
import { DispatchVerificationStorage } from "../../src/dispatch-verification/storage.js";
import { DispatchVerificationJob } from "../../src/dispatch-verification/job.js";
import type { ArtifactStat } from "../../src/dispatch-verification/types.js";

const NOW = "2026-06-15T20:00:00.000Z";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "coder-max",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "verif-job-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(now = NOW) {
  const reactor = new SqliteDispatchReactor({ adapter, teamId: "team-test", now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

async function enqueueDoneWithResult(
  client: DispatchDocClient,
  reactor: SqliteDispatchReactor,
  queryId: string,
  agentQueryId: string,
  result: Record<string, unknown>,
): Promise<string> {
  const enq = await client.enqueueDispatch({ ...base, query_id: queryId });
  if (!enq.ok) throw new Error("enqueue failed");
  const phid = enq.value.dispatch_phid;
  await client.claimForStart({ limit: 1 });
  await reactor.recordAgentStart(phid, agentQueryId);
  await reactor.markDoneWithResult(phid, result);
  return phid;
}

function statStub(map: Map<string, ArtifactStat>): (path: string) => ArtifactStat {
  return (path: string) =>
    map.get(path) ?? { exists: false, is_file: false, mtime_iso: null };
}

describe("DispatchVerificationJob.runOnce", () => {
  it("verifies a fresh-artifact done dispatch and flags a missing-artifact one", async () => {
    const { reactor, client } = harness();
    const storage = new DispatchVerificationStorage(adapter);
    await storage.migrate();

    const freshPath = "/abs/out-fresh.md";
    const missingPath = "/abs/out-missing.md";

    const freshPhid = await enqueueDoneWithResult(
      client,
      reactor,
      "q-fresh",
      "agent-fresh",
      { success: true, tl_dr: "all good", artifact_path: freshPath },
    );
    const missingPhid = await enqueueDoneWithResult(
      client,
      reactor,
      "q-missing",
      "agent-missing",
      { success: true, tl_dr: "where is it", artifact_path: missingPath },
    );

    // The artifact mtime sits inside the delivery window (completed_at = NOW).
    const stats = new Map<string, ArtifactStat>([
      [freshPath, { exists: true, is_file: true, mtime_iso: NOW }],
      [missingPath, { exists: false, is_file: false, mtime_iso: null }],
    ]);

    const job = new DispatchVerificationJob({
      teamId: "team-test",
      reactor,
      storage,
      statArtifact: statStub(stats),
      now: () => NOW,
    });

    const counts = await job.runOnce();
    expect(counts.checked).toBeGreaterThanOrEqual(2);
    expect(counts.upserted).toBe(counts.checked);
    expect(counts.verified).toBe(1);

    const fromIso = "2026-06-15T00:00:00.000Z";
    const toIso = "2026-06-16T00:00:00.000Z";
    const rows = await storage.readWindow("team-test", fromIso, toIso);
    const byId = new Map(rows.map((r) => [r.dispatch_id, r]));

    const fresh = byId.get(freshPhid);
    expect(fresh).toBeDefined();
    expect(fresh?.provider).toBe("anthropic");
    expect(fresh?.verified).toBe(true);
    expect(fresh?.failure_type).toBeNull();
    expect(fresh?.status).toBe("verified");

    const missing = byId.get(missingPhid);
    expect(missing).toBeDefined();
    expect(missing?.verified).toBe(false);
    expect(missing?.failure_type).toBe("artifact_missing");
  });
});

describe("DispatchVerificationJob.runOnceSafe", () => {
  it("swallows a reactor error and never throws", async () => {
    const storage = new DispatchVerificationStorage(adapter);
    await storage.migrate();

    const throwingReactor = {
      listForVerification: async () => {
        throw new Error("boom");
      },
    };

    const job = new DispatchVerificationJob({
      teamId: "team-test",
      reactor: throwingReactor,
      storage,
      statArtifact: statStub(new Map()),
      now: () => NOW,
    });

    await expect(job.runOnceSafe()).resolves.toBeUndefined();
  });
});

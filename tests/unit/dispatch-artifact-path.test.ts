// Spec 056 — first-class artifact_path on dispatch docs, sourced from
// /agent-done.result.artifact_path. Regression coverage against the
// in-memory SqliteDispatchReactor (same harness as the reactor parity test).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

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
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-artifact-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(
    `INSERT INTO teams (id, name) VALUES ('team-test', 'test')`,
  );
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(now = "2026-06-15T20:00:00.000Z") {
  const reactor = new SqliteDispatchReactor({
    adapter,
    teamId: "team-test",
    now: () => now,
  });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

async function enqueueInFlight(
  client: DispatchDocClient,
  reactor: SqliteDispatchReactor,
  queryId: string,
  agentQueryId: string,
): Promise<string> {
  const enq = await client.enqueueDispatch({ ...base, query_id: queryId });
  if (!enq.ok) throw new Error("enqueue failed");
  const phid = enq.value.dispatch_phid;
  await client.claimForStart({ limit: 1 });
  await reactor.recordAgentStart(phid, agentQueryId);
  return phid;
}

describe("Spec 056 — dispatch artifact_path", () => {
  it("artifact_path is null on enqueue", async () => {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    expect(enq.value.artifact_path).toBeNull();
  });

  it("markDoneWithResult persists a non-empty artifact_path", async () => {
    const { client, reactor } = harness();
    const phid = await enqueueInFlight(client, reactor, "q-art", "agent-q-art");
    await reactor.markDoneWithResult(phid, {
      artifact_path: "/abs/out.md",
      tl_dr: "x",
    });
    const reloaded = await reactor.getByPhid(phid);
    expect(reloaded?.artifact_path).toBe("/abs/out.md");
  });

  it("markDoneWithResult with no artifact_path leaves it null", async () => {
    const { client, reactor } = harness();
    const phid = await enqueueInFlight(client, reactor, "q-none", "agent-q-none");
    await reactor.markDoneWithResult(phid, { tl_dr: "no artifact" });
    const reloaded = await reactor.getByPhid(phid);
    expect(reloaded?.artifact_path).toBeNull();
  });

  it("markDoneWithResult with an empty artifact_path is rejected (null)", async () => {
    const { client, reactor } = harness();
    const phid = await enqueueInFlight(client, reactor, "q-empty", "agent-q-empty");
    await reactor.markDoneWithResult(phid, { artifact_path: "", tl_dr: "x" });
    const reloaded = await reactor.getByPhid(phid);
    expect(reloaded?.artifact_path).toBeNull();
  });
});

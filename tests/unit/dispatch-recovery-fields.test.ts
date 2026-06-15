// Recovery-state fields on dispatch docs — additive columns with safe
// defaults (recovery_status="none", recovery_attempts=0, recovery_reason=null,
// side_effect="none", allow_auto_retry=false). Regression coverage against the
// in-memory SqliteDispatchReactor (same harness as the artifact_path test).

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
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-recovery-"));
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

describe("dispatch recovery-state fields", () => {
  it("enqueued doc carries safe recovery defaults", async () => {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    expect(enq.value.recovery_status).toBe("none");
    expect(enq.value.recovery_attempts).toBe(0);
    expect(enq.value.recovery_reason).toBeNull();
    expect(enq.value.side_effect).toBe("none");
    expect(enq.value.allow_auto_retry).toBe(false);
  });

  it("recovery defaults round-trip through getByPhid", async () => {
    const { client, reactor } = harness();
    const enq = await client.enqueueDispatch(base);
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    const reloaded = await reactor.getByPhid(enq.value.dispatch_phid);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.recovery_status).toBe("none");
    expect(reloaded?.recovery_attempts).toBe(0);
    expect(reloaded?.recovery_reason).toBeNull();
    expect(reloaded?.side_effect).toBe("none");
    expect(reloaded?.allow_auto_retry).toBe(false);
  });
});

// T-RECON.2 (2026-06-22) — clear the NEEDS-YOU queue of dead failures.
// Covers: constrained-provider moot rule, supersede_link rule, the durable
// one-time sweep, and the reactor moot/supersede mutations end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import {
  deriveEffectiveState,
  deriveNeedsOperator,
  isConstrainedProviderDead,
  readDispatchById,
  sweepConstrainedProviderDead,
  type EffectiveStateRow,
} from "../../src/dispatch-scheduler/read-model.js";

const TEAM = "team";
let adapter: SqliteAdapter;
let tmpDir: string;
let handle: SchedulerHandle;

function failedRow(over: Partial<EffectiveStateRow>): EffectiveStateRow {
  return {
    status: "failed",
    recovery_status: "none",
    recovery_reason: null,
    failure_kind: "rate_limit_error",
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    not_before_at: null,
    started_at: null,
    updated_at: "2026-06-17T00:00:00Z",
    provider: "openai",
    supersede_link: null,
    ...over,
  };
}

describe("classification rules (pure)", () => {
  it("a retryable provider failure with NO constrained set still needs operator (unchanged)", () => {
    const row = failedRow({ provider: "anthropic", failure_kind: "rate_limit_error" });
    expect(deriveEffectiveState(row)).toBe("failed_needs_operator");
    expect(deriveNeedsOperator(row)).toBe(true);
  });

  it("a failure whose provider is constrained mootes out of NEEDS-YOU", () => {
    const row = failedRow({ provider: "openai" });
    const opts = { constrainedProviders: ["openai"] };
    expect(deriveEffectiveState(row, opts)).toBe("moot_or_superseded");
    expect(deriveNeedsOperator(row, Date.now(), opts)).toBe(false);
  });

  it("a mislabeled Codex usage-limit failure (provider anthropic) mootes when openai is constrained", () => {
    const row = failedRow({
      provider: "anthropic",
      failure_kind: "agent_error",
      failure_detail: "You've hit your usage limit. Visit https://chatgpt.com/codex",
    });
    expect(deriveEffectiveState(row, { constrainedProviders: ["openai"] })).toBe("moot_or_superseded");
  });

  it("a supersede_link mootes the failed dispatch (rule 7/4 v2)", () => {
    const row = failedRow({ provider: "anthropic", supersede_link: "phid:disp-new" });
    expect(deriveEffectiveState(row)).toBe("moot_or_superseded");
  });

  it("isConstrainedProviderDead matches provider OR codex signature", () => {
    expect(isConstrainedProviderDead({ provider: "openai", failure_detail: null }, new Set(["openai"]))).toBe(true);
    expect(isConstrainedProviderDead({ provider: "anthropic", failure_detail: "chatgpt.com/codex" }, new Set(["openai"]))).toBe(true);
    expect(isConstrainedProviderDead({ provider: "anthropic", failure_detail: "normal error" }, new Set(["openai"]))).toBe(false);
    expect(isConstrainedProviderDead({ provider: "openai", failure_detail: null }, new Set())).toBe(false);
  });
});

describe("durable sweep + reactor mutations (DB)", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon2-"));
    adapter = new SqliteAdapter(join(tmpDir, "t.db"));
    await migrateSqlite(adapter);
    await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [TEAM, TEAM]);
    handle = new SchedulerHandle({ adapter, teamId: TEAM, resolveTargetUrl: () => null });
  });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  async function makeFailed(detail: string, runtime?: string): Promise<string> {
    const { query_id } = await handle.enqueue({ to_agent: "cane", from_actor: "test", message: "m", runtime });
    const doc = await handle.reactor.getByQueryId(query_id);
    await handle.reactor.markFailed(doc!.dispatch_phid, { failure_kind: "agent_error", detail } as any);
    return doc!.dispatch_phid;
  }

  it("ACCEPTANCE: the sweep mootes the dead Codex usage-limit failure", async () => {
    const phid = await makeFailed("You've hit your usage limit. Visit https://chatgpt.com/codex");
    // Before: it needs the operator.
    const before = await readDispatchById(adapter, TEAM, phid);
    expect(before!.effective_state).toBe("failed_needs_operator");

    const swept = await sweepConstrainedProviderDead(adapter, TEAM, ["openai"]);
    expect(swept).toBe(1);

    const after = await readDispatchById(adapter, TEAM, phid);
    expect(after!.effective_state).toBe("moot_or_superseded");
    expect(after!.needs_operator).toBe(false);
  });

  it("the sweep leaves an unrelated anthropic failure alone", async () => {
    const phid = await makeFailed("genuine agent crash, no provider limit");
    const swept = await sweepConstrainedProviderDead(adapter, TEAM, ["openai"]);
    expect(swept).toBe(0);
    const after = await readDispatchById(adapter, TEAM, phid);
    expect(after!.effective_state).toBe("failed_needs_operator");
  });

  it("reactor.markMoot reclassifies a failure to moot_or_superseded", async () => {
    const phid = await makeFailed("some failure");
    await handle.reactor.markMoot(phid, "operator dismissed");
    const after = await readDispatchById(adapter, TEAM, phid);
    expect(after!.effective_state).toBe("moot_or_superseded");
  });

  it("reactor.markSuperseded sets supersede_link and mootes", async () => {
    const phid = await makeFailed("some failure");
    await handle.reactor.markSuperseded(phid, "phid:disp-replacement", "retry");
    const after = await readDispatchById(adapter, TEAM, phid);
    expect(after!.supersede_link).toBe("phid:disp-replacement");
    expect(after!.effective_state).toBe("moot_or_superseded");
  });
});

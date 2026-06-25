// Runtime Work-Share Slice 1 (§4) — runtime-mix readout tests.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  summarizeRuntimeMix,
  computeRuntimeMix,
  RUNTIME_MIX_DEFAULT_TARGETS,
  RUNTIME_MIX_SCHEMA_VERSION,
} from "../../src/usage-meter/runtime-mix.js";

describe("summarizeRuntimeMix (pure)", () => {
  it("counts provider/runtime shares and computes delta vs target", () => {
    const rows = [
      ...Array(45).fill({ provider: "anthropic", runtime: "claude-code-cli" }),
      ...Array(45).fill({ provider: "openai", runtime: "codex" }),
      ...Array(10).fill({ provider: "cursor", runtime: "cursor-cli" }),
    ];
    const mix = summarizeRuntimeMix(rows, RUNTIME_MIX_DEFAULT_TARGETS, 100, new Date("2026-06-25T00:00:00Z"));
    expect(mix.schema_version).toBe(RUNTIME_MIX_SCHEMA_VERSION);
    expect(mix.total_committed).toBe(100);
    const anth = mix.by_provider.find((p) => p.provider === "anthropic")!;
    expect(anth.count).toBe(45);
    expect(anth.share).toBeCloseTo(0.45, 5);
    expect(anth.target).toBe(0.45);
    expect(anth.delta).toBeCloseTo(0, 5); // exactly on target
    expect(mix.by_runtime.find((r) => r.runtime === "codex")!.count).toBe(45);
  });

  it("surfaces an under-target lane with a negative delta even at count 0", () => {
    const rows = Array(10).fill({ provider: "anthropic", runtime: "claude-code-cli" });
    const mix = summarizeRuntimeMix(rows, RUNTIME_MIX_DEFAULT_TARGETS, 100);
    const cursor = mix.by_provider.find((p) => p.provider === "cursor")!;
    expect(cursor.count).toBe(0); // no cursor dispatches yet
    expect(cursor.share).toBe(0);
    expect(cursor.delta).toBeCloseTo(-0.1, 5); // 0 - 0.10 target → under
    const anth = mix.by_provider.find((p) => p.provider === "anthropic")!;
    expect(anth.delta).toBeCloseTo(0.55, 5); // 1.0 share - 0.45 target → over
  });

  it("empty window → zero totals, all targeted lanes present at 0", () => {
    const mix = summarizeRuntimeMix([], RUNTIME_MIX_DEFAULT_TARGETS, 100);
    expect(mix.total_committed).toBe(0);
    expect(mix.by_provider.map((p) => p.provider).sort()).toEqual(["anthropic", "cursor", "openai"]);
    expect(mix.by_provider.every((p) => p.count === 0 && p.share === 0)).toBe(true);
  });
});

async function seedDispatch(
  adapter: SqliteAdapter,
  phid: string,
  provider: string,
  runtime: string,
  status: string,
  updatedAt: string,
): Promise<void> {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown,
        provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [phid, "team-1", "q-" + phid, "roger", "system", "dispatch", "s", "b", provider, runtime, status, updatedAt, updatedAt],
  );
}

describe("computeRuntimeMix (DB)", () => {
  it("counts only COMMITTED dispatches (excludes status=queued), within the window, matching a recomputed count", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    // 3 committed (done/in_flight) + 1 still queued (must be excluded)
    await seedDispatch(adapter, "d1", "anthropic", "claude-code-cli", "done", "2026-06-25T00:00:01Z");
    await seedDispatch(adapter, "d2", "openai", "codex", "done", "2026-06-25T00:00:02Z");
    await seedDispatch(adapter, "d3", "cursor", "cursor-cli", "in_flight", "2026-06-25T00:00:03Z");
    await seedDispatch(adapter, "d4", "anthropic", "claude-code-cli", "queued", "2026-06-25T00:00:04Z");

    const mix = await computeRuntimeMix(adapter, { windowN: 100, teamId: "team-1" });
    expect(mix.total_committed).toBe(3); // queued d4 excluded
    expect(mix.by_provider.find((p) => p.provider === "anthropic")!.count).toBe(1);
    expect(mix.by_provider.find((p) => p.provider === "openai")!.count).toBe(1);
    expect(mix.by_provider.find((p) => p.provider === "cursor")!.count).toBe(1);
  });

  it("respects the rolling window (newest-first LIMIT N)", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    // 5 committed, oldest=anthropic, newest 4 = openai
    await seedDispatch(adapter, "old", "anthropic", "claude-code-cli", "done", "2026-06-25T00:00:00Z");
    for (let i = 1; i <= 4; i++) {
      await seedDispatch(adapter, `n${i}`, "openai", "codex", "done", `2026-06-25T00:0${i}:00Z`);
    }
    const mix = await computeRuntimeMix(adapter, { windowN: 4, teamId: "team-1" });
    expect(mix.total_committed).toBe(4); // window caps at 4 newest
    expect(mix.by_provider.find((p) => p.provider === "openai")!.count).toBe(4);
    expect(mix.by_provider.find((p) => p.provider === "anthropic")!.count).toBe(0); // oldest dropped
  });
});

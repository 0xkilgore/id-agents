// Runtime Work-Share Slice 1 (§3) — runtime source-of-truth tests.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { deriveMetadataWithRuntime, reconcileAgentRuntime } from "../../src/db/agent-runtime-sot.js";

describe("deriveMetadataWithRuntime", () => {
  it("overrides metadata.runtime with the canonical column value", () => {
    const out = deriveMetadataWithRuntime({ alias: "cto", runtime: "codex" }, "claude-code-cli") as Record<string, unknown>;
    expect(out.runtime).toBe("claude-code-cli"); // column wins
    expect(out.alias).toBe("cto"); // other fields preserved
  });

  it("adds runtime when metadata lacks it", () => {
    const out = deriveMetadataWithRuntime({ alias: "regina" }, "codex") as Record<string, unknown>;
    expect(out.runtime).toBe("codex");
  });

  it("passes through null / non-object metadata unchanged", () => {
    expect(deriveMetadataWithRuntime(null, "codex")).toBeNull();
    expect(deriveMetadataWithRuntime(undefined, "codex")).toBeUndefined();
  });
});

async function seedTeamAndAgent(
  adapter: SqliteAdapter,
  id: string,
  runtime: string,
  metadata: string | null,
): Promise<void> {
  await adapter.query(`INSERT OR IGNORE INTO teams (id, name) VALUES ($1, $2)`, ["team-1", "default"]);
  await adapter.query(
    `INSERT INTO agents (id, team_id, name, type, model, status, created_at, runtime, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, "team-1", id, "claude", "m", "running", 1, runtime, metadata],
  );
}

async function metaRuntime(adapter: SqliteAdapter, id: string): Promise<string | undefined> {
  const { rows } = await adapter.query<{ metadata: string | null }>(`SELECT metadata FROM agents WHERE id = $1`, [id]);
  const m = rows[0]?.metadata ? JSON.parse(rows[0].metadata) : {};
  return m.runtime;
}

describe("reconcileAgentRuntime", () => {
  it("fixes persisted metadata.runtime to match the column, idempotently", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    // divergent (the CTO/Regina/Rams bug): column says claude-code-cli, metadata says codex
    await seedTeamAndAgent(adapter, "cto", "claude-code-cli", JSON.stringify({ alias: "cto", runtime: "codex" }));
    // already-consistent
    await seedTeamAndAgent(adapter, "rams", "codex", JSON.stringify({ alias: "rams", runtime: "codex" }));
    // null metadata
    await seedTeamAndAgent(adapter, "regina", "claude-code-cli", null);

    const r1 = await reconcileAgentRuntime(adapter, { teamId: "team-1" });
    expect(r1.scanned).toBe(3);
    expect(r1.reconciled).toBe(2); // cto (divergent) + regina (null metadata)
    expect(r1.already_consistent).toBe(1); // rams
    expect(await metaRuntime(adapter, "cto")).toBe("claude-code-cli");
    expect(await metaRuntime(adapter, "regina")).toBe("claude-code-cli");
    expect(await metaRuntime(adapter, "rams")).toBe("codex");

    // idempotent: a second run reconciles nothing
    const r2 = await reconcileAgentRuntime(adapter, { teamId: "team-1" });
    expect(r2.reconciled).toBe(0);
    expect(r2.already_consistent).toBe(3);
  });
});

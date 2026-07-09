// Runtime Work-Share Slice 1 (§3) — runtime source-of-truth tests.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  deriveMetadataWithRuntime,
  reconcileAgentRuntime,
  reconcileCatalogModelTruth,
  sanitizeCatalogRuntimeTruth,
} from "../../src/db/agent-runtime-sot.js";

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

  it("keeps live runtime/model authoritative and demotes stale catalog.model to desiredModel", () => {
    const out = deriveMetadataWithRuntime(
      { catalog: { model: "gpt-5-codex", status: "available" } },
      "claude-code-cli",
      "claude-sonnet-5",
    ) as Record<string, any>;
    expect(out.runtime).toBe("claude-code-cli");
    expect(out.catalog.model).toBeUndefined();
    expect(out.catalog.desiredModel).toBe("gpt-5-codex");
    expect(out.runtimeUsageTruth).toMatchObject({
      actualRuntime: "claude-code-cli",
      actualModel: "claude-sonnet-5",
      catalogDesiredModel: "gpt-5-codex",
      catalogModelStale: true,
      usageTelemetry: {
        provider: "anthropic",
        source: "claude_cli_external",
        authoritativeFields: ["runtime", "model"],
      },
    });
  });

  it("sanitizes agent-local catalog seeds before registration", () => {
    const catalog = sanitizeCatalogRuntimeTruth({ model: "gpt-5-codex", desiredModel: "claude-sonnet-5" }) as Record<string, unknown>;
    expect(catalog.model).toBeUndefined();
    expect(catalog.desiredModel).toBe("claude-sonnet-5");
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

describe("reconcileCatalogModelTruth", () => {
  it("moves persisted catalog.model without changing the live model column", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await seedTeamAndAgent(
      adapter,
      "cto",
      "claude-code-cli",
      JSON.stringify({ catalog: { status: "available", model: "gpt-5-codex" } }),
    );

    const r = await reconcileCatalogModelTruth(adapter, { teamId: "team-1" });
    expect(r).toMatchObject({ reconciled: 1, stale_desired_model: 1, scanned: 1 });

    const { rows } = await adapter.query<{ model: string; metadata: string }>(
      `SELECT model, metadata FROM agents WHERE id = $1`,
      ["cto"],
    );
    const metadata = JSON.parse(rows[0].metadata);
    expect(rows[0].model).toBe("m");
    expect(metadata.catalog.model).toBeUndefined();
    expect(metadata.catalog.desiredModel).toBe("gpt-5-codex");
  });
});

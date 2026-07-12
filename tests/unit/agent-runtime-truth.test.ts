import { describe, expect, it } from "vitest";

import {
  buildRuntimeUsageTruth,
  deriveMetadataWithRuntime,
  reconcileCatalogModelTruth,
  sanitizeCatalogRuntimeTruth,
} from "../../src/db/agent-runtime-sot.js";

describe("runtime/usage truth contract", () => {
  it("uses live runtime/model as authoritative and moves stale catalog.model to desiredModel", () => {
    const metadata = {
      runtime: "codex",
      catalog: {
        status: "available",
        model: "gpt-5-codex",
      },
    };

    const projected = deriveMetadataWithRuntime(metadata, "claude-code-cli", "claude-sonnet-5") as any;

    expect(projected.runtime).toBe("claude-code-cli");
    expect(projected.catalog.model).toBeUndefined();
    expect(projected.catalog.desiredModel).toBe("gpt-5-codex");
    expect(projected.runtimeUsageTruth).toEqual({
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

  it("reports Codex usage against the actual OpenAI runtime, not catalog desire", () => {
    const truth = buildRuntimeUsageTruth({
      runtime: "codex",
      model: "gpt-5.5",
      metadata: { catalog: { desiredModel: "claude-sonnet-5" } },
    });

    expect(truth.actualRuntime).toBe("codex");
    expect(truth.actualModel).toBe("gpt-5.5");
    expect(truth.catalogDesiredModel).toBe("claude-sonnet-5");
    expect(truth.catalogModelStale).toBe(true);
    expect(truth.usageTelemetry).toMatchObject({
      provider: "openai",
      source: "codex_cli",
    });
  });

  it("reconciles persisted legacy catalog.model without changing the live model column", async () => {
    const row = {
      id: "agent_1",
      runtime: "claude-code-cli",
      model: "claude-sonnet-5",
      metadata: JSON.stringify({ catalog: { status: "available", model: "gpt-5-codex" } }),
    };
    const adapter = {
      async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (sql.startsWith("SELECT id, runtime, model, metadata FROM agents")) {
          return { rows: [row as T] };
        }
        if (sql.startsWith("UPDATE agents SET metadata = $1 WHERE id = $2")) {
          row.metadata = params?.[0] as string;
          return { rows: [] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };

    const result = await reconcileCatalogModelTruth(adapter as any);

    expect(result).toMatchObject({ reconciled: 1, stale_desired_model: 1, scanned: 1 });
    const metadata = JSON.parse(row.metadata);
    expect(row.model).toBe("claude-sonnet-5");
    expect(metadata.catalog.model).toBeUndefined();
    expect(metadata.catalog.desiredModel).toBe("gpt-5-codex");
  });

  it("sanitizes agent-local catalog seeds so model cannot be served as live truth after restart", () => {
    const catalog = sanitizeCatalogRuntimeTruth({
      role: "orchestrator",
      model: "gpt-5-codex",
      desiredModel: "claude-sonnet-5",
    }) as any;

    expect(catalog.model).toBeUndefined();
    expect(catalog.desiredModel).toBe("claude-sonnet-5");
    expect(catalog.role).toBe("orchestrator");
  });
});

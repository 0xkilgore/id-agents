// Multi-LLM Slice B: runtime policy schema/read API.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { buildModelPolicyService } from "../../src/model-policy/policy.js";
import { mountRuntimePolicyRoutes } from "../../src/model-policy/runtime-policy-routes.js";
import {
  buildRuntimePolicyReadModel,
  readRuntimePolicies,
} from "../../src/model-policy/runtime-policy.js";

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "runtime-policy-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agent_runtime_policy migration + read model", () => {
  it("reads allowed lanes and ordered fallbacks for a logical agent", async () => {
    const now = 1_783_300_000;
    await adapter.query(
      `INSERT INTO agent_runtime_policy
        (team_id, logical_agent, allowed_lanes_json, fallback_order_json, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "team",
        "researcher",
        JSON.stringify(["openai", "cursor", "other"]),
        JSON.stringify([
          { runtime: "codex", model: "gpt-5.4", provider: "openai" },
          { runtime: "cursor-cli", model: "cursor-default", provider: "cursor" },
          { runtime: "openrouter", model: "z-ai/glm-5.2", provider: "other" },
        ]),
        1,
        "non-Claude fallback chain",
        now,
        now,
      ],
    );

    const policy = buildModelPolicyService(
      {
        constrained_providers: ["openai"],
        default: { primary: { runtime: "codex" }, fallback: [{ runtime: "claude-code-cli" }] },
        agents: {
          researcher: {
            primary: { runtime: "codex" },
            fallback: [{ runtime: "cursor-cli" }, { runtime: "openrouter" }],
          },
        },
      },
      "file",
    );

    const read = await readRuntimePolicies({ adapter, teamId: "team", modelPolicy: policy });
    expect(read.schema_version).toBe("runtime-policy-v1");
    expect(read.policies).toHaveLength(1);
    expect(read.policies[0]).toMatchObject({
      logical_agent: "researcher",
      allowed_lanes: ["openai", "cursor", "other"],
      enabled: true,
      note: "non-Claude fallback chain",
    });
    expect(read.policies[0]?.fallback_order.map((c) => c.runtime)).toEqual([
      "codex",
      "cursor-cli",
      "openrouter",
    ]);
    expect(read.effective_model_policy?.agents[0]?.allowed_lanes).toEqual(["openai", "cursor", "other"]);
  });

  it("normalizes postgres jsonb arrays without Claude-only assumptions", () => {
    const read = buildRuntimePolicyReadModel({
      teamId: "team",
      rows: [
        {
          team_id: "team",
          logical_agent: "*",
          allowed_lanes_json: ["cursor", "local", "bogus"] as any,
          fallback_order_json: [
            { runtime: "cursor-cli", model: "cursor-default", provider: "cursor" },
            { runtime: "other", model: "local-model", provider: "local" },
            { runtime: "not-a-runtime", model: "bad", provider: "anthropic" },
          ] as any,
          enabled: true,
          note: null,
          created_at: 10,
          updated_at: 11,
        },
      ],
    });

    expect(read.policies[0]?.allowed_lanes).toEqual(["cursor", "local"]);
    expect(read.policies[0]?.fallback_order).toEqual([
      { runtime: "cursor-cli", model: "cursor-default", provider: "cursor" },
      { runtime: "other", model: "local-model", provider: "local" },
    ]);
  });
});

describe("runtime policy route", () => {
  it("serves GET /runtime-policy scoped to the resolved team", async () => {
    await adapter.query(
      `INSERT INTO agent_runtime_policy
        (team_id, logical_agent, allowed_lanes_json, fallback_order_json, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "team",
        "*",
        JSON.stringify(["openai", "anthropic"]),
        JSON.stringify([
          { runtime: "codex", model: "gpt-5.4", provider: "openai" },
          { runtime: "claude-code-cli", model: "claude-sonnet-5", provider: "anthropic" },
        ]),
        1,
        null,
        1,
        2,
      ],
    );

    const app = express();
    mountRuntimePolicyRoutes(app, {
      adapter,
      getTeamId: async () => "team",
      getModelPolicy: () =>
        buildModelPolicyService(
          { default: { primary: { runtime: "codex" }, fallback: [{ runtime: "claude-code-cli" }] } },
          "file",
        ),
    });

    const res = await request(app).get("/runtime-policy");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("runtime-policy-v1");
    expect(res.body.policies[0].logical_agent).toBe("*");
    expect(res.body.policies[0].fallback_order.map((c: { runtime: string }) => c.runtime)).toEqual([
      "codex",
      "claude-code-cli",
    ]);
    expect(res.body.effective_model_policy.default.allowed_lanes).toEqual(["openai", "anthropic"]);
  });
});

function request(app: Express) {
  return {
    async get(path: string): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
            const text = await r.text();
            let body: any;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            server.close(() => resolve({ status: r.status, body }));
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });
    },
  };
}

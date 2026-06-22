// D1 / T-MODEL.1 — the model policy drives runtime/provider at enqueue
// (SchedulerHandle), applying Codex Light fallback off the live
// unavailable-providers signal. Explicit runtime pins always win.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import { buildModelPolicyService } from "../../src/model-policy/policy.js";
import type { Provider } from "../../src/dispatch-scheduler/types.js";
import type { RawModelPolicyConfig } from "../../src/model-policy/types.js";

const CODEX_LIGHT: RawModelPolicyConfig = {
  schema_version: 1,
  constrained_providers: ["openai"],
  default: { primary: { runtime: "codex" }, fallback: [{ runtime: "claude-code-cli" }] },
  agents: {},
};

let adapter: SqliteAdapter;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "model-policy-enqueue-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeHandle(unavailable: Provider[]): SchedulerHandle {
  const handle = new SchedulerHandle({
    adapter,
    teamId: "team",
    resolveTargetUrl: () => "http://localhost:1",
    modelPolicy: buildModelPolicyService(CODEX_LIGHT, "file"),
  });
  handle.setUnavailableProvidersSource(() => unavailable);
  return handle;
}

async function enqueuedRuntime(handle: SchedulerHandle, input: Parameters<SchedulerHandle["enqueue"]>[0]) {
  const { query_id } = await handle.enqueue(input);
  const r = await handle.client.getByQueryId(query_id);
  if (!r.ok) throw new Error("doc not found");
  return { runtime: r.value.runtime, provider: r.value.provider };
}

describe("model policy at enqueue", () => {
  it("no constrained lane → primary codex (openai)", async () => {
    const handle = makeHandle([]);
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("codex");
    expect(got.provider).toBe("openai");
  });

  it("openai constrained → Codex Light falls back to claude (anthropic)", async () => {
    const handle = makeHandle(["openai"]);
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("claude-code-cli");
    expect(got.provider).toBe("anthropic");
  });

  it("an explicit runtime pin always wins over the policy", async () => {
    const handle = makeHandle(["openai", "anthropic"]); // everything constrained
    const got = await enqueuedRuntime(handle, {
      to_agent: "roger", from_actor: "test", message: "hi", runtime: "cursor-cli",
    });
    expect(got.runtime).toBe("cursor-cli");
    expect(got.provider).toBe("cursor");
  });

  it("no policy configured → preserves the pre-D1 default (claude-code-cli)", async () => {
    const handle = new SchedulerHandle({ adapter, teamId: "team", resolveTargetUrl: () => "http://localhost:1" });
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("claude-code-cli");
  });
});

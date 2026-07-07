// D1 / T-MODEL.1 — the model policy drives runtime/provider at enqueue
// (SchedulerHandle), applying Codex Light fallback off the live
// unavailable-providers signal. Explicit runtime pins always win.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import {
  SchedulerHandle,
  providersConstrainedByRoutingHealth,
} from "../../src/dispatch-scheduler/manager-integration.js";
import { buildModelPolicyService } from "../../src/model-policy/policy.js";
import {
  computeRoutingHealth,
  runtimeLivenessFromFallbackHealth,
} from "../../src/routing-health/read-model.js";
import type { Provider } from "../../src/dispatch-scheduler/types.js";
import type { RawModelPolicyConfig } from "../../src/model-policy/types.js";

const CODEX_LIGHT: RawModelPolicyConfig = {
  schema_version: 1,
  constrained_providers: ["openai"],
  default: { primary: { runtime: "codex" }, fallback: [{ runtime: "claude-code-cli" }] },
  agents: {},
};

const CLAUDE_TO_CODEX: RawModelPolicyConfig = {
  schema_version: 1,
  constrained_providers: ["anthropic"],
  default: { primary: { runtime: "claude-code-cli" }, fallback: [{ runtime: "codex" }] },
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

function makeHandleWithAgents(
  unavailable: Provider[],
  policyConfig: RawModelPolicyConfig = CODEX_LIGHT,
): SchedulerHandle {
  const handle = new SchedulerHandle({
    adapter,
    teamId: "team",
    resolveTargetUrl: () => "http://localhost:1",
    agentsRepository: new SqliteAgentsRepo(adapter),
    modelPolicy: buildModelPolicyService(policyConfig, "file"),
  });
  handle.setUnavailableProvidersSource(() => unavailable);
  return handle;
}

async function insertAgentRuntime(name: string, runtime: string, endpoint = "http://localhost:1"): Promise<void> {
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, endpoint)
     VALUES ('team', ?, ?, 'persistent', ?, 24000, 'running', ?, ?, ?)`,
    [`agent-${name}`, name, runtime === "codex" ? "gpt-5.5" : "claude-opus", Date.now(), runtime, endpoint],
  );
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

  it("registered target agent runtime is the source of truth for stored provider/runtime metadata", async () => {
    await insertAgentRuntime("eames", "claude-code-cli");
    const handle = makeHandleWithAgents([]);
    const got = await enqueuedRuntime(handle, {
      to_agent: "eames",
      from_actor: "test",
      message: "hi",
      provider: "openai",
      runtime: "codex",
    });

    expect(got.runtime).toBe("claude-code-cli");
    expect(got.provider).toBe("anthropic");
  });

  it("Claude-constrained project agent dispatches to a live Codex executor lane", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-codex" }), { status: 200 }) as unknown as Response,
    );
    await insertAgentRuntime("finances", "claude-code-cli", "http://localhost:4101");
    await insertAgentRuntime("roger", "codex", "http://localhost:4102");

    const handle = makeHandleWithAgents(["anthropic"], CLAUDE_TO_CODEX);
    const got = await enqueuedRuntime(handle, {
      to_agent: "finances",
      from_actor: "test",
      message: "recover through Codex",
    });
    expect(got.runtime).toBe("codex");
    expect(got.provider).toBe("openai");

    await handle.tick();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:4102/talk");
    fetchSpy.mockRestore();
  });

  it("no policy configured → preserves the pre-D1 default (claude-code-cli)", async () => {
    const handle = new SchedulerHandle({ adapter, teamId: "team", resolveTargetUrl: () => "http://localhost:1" });
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("claude-code-cli");
  });
});

// RD-014 (Fable critique 2026-07-01; CHRIS 2026-07-02) — routing admission now
// consults runtime/lane health. This is the acceptance path that DID NOT EXIST
// before: the stranded gate (cto/codex-runtime-health-gate, d9e7406) health-gated
// the codex lane at CLAIM time via a bespoke exclusion list; here it is folded
// into ENQUEUE through computeRoutingHealth's read-model, giving that read-model
// its first production consumer. A stalled codex lane, with NO pinned runtime,
// must resolve to the FALLBACK lane.
describe("RD-014: routing-health gates the codex lane at enqueue", () => {
  // Build a routing-health read-model where the codex fallback runtime is
  // UNAVAILABLE (e.g. a cert-revoked binary). Runs the real read-model so the
  // production consumer path (computeRoutingHealth → summary.runtimes_down →
  // constrained providers) is exercised end-to-end, not mocked.
  function codexStalledHealth() {
    return computeRoutingHealth({
      team_id: "team",
      now: new Date().toISOString(),
      pools: [],
      builders: [],
      dispatches: [],
      runtimes: [
        { name: "claude", role: "primary", live: true, detail: "manager running" },
        runtimeLivenessFromFallbackHealth("codex", {
          status: "unavailable",
          reason: "cert_revoked",
        }),
      ],
    });
  }

  function makeHandleWithHealth(): SchedulerHandle {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
      modelPolicy: buildModelPolicyService(CODEX_LIGHT, "file"),
    });
    // No usage constraint at all — the ONLY signal is runtime liveness.
    handle.setUnavailableProvidersSource(() => []);
    handle.setRoutingHealthSource(() => codexStalledHealth());
    return handle;
  }

  it("the read-model reports the codex/openai lane as constrained", () => {
    const model = codexStalledHealth();
    expect(model.summary.runtimes_down).toContain("codex");
    // codex runtime → openai provider lane, the way model-policy names it.
    expect(providersConstrainedByRoutingHealth(model)).toContain("openai");
  });

  it("codex lane stalled + no pinned runtime → enqueue resolves to the FALLBACK lane", async () => {
    const handle = makeHandleWithHealth();
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    // Primary (codex/openai) is down per routing-health → Codex Light falls back
    // to claude (anthropic). Before RD-014 this resolved to codex (no liveness
    // signal fed the admission path); the absence WAS the finding.
    expect(got.runtime).toBe("claude-code-cli");
    expect(got.provider).toBe("anthropic");
  });

  it("codex lane HEALTHY (no health source wired) → primary codex, unchanged behavior", async () => {
    const handle = makeHandle([]); // no routing-health source → pre-RD-014 path
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("codex");
    expect(got.provider).toBe("openai");
  });

  it("a failing routing-health source fails open (does not block enqueue)", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
      modelPolicy: buildModelPolicyService(CODEX_LIGHT, "file"),
    });
    handle.setUnavailableProvidersSource(() => []);
    handle.setRoutingHealthSource(() => {
      throw new Error("routing-health probe blew up");
    });
    // Fail-open: with no usable health signal, enqueue degrades to primary codex
    // rather than blocking or crashing.
    const got = await enqueuedRuntime(handle, { to_agent: "roger", from_actor: "test", message: "hi" });
    expect(got.runtime).toBe("codex");
    expect(got.provider).toBe("openai");
  });
});

// Agent detail v2 (T-CKPT.agent-v2) — assembleAgentDetail against a real
// in-memory DB. Proves the SQL (placeholders, column names, the date() series)
// runs on the actual schema and that attribution filters by the right agent.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { registerArtifact } from "../../src/outputs/storage.js";
import { assembleAgentDetail, normalizeAttributionNames } from "../../src/agent-detail/assemble.js";
import { DispatchVerificationStorage } from "../../src/dispatch-verification/storage.js";
import type { DispatchVerification } from "../../src/dispatch-verification/types.js";

let adapter: SqliteAdapter;
const TID = "team-1";
const NAME = "roger";
const AID = "agent-roger-id";

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  // Seed tasks/dispatches without standing up full agents/teams rows — the
  // read path (assembleAgentDetail) is a SELECT and doesn't depend on the FKs.
  await adapter.query("PRAGMA foreign_keys = OFF");
});

async function task(id: string, owner: string, status: string) {
  const now = Math.floor(Date.now() / 1000);
  await adapter.query(
    `INSERT INTO tasks (id, name, team_id, title, status, owner, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, id, TID, `t ${id}`, status, owner, now, now],
  );
}

async function usage(eventId: string, agentId: string, weighted: number, ts: number) {
  await adapter.query(
    `INSERT INTO agent_usage_event
       (event_id, agent_id, ts, raw_tokens, weighted_tokens, source, confidence, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventId, agentId, ts, weighted, weighted, "transcript", "high", eventId],
  );
}

async function dispatch(phid: string, toAgent: string, status: string) {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [phid, TID, `q_${phid}`, toAgent, "co", "manager", "s", "b", "anthropic", "claude-code-cli", status, now, now],
  );
}

function assemble() {
  return assembleAgentDetail(adapter, {
    teamId: TID,
    name: NAME,
    agentId: AID,
    runtime: "claude-code-cli",
    workingDirectory: null, // skip filesystem skills/scripts in this DB-focused test
    consecutiveFailures: 2,
    lastError: "last boom",
    nowIso: new Date().toISOString(),
  });
}

function makeVerification(overrides: Partial<DispatchVerification> = {}): DispatchVerification {
  return {
    schema_version: "dispatch-verification.v1",
    team_id: TID,
    dispatch_id: "phid:disp-test",
    query_id: "query_test",
    agent_name: NAME,
    provider: "anthropic",
    status: "verified",
    verified: true,
    failure_type: null,
    failure_detail: null,
    artifact_path: `/out/${NAME}.md`,
    artifact_exists: true,
    artifact_mtime: "2026-06-28T12:00:00.000Z",
    delivery_window_start: null,
    delivery_window_end: null,
    promotion_required: false,
    promotion_verified: null,
    promotion_failure_detail: null,
    dispatch_status: "done",
    dispatch_created_at: "2026-06-28T11:00:00.000Z",
    dispatch_started_at: "2026-06-28T11:01:00.000Z",
    dispatch_completed_at: "2026-06-28T12:00:00.000Z",
    result_success: true,
    tl_dr: "landed the thing",
    kind: "report",
    checked_at: "2026-06-28T12:01:00.000Z",
    source_metadata: { source: "dispatch_scheduler_queue", result_source: "artifact_path" },
    ...overrides,
  };
}

describe("assembleAgentDetail (real schema)", () => {
  it("counts only the agent's own tasks, by status", async () => {
    await task("t1", AID, "done");
    await task("t2", AID, "done");
    await task("t3", AID, "doing");
    await task("t4", "someone-else", "done"); // excluded
    const d = await assemble();
    expect(d.charts.tasks.total).toBe(3);
    expect(d.charts.tasks.by_status).toEqual({ done: 2, doing: 1 });
  });

  it("sums today's tokens for the agent (by name or id) and builds a series", async () => {
    const now = Date.now();
    await usage("e1", NAME, 100, now);
    await usage("e2", AID, 250, now); // attributed by id too
    await usage("e3", "other", 999, now); // excluded
    const d = await assemble();
    expect(d.charts.tokens.today).toBe(350);
    expect(d.charts.tokens.series.reduce((s, p) => s + p.weighted, 0)).toBe(350);
  });

  it("counts failed/bounced dispatches to the agent", async () => {
    await dispatch("d1", NAME, "bounced");
    await dispatch("d2", NAME, "failed");
    await dispatch("d3", NAME, "done"); // excluded
    await dispatch("d4", "other", "failed"); // excluded
    const d = await assemble();
    expect(d.charts.failures.failed_dispatches).toBe(2);
    expect(d.charts.failures.consecutive).toBe(2);
    expect(d.charts.failures.last_error).toBe("last boom");
  });

  it("returns the agent's recent outputs newest-first, capped at 20", async () => {
    for (let i = 0; i < 22; i++) {
      await registerArtifact(
        adapter,
        {
          abs_path: `/out/${NAME}-${i}.md`,
          basename: `${NAME}-${i}.md`,
          agent: NAME,
          tag: "trinity",
          title: `out ${i}`,
          produced_at: new Date(Date.now() - i * 60_000).toISOString(),
        },
        new Date().toISOString(),
      );
    }
    await registerArtifact(
      adapter,
      { abs_path: "/out/other.md", basename: "other.md", agent: "other", produced_at: new Date().toISOString() },
      new Date().toISOString(),
    );
    const d = await assemble();
    expect(d.recent_outputs).toHaveLength(20);
    expect(d.recent_outputs.every((o) => o.basename.startsWith(NAME))).toBe(true);
    for (let i = 1; i < d.recent_outputs.length; i++) {
      expect(d.recent_outputs[i - 1].produced_at >= d.recent_outputs[i].produced_at).toBe(true);
    }
  });

  it("maps alias/detail name/project basename to recent artifacts and verified dispatches", async () => {
    const storage = new DispatchVerificationStorage(adapter);
    await storage.migrate();

    await registerArtifact(
      adapter,
      {
        abs_path: "/out/agent-platform-roadmap.md",
        basename: "agent-platform-roadmap.md",
        agent: "agent-platform",
        tag: "kapelle",
        title: "Roadmap",
        produced_at: "2026-06-28T12:00:00.000Z",
      },
      "2026-06-28T12:01:00.000Z",
    );
    await storage.upsertMany([
      makeVerification({
        dispatch_id: "phid:disp-maestra",
        agent_name: "agent-platform",
        artifact_path: "/out/agent-platform-roadmap.md",
        tl_dr: "roadmap landed",
      }),
      makeVerification({
        dispatch_id: "phid:disp-other",
        agent_name: "other",
        artifact_path: "/out/other.md",
      }),
    ]);

    const d = await assembleAgentDetail(adapter, {
      teamId: TID,
      name: "maestra",
      attributionNames: ["maestra"],
      agentId: AID,
      runtime: "claude-code-cli",
      workingDirectory: "/Users/kilgore/Dropbox/Code/agent-platform",
      consecutiveFailures: 0,
      lastError: null,
      nowIso: "2026-06-28T13:00:00.000Z",
    });

    expect(d.name).toBe("maestra");
    expect(d.recent_outputs.map((o) => o.basename)).toEqual(["agent-platform-roadmap.md"]);
    expect(d.recent_dispatches.map((x) => x.dispatch_id)).toEqual(["phid:disp-maestra"]);
    expect(d.verified_landings.map((x) => x.artifact_path)).toEqual(["/out/agent-platform-roadmap.md"]);
    expect(d.recent_dispatches[0].attributed_agent).toBe("agent-platform");
  });

  it("degrades to a zeroed dossier when nothing is seeded (never throws)", async () => {
    const d = await assemble();
    expect(d.charts.tasks.total).toBe(0);
    expect(d.charts.tokens.today).toBe(0);
    expect(d.charts.failures.failed_dispatches).toBe(0);
    expect(d.recent_outputs).toEqual([]);
    expect(d.skills).toEqual([]);
    expect(d.scripts).toEqual([]);
    expect(d.name).toBe(NAME);
  });
});

describe("normalizeAttributionNames", () => {
  it("dedupes case-insensitively and drops empty values", () => {
    expect(normalizeAttributionNames(["maestra", "Maestra", "", null, "agent-platform"])).toEqual([
      "maestra",
      "agent-platform",
    ]);
  });
});

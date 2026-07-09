// T-ORCH P0 — the factory's readInFlight must measure the DAEMON's OWN
// in-flight lane, not the fleet-wide reactor count. A busy fleet (manual /
// other-agent dispatches) must NOT starve the daemon to zero.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { insertBacklogItem } from "../../src/continuous-orchestration/storage.js";
import { createContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/factory.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

// A fake scheduler whose reactor reports a BUSY fleet (many in-flight docs)
// while the daemon's own in_flight backlog is empty.
function busyFleetScheduler(fleetInFlight: number) {
  const fired: Array<{ to_agent: string }> = [];
  return {
    fired,
    scheduler: {
      enqueue: async (input: { to_agent: string }) => {
        fired.push({ to_agent: input.to_agent });
        return { dispatch_phid: `phid:disp-${fired.length}`, query_id: `q_${fired.length}` };
      },
      reactor: {
        listInFlight: async () => Array.from({ length: fleetInFlight }, (_, i) => ({ id: i })),
      },
    },
  };
}

const usageService = {
  buildReport: async () => ({}) as never,
  buildDaemonReport: async () => ({
    gate: { hard_paused: false, enforcement: "enforce" as const },
    daily: { percent_consumed: null, combined_weighted_tokens: 0, budget: 1_000_000 },
    weekly: { percent_consumed: null, combined_weighted_tokens: 0, budget: 1_000_000 },
  }),
};

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = await freshDb();
});

async function seedRunningAgent(name: string) {
  await adapter.query(
    `INSERT OR IGNORE INTO teams (id, name) VALUES ($1, $2)`,
    ["team-uuid-9999", "default"],
  );
  await adapter.query(
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`agent_${name}`, "team-uuid-9999", name, "claude", "claude-sonnet-4-6", 0, "running", Date.now(), "claude-code-cli"],
  );
}

describe("factory readInFlight — daemon-own lane, not fleet-wide", () => {
  it("fires from READY even when the fleet has >= max_in_flight in-flight dispatches", async () => {
    await seedRunningAgent("roger");
    await insertBacklogItem(adapter, {
      title: "ship it",
      to_agent: "roger",
      dispatch_body: "do the thing",
      readiness_state: "ready",
      risk_class: "build",
    });

    const { fired, scheduler } = busyFleetScheduler(20); // fleet saturated
    const { daemon } = createContinuousOrchestrationDaemon({
      adapter,
      scheduler: scheduler as never,
      usageService: usageService as never,
      // enabled + live + a real lane budget; the fleet's 20 in-flight must NOT
      // count against the daemon's own max_in_flight.
      config: { ...defaultConfig(), enabled: true, dry_run: false, max_in_flight: 4 },
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();

    // Pre-fix: count=20 (fleet) >= max_in_flight=4 -> slotsFree=0 -> 0 fired.
    // Post-fix: daemon-own in_flight=0 -> fires the ready item.
    expect(r.halted).toBeNull();
    expect(fired).toHaveLength(1);
    expect(r.admitted).toHaveLength(1);
  });

  it("enqueues successfully when the scheduler handle is bound to a team UUID, not the CO storage 'default' name", async () => {
    await seedRunningAgent("roger");
    // P0 regression: CO storage is keyed by the team NAME ("default"); the
    // dispatch SchedulerHandle is bound to that team's UUID. The factory used to
    // copy the CO storage teamId into the enqueue input's team_id, so the real
    // handle's guard (`input.team_id ?? this.teamId; if (team_id !== this.teamId) throw`)
    // rejected every enqueue with "team_id mismatch" — consecutive_zero_ticks
    // climbed, last_dispatch_at stayed null, backlog never drained. The fix: the
    // factory must NOT pin team_id; the handle owns it. This fake MIRRORS the real
    // guard (the prior fake was too permissive, which is why this escaped tests).
    const BOUND_TEAM_UUID = "36ee78b1-d817-4a29-b631-c93945404c7b";
    await insertBacklogItem(adapter, {
      title: "ship it",
      to_agent: "roger",
      dispatch_body: "do the thing",
      readiness_state: "ready",
      risk_class: "build",
    });

    const fired: Array<{ team_id?: string }> = [];
    const guardingScheduler = {
      enqueue: async (input: { team_id?: string; to_agent: string }) => {
        const teamId = input.team_id ?? BOUND_TEAM_UUID; // == SchedulerHandle: input.team_id ?? this.teamId
        if (teamId !== BOUND_TEAM_UUID) {
          throw new Error(
            `enqueue: team_id mismatch (handle is bound to ${BOUND_TEAM_UUID}, got ${teamId})`,
          );
        }
        fired.push({ team_id: input.team_id });
        return { dispatch_phid: `phid:disp-${fired.length}`, query_id: `q_${fired.length}` };
      },
      reactor: { listInFlight: async () => [] },
    };

    const { daemon } = createContinuousOrchestrationDaemon({
      adapter,
      scheduler: guardingScheduler as never,
      usageService: usageService as never,
      // teamId omitted -> CO storage uses "default" (matches the inserted backlog).
      config: { ...defaultConfig(), enabled: true, dry_run: false, max_in_flight: 4 },
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();

    // Pre-fix: enqueue threw team_id mismatch -> 0 admitted/fired.
    // Post-fix: input omits team_id -> handle applies its own UUID -> fires.
    expect(r.admitted).toHaveLength(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.team_id).toBeUndefined(); // factory no longer pins team_id
  });

  it("DOES cap on the daemon's own in-flight backlog items", async () => {
    await seedRunningAgent("roger");
    // 3 ready + 2 already in_flight (daemon-owned); max_in_flight 4 -> 2 slots.
    for (let i = 0; i < 3; i++) {
      await insertBacklogItem(adapter, {
        title: `ready-${i}`,
        to_agent: "roger",
        dispatch_body: "x",
        readiness_state: "ready",
        risk_class: "build",
        write_scope: [`s${i}`],
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertBacklogItem(adapter, {
        title: `busy-${i}`,
        to_agent: "roger",
        dispatch_body: "x",
        readiness_state: "in_flight",
        risk_class: "build",
        write_scope: [`busy${i}`],
      });
    }

    const { fired, scheduler } = busyFleetScheduler(0);
    const { daemon } = createContinuousOrchestrationDaemon({
      adapter,
      scheduler: scheduler as never,
      usageService: usageService as never,
      config: { ...defaultConfig(), enabled: true, dry_run: false, max_in_flight: 4 },
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();
    // 4 cap - 2 own-in-flight = 2 free slots -> fire 2 of the 3 ready.
    expect(fired).toHaveLength(2);
    expect(r.admitted).toHaveLength(2);
  });
});

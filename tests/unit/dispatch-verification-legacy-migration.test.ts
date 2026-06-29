// Regression (dispatch a43d02dd): the dispatch_verifications migration created an
// index on `provider` BEFORE adding the `provider` column. Fresh tables were fine,
// but an OLD live table (predating `provider`) failed startup with
// "no such column: provider" (2026-06-29). These tests boot migrate() against a
// LEGACY schema without `provider` and assert startup + the provider index succeed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { DispatchVerificationStorage } from "../../src/dispatch-verification/storage.js";

let adapter: SqliteAdapter;

beforeEach(() => {
  adapter = new SqliteAdapter(":memory:");
});

afterEach(async () => {
  await adapter.close();
});

// The dispatch_verifications table as it existed BEFORE the `provider` column +
// its index were introduced (note: no `provider` column, no provider index).
const LEGACY_DDL = `
  CREATE TABLE dispatch_verifications (
    team_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, query_id TEXT,
    agent_name TEXT NOT NULL, status TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0, failure_type TEXT, failure_detail TEXT,
    artifact_path TEXT, artifact_exists INTEGER, artifact_mtime TEXT,
    delivery_window_start TEXT, delivery_window_end TEXT,
    promotion_required INTEGER NOT NULL DEFAULT 0, promotion_verified INTEGER,
    promotion_failure_detail TEXT, dispatch_status TEXT NOT NULL,
    dispatch_created_at TEXT NOT NULL, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    result_success INTEGER, tl_dr TEXT, kind TEXT NOT NULL DEFAULT 'other',
    checked_at TEXT NOT NULL, source_metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (team_id, dispatch_id)
  );
  CREATE INDEX IF NOT EXISTS dispatch_verifications_team_agent_time_idx ON dispatch_verifications(team_id, agent_name, dispatch_completed_at DESC, dispatch_id);
`;

async function columnNames(): Promise<string[]> {
  const res = await adapter.query<{ name: string }>(`SELECT name FROM pragma_table_info('dispatch_verifications')`);
  return res.rows.map((r) => r.name);
}

async function indexNames(): Promise<string[]> {
  const res = await adapter.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_verifications'`,
  );
  return res.rows.map((r) => r.name);
}

describe("DispatchVerificationStorage.migrate() — legacy schema (no provider column)", () => {
  it("migrates an OLD table without `provider` without throwing, adding the column then the index", async () => {
    adapter.exec(LEGACY_DDL);
    expect(await columnNames()).not.toContain("provider");

    const storage = new DispatchVerificationStorage(adapter);
    await expect(storage.migrate()).resolves.toBeUndefined();

    expect(await columnNames()).toContain("provider");
    expect(await indexNames()).toContain("dispatch_verifications_team_provider_time_idx");
  });

  it("backfills existing legacy rows with provider='other'", async () => {
    adapter.exec(LEGACY_DDL);
    adapter.exec(`
      INSERT INTO dispatch_verifications
        (team_id, dispatch_id, agent_name, status, dispatch_status, dispatch_created_at, checked_at)
      VALUES
        ('team-test', 'phid:disp-legacy', 'coder-max', 'verified', 'done',
         '2026-06-29T11:50:00.000Z', '2026-06-29T12:10:00.000Z');
    `);

    await new DispatchVerificationStorage(adapter).migrate();

    const res = await adapter.query<{ provider: string }>(
      `SELECT provider FROM dispatch_verifications WHERE dispatch_id = 'phid:disp-legacy'`,
    );
    expect(res.rows[0]?.provider).toBe("other");
  });

  it("is idempotent on both fresh and legacy schemas (re-running migrate never throws)", async () => {
    // fresh
    const fresh = new DispatchVerificationStorage(adapter);
    await fresh.migrate();
    await expect(fresh.migrate()).resolves.toBeUndefined();
    expect(await indexNames()).toContain("dispatch_verifications_team_provider_time_idx");

    // legacy, re-run after upgrade
    const legacyAdapter = new SqliteAdapter(":memory:");
    legacyAdapter.exec(LEGACY_DDL);
    const legacy = new DispatchVerificationStorage(legacyAdapter);
    await legacy.migrate();
    await legacy.migrate();
    await legacyAdapter.close();
  });
});

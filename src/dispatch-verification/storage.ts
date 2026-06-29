// W2-1 DispatchVerificationStorage — durable projection persistence.
//
// The manager writes verified-landing rows into this projection on a 5-minute
// job; the Agents endpoints read it and never stat files on request. See
// docs/superpowers/plans/2026-06-15-dispatch-verification.md.

import type { SqliteAdapter } from "../db/sqlite-adapter.js";
import type {
  DispatchVerification,
  DispatchVerificationStatus,
  DispatchVerificationFailureType,
  DispatchArtifactKind,
} from "./types.js";
import type { Provider } from "../dispatch-scheduler/types.js";

/** Shape of a raw row read back from the dispatch_verifications table. */
interface DispatchVerificationDbRow {
  team_id: string;
  dispatch_id: string;
  query_id: string | null;
  agent_name: string;
  provider: string | null;
  status: string;
  verified: number;
  failure_type: string | null;
  failure_detail: string | null;
  artifact_path: string | null;
  artifact_exists: number | null;
  artifact_mtime: string | null;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  promotion_required: number;
  promotion_verified: number | null;
  promotion_failure_detail: string | null;
  dispatch_status: string;
  dispatch_created_at: string;
  dispatch_started_at: string | null;
  dispatch_completed_at: string | null;
  result_success: number | null;
  tl_dr: string | null;
  kind: string;
  checked_at: string;
  source_metadata_json: string;
}

function toBool(v: number | null): boolean | null {
  if (v === null || v === undefined) return null;
  return v !== 0;
}

function fromBool(v: boolean): number {
  return v ? 1 : 0;
}

function fromNullableBool(v: boolean | null): number | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

export class DispatchVerificationStorage {
  constructor(private readonly adapter: SqliteAdapter) {}

  async migrate(): Promise<void> {
    // Migration order matters on LEGACY tables (dispatch a43d02dd): an index that
    // references `provider` must not be created before the column exists, or an
    // older `dispatch_verifications` table (predating `provider`) throws
    // "no such column: provider" at startup (live failure 2026-06-29).
    // Order: (1) table if missing -> (2) add missing columns -> (3) indexes.

    // (1) Table (fresh installs get `provider` here; legacy tables won't have it).
    this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_verifications (
        team_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, query_id TEXT,
        agent_name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'other', status TEXT NOT NULL,
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
    `);

    // (2) Add missing columns BEFORE any index references them. ADD COLUMN with
    //     NOT NULL DEFAULT backfills existing rows, so no separate backfill step.
    await this.addColumnIfMissing("dispatch_verifications", "provider", "TEXT NOT NULL DEFAULT 'other'");

    // (3) Indexes (the provider index is safe now the column is guaranteed).
    this.adapter.exec(`
      CREATE INDEX IF NOT EXISTS dispatch_verifications_team_agent_time_idx ON dispatch_verifications(team_id, agent_name, dispatch_completed_at DESC, dispatch_id);
      CREATE INDEX IF NOT EXISTS dispatch_verifications_team_time_idx ON dispatch_verifications(team_id, dispatch_completed_at DESC, dispatch_id);
      CREATE INDEX IF NOT EXISTS dispatch_verifications_team_provider_time_idx ON dispatch_verifications(team_id, provider, dispatch_completed_at DESC, dispatch_id);
      CREATE INDEX IF NOT EXISTS dispatch_verifications_team_failure_idx ON dispatch_verifications(team_id, failure_type, dispatch_completed_at DESC) WHERE failure_type IS NOT NULL;
    `);
  }

  async upsertMany(rows: DispatchVerification[]): Promise<void> {
    if (rows.length === 0) return;
    const sql = `
      INSERT INTO dispatch_verifications (
        team_id, dispatch_id, query_id, agent_name, provider,
        status,
        verified, failure_type, failure_detail,
        artifact_path, artifact_exists, artifact_mtime,
        delivery_window_start, delivery_window_end,
        promotion_required, promotion_verified, promotion_failure_detail,
        dispatch_status, dispatch_created_at, dispatch_started_at, dispatch_completed_at,
        result_success, tl_dr, kind, checked_at, source_metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14,
        $15, $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24, $25, $26
      )
      ON CONFLICT(team_id, dispatch_id) DO UPDATE SET
        query_id = excluded.query_id,
        agent_name = excluded.agent_name,
        provider = excluded.provider,
        status = excluded.status,
        verified = excluded.verified,
        failure_type = excluded.failure_type,
        failure_detail = excluded.failure_detail,
        artifact_path = excluded.artifact_path,
        artifact_exists = excluded.artifact_exists,
        artifact_mtime = excluded.artifact_mtime,
        delivery_window_start = excluded.delivery_window_start,
        delivery_window_end = excluded.delivery_window_end,
        promotion_required = excluded.promotion_required,
        promotion_verified = excluded.promotion_verified,
        promotion_failure_detail = excluded.promotion_failure_detail,
        dispatch_status = excluded.dispatch_status,
        dispatch_created_at = excluded.dispatch_created_at,
        dispatch_started_at = excluded.dispatch_started_at,
        dispatch_completed_at = excluded.dispatch_completed_at,
        result_success = excluded.result_success,
        tl_dr = excluded.tl_dr,
        kind = excluded.kind,
        checked_at = excluded.checked_at,
        source_metadata_json = excluded.source_metadata_json
    `;

    this.adapter.exec("BEGIN");
    try {
      for (const row of rows) {
        await this.adapter.query(sql, this.verificationToParams(row));
      }
      this.adapter.exec("COMMIT");
    } catch (err) {
      this.adapter.exec("ROLLBACK");
      throw err;
    }
  }

  async readWindow(
    teamId: string,
    fromIso: string,
    toIso: string,
  ): Promise<DispatchVerification[]> {
    const res = await this.adapter.query<DispatchVerificationDbRow>(
      `SELECT * FROM dispatch_verifications
        WHERE team_id = $1
          AND dispatch_completed_at IS NOT NULL
          AND dispatch_completed_at BETWEEN $2 AND $3
        ORDER BY dispatch_completed_at DESC, dispatch_id`,
      [teamId, fromIso, toIso],
    );
    return res.rows.map((r) => this.rowToVerification(r));
  }

  async readAgentWindow(
    teamId: string,
    agentName: string,
    fromIso: string,
    toIso: string,
    limit: number,
  ): Promise<DispatchVerification[]> {
    const res = await this.adapter.query<DispatchVerificationDbRow>(
      `SELECT * FROM dispatch_verifications
        WHERE team_id = $1
          AND agent_name = $2
          AND dispatch_completed_at IS NOT NULL
          AND dispatch_completed_at BETWEEN $3 AND $4
        ORDER BY dispatch_completed_at DESC, dispatch_id
        LIMIT $5`,
      [teamId, agentName, fromIso, toIso, limit],
    );
    return res.rows.map((r) => this.rowToVerification(r));
  }

  async readLastVerifiedByAgent(
    teamId: string,
    agentName: string,
  ): Promise<DispatchVerification | null> {
    const res = await this.adapter.query<DispatchVerificationDbRow>(
      `SELECT * FROM dispatch_verifications
        WHERE team_id = $1
          AND agent_name = $2
          AND verified = 1
          AND artifact_path IS NOT NULL
        ORDER BY dispatch_completed_at DESC, dispatch_id
        LIMIT 1`,
      [teamId, agentName],
    );
    if (res.rows.length === 0) return null;
    return this.rowToVerification(res.rows[0]);
  }

  private rowToVerification(row: DispatchVerificationDbRow): DispatchVerification {
    let sourceMetadata: DispatchVerification["source_metadata"];
    try {
      sourceMetadata = JSON.parse(
        row.source_metadata_json || "{}",
      ) as DispatchVerification["source_metadata"];
    } catch {
      sourceMetadata = { source: "dispatch_scheduler_queue", result_source: "none" };
    }

    return {
      schema_version: "dispatch-verification.v1",
      team_id: row.team_id,
      dispatch_id: row.dispatch_id,
      query_id: row.query_id,
      agent_name: row.agent_name,
      provider: normalizeProvider(row.provider),
      status: row.status as DispatchVerificationStatus,
      verified: toBool(row.verified) === true,
      failure_type: (row.failure_type as DispatchVerificationFailureType | null) ?? null,
      failure_detail: row.failure_detail,
      artifact_path: row.artifact_path,
      artifact_exists: toBool(row.artifact_exists),
      artifact_mtime: row.artifact_mtime,
      delivery_window_start: row.delivery_window_start,
      delivery_window_end: row.delivery_window_end,
      promotion_required: toBool(row.promotion_required) === true,
      promotion_verified: toBool(row.promotion_verified),
      promotion_failure_detail: row.promotion_failure_detail,
      dispatch_status: row.dispatch_status,
      dispatch_created_at: row.dispatch_created_at,
      dispatch_started_at: row.dispatch_started_at,
      dispatch_completed_at: row.dispatch_completed_at,
      result_success: toBool(row.result_success),
      tl_dr: row.tl_dr,
      kind: row.kind as DispatchArtifactKind,
      checked_at: row.checked_at,
      source_metadata: sourceMetadata,
    };
  }

  private verificationToParams(v: DispatchVerification): unknown[] {
    return [
      v.team_id,
      v.dispatch_id,
      v.query_id,
      v.agent_name,
      v.provider,
      v.status,
      fromBool(v.verified),
      v.failure_type,
      v.failure_detail,
      v.artifact_path,
      fromNullableBool(v.artifact_exists),
      v.artifact_mtime,
      v.delivery_window_start,
      v.delivery_window_end,
      fromBool(v.promotion_required),
      fromNullableBool(v.promotion_verified),
      v.promotion_failure_detail,
      v.dispatch_status,
      v.dispatch_created_at,
      v.dispatch_started_at,
      v.dispatch_completed_at,
      fromNullableBool(v.result_success),
      v.tl_dr,
      v.kind,
      v.checked_at,
      JSON.stringify(v.source_metadata),
    ];
  }

  private async addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    const info = await this.adapter.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    if (info.rows.some((r) => r.name === column)) return;
    this.adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeProvider(raw: string | null | undefined): Provider {
  switch (raw) {
    case "anthropic":
    case "openai":
    case "cursor":
    case "local":
    case "other":
      return raw;
    default:
      return "other";
  }
}

import type { DbAdapter } from "../db/db-adapter.js";
import type { CheckinRow, TaskRow } from "../db/types.js";
import type { InboxItemRow } from "../inbox/types.js";
import type {
  DailyDeskFollowThroughSource,
  DailyDeskMetadataRow,
  DailyDeskNeedsResponseSource,
  DailyDeskRegistration,
} from "./types.js";

export async function migrateDailyDeskTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS daily_desk_lane_metadata (
      team_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      audience TEXT NOT NULL,
      environment TEXT NOT NULL,
      owner TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      effective_lifecycle TEXT NOT NULL,
      source_as_of TEXT NOT NULL,
      admission_code TEXT NOT NULL,
      admission_detail TEXT NOT NULL,
      permitted_actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, lane, entity_kind, entity_id)
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS daily_desk_lane_rank ON daily_desk_lane_metadata(team_id, lane, source_as_of DESC, entity_id)`);
}

export async function upsertDailyDeskRegistration(
  adapter: DbAdapter,
  input: DailyDeskRegistration,
  nowIso: string,
): Promise<DailyDeskMetadataRow> {
  const actions = JSON.stringify([...new Set(input.permitted_actions)]);
  await adapter.query(
    `INSERT INTO daily_desk_lane_metadata
       (team_id, lane, entity_kind, entity_id, audience, environment, owner,
        canonical_url, effective_lifecycle, source_as_of, admission_code,
        admission_detail, permitted_actions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, lane, entity_kind, entity_id) DO UPDATE SET
       audience = excluded.audience,
       environment = excluded.environment,
       owner = excluded.owner,
       canonical_url = excluded.canonical_url,
       effective_lifecycle = excluded.effective_lifecycle,
       source_as_of = excluded.source_as_of,
       admission_code = excluded.admission_code,
       admission_detail = excluded.admission_detail,
       permitted_actions_json = excluded.permitted_actions_json,
       updated_at = excluded.updated_at`,
    [
      input.team_id, input.lane, input.entity_kind, input.entity_id,
      input.audience, input.environment, input.owner, input.canonical_url,
      input.effective_lifecycle, input.source_as_of, input.admission_code,
      input.admission_detail, actions, nowIso, nowIso,
    ],
  );
  const { rows } = await adapter.query<DailyDeskMetadataRow>(
    `SELECT * FROM daily_desk_lane_metadata
      WHERE team_id = ? AND lane = ? AND entity_kind = ? AND entity_id = ?`,
    [input.team_id, input.lane, input.entity_kind, input.entity_id],
  );
  return rows[0];
}

export async function listNeedsResponseSources(adapter: DbAdapter, teamId: string): Promise<DailyDeskNeedsResponseSource[]> {
  const { rows } = await adapter.query<DailyDeskMetadataRow & InboxItemRow>(
    `SELECT m.*, i.*
       FROM daily_desk_lane_metadata m
       JOIN inbox_items i ON i.inbox_phid = m.entity_id
      WHERE m.team_id = ? AND m.lane = 'needs_response' AND m.entity_kind = 'inbox'`,
    [teamId],
  );
  return rows.map((row) => ({
    metadata: metadataFromRow(row),
    inbox: inboxFromRow(row),
  }));
}

export async function listFollowThroughSources(adapter: DbAdapter, teamId: string): Promise<DailyDeskFollowThroughSource[]> {
  const { rows } = await adapter.query<Record<string, unknown>>(
    `SELECT m.team_id AS m_team_id, m.lane AS m_lane, m.entity_kind AS m_entity_kind,
            m.entity_id AS m_entity_id, m.audience AS m_audience, m.environment AS m_environment,
            m.owner AS m_owner, m.canonical_url AS m_canonical_url,
            m.effective_lifecycle AS m_effective_lifecycle, m.source_as_of AS m_source_as_of,
            m.admission_code AS m_admission_code, m.admission_detail AS m_admission_detail,
            m.permitted_actions_json AS m_permitted_actions_json, m.created_at AS m_created_at,
            m.updated_at AS m_updated_at, c.*, t.id AS task_id, t.name AS task_name,
            t.uuid AS task_uuid, t.team_id AS task_team_id, t.title AS task_title,
            t.description AS task_description, t.status AS task_status,
            t.created_by AS task_created_by, t.owner AS task_owner,
            t.created_at AS task_created_at, t.updated_at AS task_updated_at,
            t.completed_at AS task_completed_at, t.track AS task_track
       FROM daily_desk_lane_metadata m
       JOIN checkins c ON c.id = m.entity_id AND c.team_id = m.team_id
       JOIN tasks t ON t.id = c.linked_task_id AND t.team_id = m.team_id
      WHERE m.team_id = ? AND m.lane = 'follow_through' AND m.entity_kind = 'checkin'`,
    [teamId],
  );
  return rows.map((row) => ({
    metadata: {
      team_id: String(row.m_team_id), lane: "follow_through", entity_kind: "checkin",
      entity_id: String(row.m_entity_id), audience: row.m_audience as "operator" | "system",
      environment: row.m_environment as "production" | "test", owner: String(row.m_owner),
      canonical_url: String(row.m_canonical_url), effective_lifecycle: String(row.m_effective_lifecycle),
      source_as_of: String(row.m_source_as_of), admission_code: String(row.m_admission_code),
      admission_detail: String(row.m_admission_detail), permitted_actions_json: String(row.m_permitted_actions_json),
      created_at: String(row.m_created_at), updated_at: String(row.m_updated_at),
    },
    checkin: row as unknown as CheckinRow,
    task: {
      id: String(row.task_id), name: String(row.task_name), uuid: String(row.task_uuid),
      team_id: String(row.task_team_id), title: String(row.task_title),
      description: row.task_description == null ? null : String(row.task_description),
      status: row.task_status as TaskRow["status"], created_by: row.task_created_by == null ? null : String(row.task_created_by),
      owner: row.task_owner == null ? null : String(row.task_owner), created_at: Number(row.task_created_at),
      updated_at: Number(row.task_updated_at), completed_at: row.task_completed_at == null ? null : Number(row.task_completed_at),
      track: String(row.task_track),
    },
  }));
}

function metadataFromRow(row: DailyDeskMetadataRow): DailyDeskMetadataRow {
  return {
    team_id: row.team_id, lane: row.lane, entity_kind: row.entity_kind, entity_id: row.entity_id,
    audience: row.audience, environment: row.environment, owner: row.owner,
    canonical_url: row.canonical_url, effective_lifecycle: row.effective_lifecycle,
    source_as_of: row.source_as_of, admission_code: row.admission_code,
    admission_detail: row.admission_detail, permitted_actions_json: row.permitted_actions_json,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function inboxFromRow(row: DailyDeskMetadataRow & InboxItemRow): InboxItemRow {
  return {
    inbox_phid: row.inbox_phid, operator_state: row.operator_state, source_kind: row.source_kind,
    source_external_id: row.source_external_id, source_text: row.source_text, source_excerpt: row.source_excerpt,
    source_subject: row.source_subject, source_from: row.source_from, classification_label: row.classification_label,
    classification_confidence: row.classification_confidence, classification_classifier: row.classification_classifier,
    classification_rationale: row.classification_rationale, project_hint: row.project_hint, agent_hint: row.agent_hint,
    origin_ref: row.origin_ref, received_at: row.received_at, triaged_at: row.triaged_at,
    resolved_at: row.resolved_at, snoozed_until: row.snoozed_until, checked_off_at: row.checked_off_at,
    checked_off_reason: row.checked_off_reason, source: row.source, parity_status: row.parity_status,
    generated_at: row.generated_at, projection_version: row.projection_version,
    legacy_inbox_md_line: row.legacy_inbox_md_line, legacy_shadow_path: row.legacy_shadow_path,
    read_at: row.read_at,
  };
}

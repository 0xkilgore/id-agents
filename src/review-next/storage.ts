import type { DbAdapter } from "../db/db-adapter.js";
import type { ReviewNextMetadataRow, ReviewNextRegistration, ReviewNextSourceRow } from "./types.js";

export async function migrateReviewNextTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS artifact_review_next_metadata (
      artifact_id TEXT PRIMARY KEY,
      audience TEXT NOT NULL,
      environment TEXT NOT NULL,
      owner TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      effective_lifecycle TEXT NOT NULL,
      source_as_of TEXT NOT NULL,
      revised_at TEXT,
      revalidated_at TEXT,
      pinned_at TEXT,
      attention_state TEXT NOT NULL,
      attention_reason TEXT NOT NULL,
      attention_priority INTEGER NOT NULL,
      admission_reason TEXT NOT NULL,
      permitted_actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS artifact_review_next_rank ON artifact_review_next_metadata(attention_priority, source_as_of DESC, artifact_id)`);
}

export async function upsertReviewNextMetadata(
  adapter: DbAdapter,
  artifactId: string,
  input: ReviewNextRegistration,
  nowIso: string,
): Promise<ReviewNextMetadataRow> {
  const actions = JSON.stringify([...new Set(input.permitted_actions)]);
  await adapter.query(
    `INSERT INTO artifact_review_next_metadata
       (artifact_id, audience, environment, owner, canonical_url, effective_lifecycle,
        source_as_of, revised_at, revalidated_at, pinned_at, attention_state,
        attention_reason, attention_priority, admission_reason, permitted_actions_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       audience = excluded.audience,
       environment = excluded.environment,
       owner = excluded.owner,
       canonical_url = excluded.canonical_url,
       effective_lifecycle = excluded.effective_lifecycle,
       source_as_of = excluded.source_as_of,
       revised_at = excluded.revised_at,
       revalidated_at = excluded.revalidated_at,
       pinned_at = excluded.pinned_at,
       attention_state = excluded.attention_state,
       attention_reason = excluded.attention_reason,
       attention_priority = excluded.attention_priority,
       admission_reason = excluded.admission_reason,
       permitted_actions_json = excluded.permitted_actions_json,
       updated_at = excluded.updated_at`,
    [
      artifactId, input.audience, input.environment, input.owner, input.canonical_url,
      input.effective_lifecycle, input.source_as_of, input.revised_at ?? null,
      input.revalidated_at ?? null, input.pinned_at ?? null, input.attention_state,
      input.attention_reason, input.attention_priority, input.admission_reason,
      actions, nowIso, nowIso,
    ],
  );
  const { rows } = await adapter.query<ReviewNextMetadataRow>(
    `SELECT * FROM artifact_review_next_metadata WHERE artifact_id = ?`,
    [artifactId],
  );
  return rows[0];
}

export async function retireReviewNextMetadata(
  adapter: DbAdapter,
  artifactId: string,
  lifecycle: "approved" | "rejected",
  nowIso: string,
): Promise<void> {
  await adapter.query(
    `UPDATE artifact_review_next_metadata
        SET effective_lifecycle = ?, source_as_of = ?, updated_at = ?
      WHERE artifact_id = ?`,
    [lifecycle, nowIso, nowIso, artifactId],
  );
}

export async function listReviewNextSourceRows(adapter: DbAdapter): Promise<ReviewNextSourceRow[]> {
  const { rows } = await adapter.query<ReviewNextSourceRow>(
    `SELECT a.artifact_id, a.title, a.created_at AS artifact_created_at,
            a.produced_at, a.source, a.availability, a.abs_path, a.basename,
            m.audience, m.environment, m.owner, m.canonical_url,
            m.effective_lifecycle, m.source_as_of, m.revised_at,
            m.revalidated_at, m.pinned_at, m.attention_state,
            m.attention_reason, m.attention_priority, m.admission_reason,
            m.permitted_actions_json
       FROM artifact_review_next_metadata m
       JOIN artifacts a ON a.artifact_id = m.artifact_id`,
  );
  return rows;
}

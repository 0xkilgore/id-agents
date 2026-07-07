// DV3 — SQLite FTS5 indexes for the doc-model substrate (artifacts already
// indexed in outputs/storage; this adds desk + tasks and is idempotent).

import type { DbAdapter } from "../db/db-adapter.js";
import { migrateDeskTables } from "../desk/storage.js";

async function execSqlite(adapter: DbAdapter, sql: string): Promise<void> {
  if (adapter.dialect === "sqlite" && typeof (adapter as unknown as { exec?: (s: string) => void }).exec === "function") {
    (adapter as unknown as { exec: (s: string) => void }).exec(sql);
    return;
  }
  await adapter.query(sql);
}

export async function migrateDocModelFtsIndexes(adapter: DbAdapter): Promise<void> {
  // artifacts/desk_items may not exist until their route modules run. Search owns
  // the read surface, so make the substrate tables available before indexing.
  const { migrateOutputsTables } = await import("../outputs/storage.js");
  await migrateOutputsTables(adapter);
  await migrateDeskTables(adapter);

  if (adapter.dialect === "postgres") {
    await adapter.query(`
      CREATE INDEX IF NOT EXISTS artifacts_doc_model_search_idx
          ON artifacts
       USING GIN (to_tsvector('simple',
         coalesce(title, '') || ' ' || basename || ' ' || coalesce(tag, '') || ' ' || agent
       ))
    `);
    await adapter.query(`
      CREATE INDEX IF NOT EXISTS desk_items_doc_model_search_idx
          ON desk_items
       USING GIN (to_tsvector('simple',
         label || ' ' || body_md || ' ' || kind || ' ' || coalesce(source_ref, '')
       ))
    `);
    await adapter.query(`
      CREATE INDEX IF NOT EXISTS tasks_doc_model_search_idx
          ON tasks
       USING GIN (to_tsvector('simple',
         name || ' ' || title || ' ' || coalesce(description, '') || ' ' || coalesce(track, '') || ' ' || status
       ))
    `);
    return;
  }

  if (adapter.dialect !== "sqlite") return;

  await execSqlite(
    adapter,
    `
      CREATE VIRTUAL TABLE IF NOT EXISTS desk_items_fts USING fts5(
        label, body_md, kind, source_ref,
        content='desk_items', content_rowid='rowid'
      );
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS desk_items_fts_ai AFTER INSERT ON desk_items BEGIN
        INSERT INTO desk_items_fts(rowid, label, body_md, kind, source_ref)
        VALUES (new.rowid, new.label, new.body_md, new.kind, COALESCE(new.source_ref, ''));
      END;
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS desk_items_fts_ad AFTER DELETE ON desk_items BEGIN
        INSERT INTO desk_items_fts(desk_items_fts, rowid, label, body_md, kind, source_ref)
        VALUES ('delete', old.rowid, old.label, old.body_md, old.kind, COALESCE(old.source_ref, ''));
      END;
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS desk_items_fts_au AFTER UPDATE ON desk_items BEGIN
        INSERT INTO desk_items_fts(desk_items_fts, rowid, label, body_md, kind, source_ref)
        VALUES ('delete', old.rowid, old.label, old.body_md, old.kind, COALESCE(old.source_ref, ''));
        INSERT INTO desk_items_fts(rowid, label, body_md, kind, source_ref)
        VALUES (new.rowid, new.label, new.body_md, new.kind, COALESCE(new.source_ref, ''));
      END;
    `,
  );
  await execSqlite(adapter, `INSERT INTO desk_items_fts(desk_items_fts) VALUES('rebuild')`);

  await execSqlite(
    adapter,
    `
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        name, title, description, track, status,
        content='tasks', content_rowid='rowid'
      );
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, name, title, description, track, status)
        VALUES (
          new.rowid,
          new.name,
          new.title,
          COALESCE(new.description, ''),
          COALESCE(new.track, ''),
          new.status
        );
      END;
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, name, title, description, track, status)
        VALUES (
          'delete',
          old.rowid,
          old.name,
          old.title,
          COALESCE(old.description, ''),
          COALESCE(old.track, ''),
          old.status
        );
      END;
    `,
  );
  await execSqlite(
    adapter,
    `
      CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, name, title, description, track, status)
        VALUES (
          'delete',
          old.rowid,
          old.name,
          old.title,
          COALESCE(old.description, ''),
          COALESCE(old.track, ''),
          old.status
        );
        INSERT INTO tasks_fts(rowid, name, title, description, track, status)
        VALUES (
          new.rowid,
          new.name,
          new.title,
          COALESCE(new.description, ''),
          COALESCE(new.track, ''),
          new.status
        );
      END;
    `,
  );
  await execSqlite(adapter, `INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')`);
}

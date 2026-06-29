// Inbox 2.0 — storage layer (DDL, CRUD, migration report).

import type { DbAdapter } from '../db/db-adapter.js';
import type {
  InboxItemRow, InboxLinkRow, InboxAuditEvent,
  InboxPolicyViolation, InboxRoutingDecision,
  OperatorState, LinkKind,
} from './types.js';

// ── DDL (idempotent, safe to call every startup) ───────────────────

export function migrateInboxTables(adapter: DbAdapter): void {
  const exec = (sql: string) => {
    if (adapter.dialect === 'sqlite') {
      (adapter as any).exec?.(sql) ?? adapter.query(sql);
    } else {
      adapter.query(sql);
    }
  };

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      inbox_phid TEXT PRIMARY KEY,
      operator_state TEXT NOT NULL DEFAULT 'new',
      source_kind TEXT NOT NULL DEFAULT 'manual_capture',
      source_external_id TEXT,
      source_text TEXT,
      source_excerpt TEXT,
      source_subject TEXT,
      source_from TEXT,
      classification_label TEXT,
      classification_confidence REAL,
      classification_classifier TEXT,
      classification_rationale TEXT,
      project_hint TEXT,
      agent_hint TEXT,
      origin_ref TEXT,
      received_at TEXT NOT NULL,
      triaged_at TEXT,
      resolved_at TEXT,
      snoozed_until TEXT,
      checked_off_at TEXT,
      checked_off_reason TEXT,
      source TEXT NOT NULL DEFAULT 'index',
      parity_status TEXT NOT NULL DEFAULT 'ok',
      generated_at TEXT NOT NULL,
      projection_version INTEGER NOT NULL DEFAULT 1,
      legacy_inbox_md_line TEXT,
      legacy_shadow_path TEXT
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_items_state_idx ON inbox_items(operator_state)`);
  exec(`CREATE INDEX IF NOT EXISTS inbox_items_received_idx ON inbox_items(received_at)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_phid TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      UNIQUE(inbox_phid, kind, target)
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_links_phid_idx ON inbox_links(inbox_phid)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_phid TEXT NOT NULL,
      op_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      reason TEXT,
      summary TEXT NOT NULL,
      input_revision TEXT,
      links_json TEXT
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_audit_phid_idx ON inbox_audit_events(inbox_phid, ts)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_policy_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_phid TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      detected_at TEXT NOT NULL,
      resolved_at TEXT,
      meta_json TEXT
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_pv_phid_idx ON inbox_policy_violations(inbox_phid)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_routing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_phid TEXT NOT NULL,
      rule_id TEXT,
      action_type TEXT NOT NULL,
      action_target TEXT,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      input_revision TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      decided_at TEXT NOT NULL
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_rd_phid_idx ON inbox_routing_decisions(inbox_phid)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_email_aliases (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      address TEXT NOT NULL,
      default_project TEXT,
      default_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, address)
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_email_aliases_team_user_idx ON inbox_email_aliases(team_id, user_id)`);
  exec(`CREATE INDEX IF NOT EXISTS inbox_email_aliases_address_idx ON inbox_email_aliases(address)`);

  exec(`
    CREATE TABLE IF NOT EXISTS inbox_email_messages (
      idempotency_key TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      alias_id TEXT NOT NULL,
      inbox_phid TEXT NOT NULL,
      message_id TEXT,
      source_from TEXT,
      source_to TEXT NOT NULL,
      source_subject TEXT,
      received_at TEXT NOT NULL,
      triage_action TEXT NOT NULL,
      task_id TEXT,
      dispatch_phid TEXT,
      created_at TEXT NOT NULL
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS inbox_email_messages_team_idx ON inbox_email_messages(team_id, received_at)`);
  exec(`CREATE INDEX IF NOT EXISTS inbox_email_messages_alias_idx ON inbox_email_messages(alias_id, received_at)`);
}

// ── CRUD ───────────────────────────────────────────────────────────

export async function upsertInboxItem(adapter: DbAdapter, row: InboxItemRow): Promise<void> {
  await adapter.query(
    `INSERT INTO inbox_items (
      inbox_phid, operator_state, source_kind, source_external_id,
      source_text, source_excerpt, source_subject, source_from,
      classification_label, classification_confidence, classification_classifier, classification_rationale,
      project_hint, agent_hint, origin_ref,
      received_at, triaged_at, resolved_at, snoozed_until,
      checked_off_at, checked_off_reason,
      source, parity_status, generated_at, projection_version,
      legacy_inbox_md_line, legacy_shadow_path
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT(inbox_phid) DO UPDATE SET
      operator_state = excluded.operator_state,
      source_kind = excluded.source_kind,
      source_external_id = excluded.source_external_id,
      source_text = excluded.source_text,
      source_excerpt = excluded.source_excerpt,
      source_subject = excluded.source_subject,
      source_from = excluded.source_from,
      classification_label = excluded.classification_label,
      classification_confidence = excluded.classification_confidence,
      classification_classifier = excluded.classification_classifier,
      classification_rationale = excluded.classification_rationale,
      project_hint = excluded.project_hint,
      agent_hint = excluded.agent_hint,
      origin_ref = excluded.origin_ref,
      received_at = excluded.received_at,
      triaged_at = excluded.triaged_at,
      resolved_at = excluded.resolved_at,
      snoozed_until = excluded.snoozed_until,
      checked_off_at = excluded.checked_off_at,
      checked_off_reason = excluded.checked_off_reason,
      source = excluded.source,
      parity_status = excluded.parity_status,
      generated_at = excluded.generated_at,
      projection_version = excluded.projection_version,
      legacy_inbox_md_line = excluded.legacy_inbox_md_line,
      legacy_shadow_path = excluded.legacy_shadow_path`,
    [
      row.inbox_phid, row.operator_state, row.source_kind, row.source_external_id,
      row.source_text, row.source_excerpt, row.source_subject, row.source_from,
      row.classification_label, row.classification_confidence, row.classification_classifier, row.classification_rationale,
      row.project_hint, row.agent_hint, row.origin_ref,
      row.received_at, row.triaged_at, row.resolved_at, row.snoozed_until,
      row.checked_off_at, row.checked_off_reason,
      row.source, row.parity_status, row.generated_at, row.projection_version,
      row.legacy_inbox_md_line, row.legacy_shadow_path,
    ],
  );
}

export async function getInboxItem(adapter: DbAdapter, phid: string): Promise<InboxItemRow | null> {
  const { rows } = await adapter.query<InboxItemRow>('SELECT * FROM inbox_items WHERE inbox_phid = $1', [phid]);
  return rows[0] ?? null;
}

export async function listInboxItems(
  adapter: DbAdapter,
  filters: {
    state?: OperatorState;
    source?: string;
    project?: string;
    agent?: string;
    policy_violation?: boolean;
    snoozed?: boolean;
    errored?: boolean;
  },
  limit = 50,
  offset = 0,
): Promise<InboxItemRow[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.state) { conditions.push(`operator_state = $${paramIdx++}`); params.push(filters.state); }
  if (filters.source) { conditions.push(`source_kind = $${paramIdx++}`); params.push(filters.source); }
  if (filters.project) { conditions.push(`project_hint = $${paramIdx++}`); params.push(filters.project); }
  if (filters.agent) { conditions.push(`agent_hint = $${paramIdx++}`); params.push(filters.agent); }
  if (filters.policy_violation) {
    conditions.push(`inbox_phid IN (SELECT inbox_phid FROM inbox_policy_violations WHERE resolved_at IS NULL)`);
  }
  if (filters.snoozed === true) { conditions.push(`operator_state = 'snoozed'`); }
  if (filters.snoozed === false) { conditions.push(`operator_state != 'snoozed'`); }
  if (filters.errored === true) { conditions.push(`operator_state = 'errored'`); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await adapter.query<InboxItemRow>(
    `SELECT * FROM inbox_items ${where} ORDER BY received_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...params, limit, offset],
  );
  return rows;
}

export async function countInboxItems(adapter: DbAdapter, state?: OperatorState): Promise<number> {
  const cond = state ? 'WHERE operator_state = $1' : '';
  const params = state ? [state] : [];
  const { rows } = await adapter.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM inbox_items ${cond}`, params);
  return Number(rows[0]?.cnt ?? 0);
}

export async function countReceivedSince(adapter: DbAdapter, since: string): Promise<number> {
  const { rows } = await adapter.query<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM inbox_items WHERE received_at >= $1',
    [since],
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function getOldestUnresolved(adapter: DbAdapter): Promise<string | null> {
  const { rows } = await adapter.query<{ received_at: string }>(
    "SELECT received_at FROM inbox_items WHERE operator_state NOT IN ('checked_off','filed') ORDER BY received_at ASC LIMIT 1",
    [],
  );
  return rows[0]?.received_at ?? null;
}

export async function getNewestReceived(adapter: DbAdapter): Promise<string | null> {
  const { rows } = await adapter.query<{ received_at: string }>(
    'SELECT received_at FROM inbox_items ORDER BY received_at DESC LIMIT 1',
    [],
  );
  return rows[0]?.received_at ?? null;
}

// ── Links ──

export async function upsertLink(adapter: DbAdapter, inbox_phid: string, kind: LinkKind, target: string): Promise<void> {
  await adapter.query(
    'INSERT INTO inbox_links (inbox_phid, kind, target) VALUES ($1, $2, $3) ON CONFLICT(inbox_phid, kind, target) DO NOTHING',
    [inbox_phid, kind, target],
  );
}

export async function getLinks(adapter: DbAdapter, inbox_phid: string): Promise<InboxLinkRow[]> {
  const { rows } = await adapter.query<InboxLinkRow>('SELECT * FROM inbox_links WHERE inbox_phid = $1', [inbox_phid]);
  return rows;
}

// ── Audit events ──

export async function appendAuditEvent(adapter: DbAdapter, event: Omit<InboxAuditEvent, 'id'>): Promise<void> {
  await adapter.query(
    `INSERT INTO inbox_audit_events (inbox_phid, op_id, op_type, actor_id, ts, reason, summary, input_revision, links_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.inbox_phid, event.op_id, event.op_type, event.actor_id, event.ts, event.reason, event.summary, event.input_revision, event.links_json],
  );
}

export async function getAuditEvents(adapter: DbAdapter, inbox_phid: string): Promise<InboxAuditEvent[]> {
  const { rows } = await adapter.query<InboxAuditEvent>(
    'SELECT * FROM inbox_audit_events WHERE inbox_phid = $1 ORDER BY ts ASC',
    [inbox_phid],
  );
  return rows;
}

// ── Policy violations ──

export async function appendPolicyViolation(
  adapter: DbAdapter,
  violation: Omit<InboxPolicyViolation, 'id'>,
): Promise<void> {
  await adapter.query(
    `INSERT INTO inbox_policy_violations (inbox_phid, kind, message, severity, detected_at, resolved_at, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [violation.inbox_phid, violation.kind, violation.message, violation.severity, violation.detected_at, violation.resolved_at, violation.meta_json],
  );
}

export async function getPolicyViolations(adapter: DbAdapter, inbox_phid: string): Promise<InboxPolicyViolation[]> {
  const { rows } = await adapter.query<InboxPolicyViolation>(
    'SELECT * FROM inbox_policy_violations WHERE inbox_phid = $1 ORDER BY detected_at ASC',
    [inbox_phid],
  );
  return rows;
}

export async function listAllPolicyViolations(adapter: DbAdapter, unresolved_only = true): Promise<InboxPolicyViolation[]> {
  const cond = unresolved_only ? 'WHERE resolved_at IS NULL' : '';
  const { rows } = await adapter.query<InboxPolicyViolation>(
    `SELECT * FROM inbox_policy_violations ${cond} ORDER BY detected_at DESC`,
    [],
  );
  return rows;
}

// ── Routing decisions ──

export async function appendRoutingDecision(
  adapter: DbAdapter,
  decision: Omit<InboxRoutingDecision, 'id'>,
): Promise<void> {
  if (decision.is_primary) {
    await adapter.query(
      'UPDATE inbox_routing_decisions SET is_primary = 0 WHERE inbox_phid = $1 AND is_primary = 1',
      [decision.inbox_phid],
    );
  }
  await adapter.query(
    `INSERT INTO inbox_routing_decisions (inbox_phid, rule_id, action_type, action_target, actor_id, reason, input_revision, is_primary, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [decision.inbox_phid, decision.rule_id, decision.action_type, decision.action_target, decision.actor_id, decision.reason, decision.input_revision, decision.is_primary ? 1 : 0, decision.decided_at],
  );
}

export async function getRoutingDecisions(adapter: DbAdapter, inbox_phid: string): Promise<InboxRoutingDecision[]> {
  const { rows } = await adapter.query<InboxRoutingDecision>(
    'SELECT * FROM inbox_routing_decisions WHERE inbox_phid = $1 ORDER BY decided_at ASC',
    [inbox_phid],
  );
  return rows;
}

// ── Update helpers for typed actions ──

export async function updateOperatorState(adapter: DbAdapter, phid: string, state: OperatorState, extra?: Record<string, any>): Promise<void> {
  const sets = ['operator_state = $1'];
  const params: any[] = [state];
  let idx = 2;
  if (extra) {
    for (const [key, val] of Object.entries(extra)) {
      sets.push(`${key} = $${idx++}`);
      params.push(val);
    }
  }
  params.push(phid);
  await adapter.query(`UPDATE inbox_items SET ${sets.join(', ')} WHERE inbox_phid = $${idx}`, params);
}

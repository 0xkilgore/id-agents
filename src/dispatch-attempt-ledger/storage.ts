import type { DbAdapter } from "../db/db-adapter.js";

export interface DispatchAttemptInput {
  team_id: string;
  route: "/talk-to" | "/news-to";
  to_agent: string | null;
  from_actor: string | null;
  original_query_id: string | null;
  original_dispatch_id: string | null;
  subject: string | null;
  status_code: number;
  ok: boolean;
  error: string | null;
  response_json: unknown;
  created_at: string;
}

export interface DispatchAttemptLedgerRow {
  id: string;
  team_id: string;
  correlation_key: string;
  terminal_status: "sent" | "fallback_sent" | "failed" | "pending";
  to_agent: string | null;
  from_actor: string | null;
  original_query_id: string | null;
  original_dispatch_id: string | null;
  subject: string | null;
  talk_to_attempted: boolean;
  talk_to_ok: boolean | null;
  talk_to_status_code: number | null;
  talk_to_error: string | null;
  talk_to_at: string | null;
  news_to_attempted: boolean;
  news_to_ok: boolean | null;
  news_to_status_code: number | null;
  news_to_error: string | null;
  news_to_at: string | null;
  fallback_used: boolean;
  fallback_ok: boolean | null;
  attempts_json: unknown[];
  created_at: string;
  updated_at: string;
}

export async function migrateDispatchAttemptLedger(adapter: DbAdapter): Promise<void> {
  if (adapter.dialect === "postgres") {
    await adapter.query(`
      CREATE TABLE IF NOT EXISTS dispatch_attempt_ledger (
        id text PRIMARY KEY,
        team_id text NOT NULL,
        correlation_key text NOT NULL,
        terminal_status text NOT NULL DEFAULT 'pending',
        to_agent text,
        from_actor text,
        original_query_id text,
        original_dispatch_id text,
        subject text,
        talk_to_attempted integer NOT NULL DEFAULT 0,
        talk_to_ok integer,
        talk_to_status_code integer,
        talk_to_error text,
        talk_to_at text,
        news_to_attempted integer NOT NULL DEFAULT 0,
        news_to_ok integer,
        news_to_status_code integer,
        news_to_error text,
        news_to_at text,
        fallback_used integer NOT NULL DEFAULT 0,
        fallback_ok integer,
        attempts_json text NOT NULL DEFAULT '[]',
        created_at text NOT NULL,
        updated_at text NOT NULL,
        UNIQUE(team_id, correlation_key)
      );
      CREATE INDEX IF NOT EXISTS dispatch_attempt_ledger_team_updated_idx
        ON dispatch_attempt_ledger(team_id, updated_at DESC);
    `);
    await addColumnIfMissing(adapter, `ALTER TABLE dispatch_attempt_ledger ADD COLUMN terminal_status text NOT NULL DEFAULT 'pending'`);
    return;
  }

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS dispatch_attempt_ledger (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      correlation_key TEXT NOT NULL,
      terminal_status TEXT NOT NULL DEFAULT 'pending',
      to_agent TEXT,
      from_actor TEXT,
      original_query_id TEXT,
      original_dispatch_id TEXT,
      subject TEXT,
      talk_to_attempted INTEGER NOT NULL DEFAULT 0,
      talk_to_ok INTEGER,
      talk_to_status_code INTEGER,
      talk_to_error TEXT,
      talk_to_at TEXT,
      news_to_attempted INTEGER NOT NULL DEFAULT 0,
      news_to_ok INTEGER,
      news_to_status_code INTEGER,
      news_to_error TEXT,
      news_to_at TEXT,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      fallback_ok INTEGER,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, correlation_key)
    )
  `);
  await adapter.query(`
    CREATE INDEX IF NOT EXISTS dispatch_attempt_ledger_team_updated_idx
      ON dispatch_attempt_ledger(team_id, updated_at DESC)
  `);
  await addColumnIfMissing(adapter, `ALTER TABLE dispatch_attempt_ledger ADD COLUMN terminal_status TEXT NOT NULL DEFAULT 'pending'`);
}

export function dispatchAttemptCorrelationKey(input: {
  to_agent: string | null;
  original_query_id: string | null;
  original_dispatch_id: string | null;
  subject: string | null;
}): string {
  if (input.original_dispatch_id) return `dispatch:${input.original_dispatch_id}`;
  if (input.original_query_id) return `query:${input.original_query_id}`;
  return `message:${input.to_agent ?? "unknown"}:${input.subject ?? ""}`;
}

export async function recordDispatchAttempt(
  adapter: DbAdapter,
  input: DispatchAttemptInput,
): Promise<DispatchAttemptLedgerRow> {
  await migrateDispatchAttemptLedger(adapter);
  const correlationKey = dispatchAttemptCorrelationKey(input);
  const id = `attempt_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  const existing = await readDispatchAttemptLedgerByKey(adapter, input.team_id, correlationKey);
  const attemptRecord = {
    route: input.route,
    ok: input.ok,
    status_code: input.status_code,
    error: input.error,
    at: input.created_at,
    response: input.response_json,
  };
  const attempts = [...(existing?.attempts_json ?? []), attemptRecord];

  const talkAttempted = input.route === "/talk-to" || existing?.talk_to_attempted === true;
  const newsAttempted = input.route === "/news-to" || existing?.news_to_attempted === true;
  const talkOk = input.route === "/talk-to" ? input.ok : existing?.talk_to_ok ?? null;
  const newsOk = input.route === "/news-to" ? input.ok : existing?.news_to_ok ?? null;
  const fallbackUsed = talkAttempted && newsAttempted && talkOk === false;
  const fallbackOk = fallbackUsed ? newsOk : null;
  const terminalStatus = dispatchAttemptTerminalStatus({
    talk_attempted: talkAttempted,
    talk_ok: talkOk,
    news_attempted: newsAttempted,
    news_ok: newsOk,
    fallback_used: fallbackUsed,
  });

  if (!existing) {
    await adapter.query(
      `INSERT INTO dispatch_attempt_ledger (
        id, team_id, correlation_key, terminal_status, to_agent, from_actor, original_query_id, original_dispatch_id,
        subject, talk_to_attempted, talk_to_ok, talk_to_status_code, talk_to_error, talk_to_at,
        news_to_attempted, news_to_ok, news_to_status_code, news_to_error, news_to_at,
        fallback_used, fallback_ok, attempts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.team_id,
        correlationKey,
        terminalStatus,
        input.to_agent,
        input.from_actor,
        input.original_query_id,
        input.original_dispatch_id,
        input.subject,
        input.route === "/talk-to" ? 1 : 0,
        input.route === "/talk-to" ? boolToDb(input.ok) : null,
        input.route === "/talk-to" ? input.status_code : null,
        input.route === "/talk-to" ? input.error : null,
        input.route === "/talk-to" ? input.created_at : null,
        input.route === "/news-to" ? 1 : 0,
        input.route === "/news-to" ? boolToDb(input.ok) : null,
        input.route === "/news-to" ? input.status_code : null,
        input.route === "/news-to" ? input.error : null,
        input.route === "/news-to" ? input.created_at : null,
        boolToDb(fallbackUsed),
        fallbackOk == null ? null : boolToDb(fallbackOk),
        JSON.stringify(attempts),
        input.created_at,
        input.created_at,
      ],
    );
  } else {
    await adapter.query(
      `UPDATE dispatch_attempt_ledger
       SET to_agent = COALESCE(to_agent, ?),
           terminal_status = ?,
           from_actor = COALESCE(from_actor, ?),
           original_query_id = COALESCE(original_query_id, ?),
           original_dispatch_id = COALESCE(original_dispatch_id, ?),
           subject = COALESCE(subject, ?),
           talk_to_attempted = ?,
           talk_to_ok = ?,
           talk_to_status_code = ?,
           talk_to_error = ?,
           talk_to_at = ?,
           news_to_attempted = ?,
           news_to_ok = ?,
           news_to_status_code = ?,
           news_to_error = ?,
           news_to_at = ?,
           fallback_used = ?,
           fallback_ok = ?,
           attempts_json = ?,
           updated_at = ?
       WHERE team_id = ? AND correlation_key = ?`,
      [
        input.to_agent,
        terminalStatus,
        input.from_actor,
        input.original_query_id,
        input.original_dispatch_id,
        input.subject,
        boolToDb(talkAttempted),
        talkOk == null ? null : boolToDb(talkOk),
        input.route === "/talk-to" ? input.status_code : existing.talk_to_status_code,
        input.route === "/talk-to" ? input.error : existing.talk_to_error,
        input.route === "/talk-to" ? input.created_at : existing.talk_to_at,
        boolToDb(newsAttempted),
        newsOk == null ? null : boolToDb(newsOk),
        input.route === "/news-to" ? input.status_code : existing.news_to_status_code,
        input.route === "/news-to" ? input.error : existing.news_to_error,
        input.route === "/news-to" ? input.created_at : existing.news_to_at,
        boolToDb(fallbackUsed),
        fallbackOk == null ? null : boolToDb(fallbackOk),
        JSON.stringify(attempts),
        input.created_at,
        input.team_id,
        correlationKey,
      ],
    );
  }

  return (await readDispatchAttemptLedgerByKey(adapter, input.team_id, correlationKey))!;
}

export async function readDispatchAttemptLedger(
  adapter: DbAdapter,
  teamId: string,
  limit = 25,
): Promise<DispatchAttemptLedgerRow[]> {
  await migrateDispatchAttemptLedger(adapter);
  const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const res = await adapter.query<Record<string, unknown>>(
    `SELECT * FROM dispatch_attempt_ledger
     WHERE team_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`,
    [teamId, clampedLimit],
  );
  return res.rows.map(mapRow);
}

async function readDispatchAttemptLedgerByKey(
  adapter: DbAdapter,
  teamId: string,
  correlationKey: string,
): Promise<DispatchAttemptLedgerRow | null> {
  const res = await adapter.query<Record<string, unknown>>(
    `SELECT * FROM dispatch_attempt_ledger WHERE team_id = ? AND correlation_key = ? LIMIT 1`,
    [teamId, correlationKey],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

function mapRow(row: Record<string, unknown>): DispatchAttemptLedgerRow {
  return {
    id: String(row.id),
    team_id: String(row.team_id),
    correlation_key: String(row.correlation_key),
    terminal_status: normalizeTerminalStatus(row.terminal_status),
    to_agent: nullableString(row.to_agent),
    from_actor: nullableString(row.from_actor),
    original_query_id: nullableString(row.original_query_id),
    original_dispatch_id: nullableString(row.original_dispatch_id),
    subject: nullableString(row.subject),
    talk_to_attempted: dbBool(row.talk_to_attempted),
    talk_to_ok: nullableBool(row.talk_to_ok),
    talk_to_status_code: nullableNumber(row.talk_to_status_code),
    talk_to_error: nullableString(row.talk_to_error),
    talk_to_at: nullableString(row.talk_to_at),
    news_to_attempted: dbBool(row.news_to_attempted),
    news_to_ok: nullableBool(row.news_to_ok),
    news_to_status_code: nullableNumber(row.news_to_status_code),
    news_to_error: nullableString(row.news_to_error),
    news_to_at: nullableString(row.news_to_at),
    fallback_used: dbBool(row.fallback_used),
    fallback_ok: nullableBool(row.fallback_ok),
    attempts_json: parseAttempts(row.attempts_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function dispatchAttemptTerminalStatus(input: {
  talk_attempted: boolean;
  talk_ok: boolean | null;
  news_attempted: boolean;
  news_ok: boolean | null;
  fallback_used: boolean;
}): DispatchAttemptLedgerRow["terminal_status"] {
  if (input.fallback_used) return input.news_ok === true ? "fallback_sent" : "failed";
  if (input.talk_attempted && input.talk_ok === true) return "sent";
  if (input.news_attempted && input.news_ok === true) return "sent";
  if (input.talk_ok === false || input.news_ok === false) return "failed";
  return "pending";
}

function normalizeTerminalStatus(v: unknown): DispatchAttemptLedgerRow["terminal_status"] {
  return v === "sent" || v === "fallback_sent" || v === "failed" || v === "pending"
    ? v
    : "pending";
}

function boolToDb(v: boolean): number {
  return v ? 1 : 0;
}

function dbBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

function nullableBool(v: unknown): boolean | null {
  if (v == null) return null;
  return dbBool(v);
}

function nullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function nullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseAttempts(v: unknown): unknown[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function addColumnIfMissing(adapter: DbAdapter, sql: string): Promise<void> {
  try {
    await adapter.query(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column|already exists/i.test(msg)) throw err;
  }
}

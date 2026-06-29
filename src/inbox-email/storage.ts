import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type { EmailAliasRow, EmailMessageRow, RegisterEmailAliasInput } from "./types.js";

export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

export function normalizeAliasAddress(raw: string): string {
  const email = normalizeEmailAddress(raw);
  const at = email.indexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const plus = local.indexOf("+");
  return `${plus >= 0 ? local.slice(0, plus) : local}@${domain}`;
}

export async function upsertEmailAlias(
  adapter: DbAdapter,
  input: RegisterEmailAliasInput,
): Promise<EmailAliasRow> {
  const now = (input.now ?? new Date()).toISOString();
  const address = normalizeAliasAddress(input.address);
  const id = `email_alias_${crypto.createHash("sha256").update(`${input.team_id}:${address}`).digest("hex").slice(0, 16)}`;

  await adapter.query(
    `INSERT INTO inbox_email_aliases
       (id, team_id, user_id, address, default_project, default_agent, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(team_id, address) DO UPDATE SET
       user_id = excluded.user_id,
       default_project = excluded.default_project,
       default_agent = excluded.default_agent,
       updated_at = excluded.updated_at`,
    [
      id,
      input.team_id,
      input.user_id,
      address,
      input.default_project ?? null,
      input.default_agent ?? null,
      now,
      now,
    ],
  );

  const row = await getEmailAliasByAddress(adapter, input.team_id, address);
  if (!row) throw new Error(`email alias ${address} was not persisted`);
  return row;
}

export async function getEmailAliasByAddress(
  adapter: DbAdapter,
  teamId: string,
  rawAddress: string,
): Promise<EmailAliasRow | null> {
  const address = normalizeAliasAddress(rawAddress);
  const { rows } = await adapter.query<EmailAliasRow>(
    `SELECT * FROM inbox_email_aliases WHERE team_id = $1 AND address = $2`,
    [teamId, address],
  );
  return rows[0] ?? null;
}

export async function listEmailAliases(adapter: DbAdapter, teamId: string): Promise<EmailAliasRow[]> {
  const { rows } = await adapter.query<EmailAliasRow>(
    `SELECT * FROM inbox_email_aliases WHERE team_id = $1 ORDER BY user_id ASC, address ASC`,
    [teamId],
  );
  return rows;
}

export async function getEmailMessageByKey(
  adapter: DbAdapter,
  key: string,
): Promise<EmailMessageRow | null> {
  const { rows } = await adapter.query<EmailMessageRow>(
    `SELECT * FROM inbox_email_messages WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function insertEmailMessage(adapter: DbAdapter, row: EmailMessageRow): Promise<void> {
  await adapter.query(
    `INSERT INTO inbox_email_messages
       (idempotency_key, team_id, alias_id, inbox_phid, message_id, source_from,
        source_to, source_subject, received_at, triage_action, task_id, dispatch_phid, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.idempotency_key,
      row.team_id,
      row.alias_id,
      row.inbox_phid,
      row.message_id,
      row.source_from,
      row.source_to,
      row.source_subject,
      row.received_at,
      row.triage_action,
      row.task_id,
      row.dispatch_phid,
      row.created_at,
    ],
  );
}

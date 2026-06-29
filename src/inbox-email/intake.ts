import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildTaskRow, draftFromManagerApi } from "../tasks-readmodel/task-draft.js";
import { appendAuditEvent, updateOperatorState, upsertInboxItem, upsertLink } from "../inbox/storage.js";
import type { InboxItemRow } from "../inbox/types.js";
import {
  getEmailAliasByAddress,
  getEmailMessageByKey,
  insertEmailMessage,
  normalizeAliasAddress,
  normalizeEmailAddress,
} from "./storage.js";
import type { EmailAliasRow, EmailIntakeOptions, EmailIntakeResult, ForwardedEmailInput } from "./types.js";

const SYSTEM_ACTOR = "system:chief-of-staff-email-intake";

export async function ingestForwardedEmail(
  adapter: DbAdapter,
  input: ForwardedEmailInput,
  opts: EmailIntakeOptions = {},
): Promise<EmailIntakeResult> {
  const nowDate = opts.now?.() ?? new Date();
  const nowIso = nowDate.toISOString();
  const teamId = input.team_id ?? "default";
  const to = normalizeAliasAddress(input.to);
  const alias = await getEmailAliasByAddress(adapter, teamId, to);
  if (!alias) throw new Error(`No inbound email alias registered for ${to}`);

  const body = normalizeBody(input);
  const subject = cleanHeaderValue(input.subject) || "(no subject)";
  const from = input.from ? normalizeEmailAddress(input.from) : null;
  const receivedAt = input.received_at ?? nowIso;
  const messageId = cleanHeaderValue(input.message_id);
  const idempotencyKey = makeMessageKey(alias, {
    messageId,
    from,
    subject,
    body,
    receivedAt,
  });

  const existing = await getEmailMessageByKey(adapter, idempotencyKey);
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      alias,
      inbox_phid: existing.inbox_phid,
      action: existing.triage_action,
      task_name: existing.task_id,
      dispatch_phid: existing.dispatch_phid,
      query_id: null,
    };
  }

  const route = classifyEmail(alias, subject, body);
  const inboxPhid = `email_${crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
  const item: InboxItemRow = {
    inbox_phid: inboxPhid,
    operator_state: route.action === "dispatch" ? "waiting_on_agent" : route.action === "task" ? "needs_route" : "new",
    source_kind: "email",
    source_external_id: messageId,
    source_text: body,
    source_excerpt: excerpt(body),
    source_subject: subject,
    source_from: from,
    classification_label: route.action === "dispatch" ? "dispatch" : "action",
    classification_confidence: 0.85,
    classification_classifier: "rule",
    classification_rationale: route.reason,
    project_hint: alias.default_project,
    agent_hint: route.agent,
    origin_ref: `email:${alias.address}`,
    received_at: receivedAt,
    triaged_at: nowIso,
    resolved_at: null,
    snoozed_until: null,
    checked_off_at: null,
    checked_off_reason: null,
    source: "reactor",
    parity_status: "ok",
    generated_at: nowIso,
    projection_version: 1,
    legacy_inbox_md_line: null,
    legacy_shadow_path: null,
  };
  await upsertInboxItem(adapter, item);

  let taskName: string | null = null;
  let dispatchPhid: string | null = null;
  let queryId: string | null = null;

  if (route.action === "dispatch" && route.agent && opts.enqueueDispatch) {
    const enq = await opts.enqueueDispatch({
      team_id: alias.team_id,
      to_agent: route.agent,
      from_actor: SYSTEM_ACTOR,
      channel: "email",
      subject,
      message: formatForwardedEmailForDispatch(alias, { from, to, subject, body, receivedAt, inboxPhid }),
      dedup_key: idempotencyKey,
      actor_ref: { kind: "system", id: "chief-of-staff-email-intake", label: "Chief of Staff Email Intake", source: "email" },
      causation: { source_event_id: inboxPhid },
    }, { wake: true });
    dispatchPhid = enq.dispatch_phid;
    queryId = enq.query_id;
    await upsertLink(adapter, inboxPhid, "dispatch", dispatchPhid);
  } else if (opts.tasks) {
    const name = await uniqueTaskName(adapter, alias.team_id, subject);
    const task = buildTaskRow(draftFromManagerApi({
      name,
      team_id: alias.team_id,
      title: subject,
      description: formatForwardedEmailForTask(alias, { from, to, subject, body, receivedAt, inboxPhid }),
      created_by: null,
      owner: null,
      track: alias.default_project ?? "(unassigned)",
    }));
    await opts.tasks.create(task);
    taskName = task.name;
    await upsertLink(adapter, inboxPhid, "task", task.name);
    await updateOperatorState(adapter, inboxPhid, "needs_route");
  }

  const action = dispatchPhid ? "dispatch" : taskName ? "task" : "inbox_only";
  await appendAuditEvent(adapter, {
    inbox_phid: inboxPhid,
    op_id: `${idempotencyKey}:triage`,
    op_type: "EMAIL_TRIAGED",
    actor_id: SYSTEM_ACTOR,
    ts: nowIso,
    reason: route.reason,
    summary: action === "dispatch" ? `Forwarded email dispatched to ${route.agent}` : action === "task" ? `Forwarded email created task ${taskName}` : "Forwarded email recorded in inbox",
    input_revision: idempotencyKey,
    links_json: JSON.stringify([
      ...(taskName ? [{ kind: "task", target: taskName }] : []),
      ...(dispatchPhid ? [{ kind: "dispatch", target: dispatchPhid }] : []),
    ]),
  });
  await insertEmailMessage(adapter, {
    idempotency_key: idempotencyKey,
    team_id: alias.team_id,
    alias_id: alias.id,
    inbox_phid: inboxPhid,
    message_id: messageId,
    source_from: from,
    source_to: to,
    source_subject: subject,
    received_at: receivedAt,
    triage_action: action,
    task_id: taskName,
    dispatch_phid: dispatchPhid,
    created_at: nowIso,
  });

  return { ok: true, idempotent: false, alias, inbox_phid: inboxPhid, action, task_name: taskName, dispatch_phid: dispatchPhid, query_id: queryId };
}

function classifyEmail(alias: EmailAliasRow, subject: string, body: string): { action: "task" | "dispatch"; agent: string | null; reason: string } {
  const explicitAgent = parseAgentDirective(subject) ?? parseAgentDirective(body);
  const agent = explicitAgent ?? alias.default_agent;
  if (agent) {
    return { action: "dispatch", agent, reason: explicitAgent ? "email contained an explicit agent directive" : "alias has a default agent route" };
  }
  return { action: "task", agent: null, reason: "no agent route found; created a task for operator review" };
}

function parseAgentDirective(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 8);
  for (const line of lines) {
    const match =
      line.match(/^\s*(?:agent|to-agent|dispatch-to)\s*:\s*([a-z0-9][a-z0-9._-]*)\s*$/i) ??
      line.match(/\[dispatch\s*:\s*([a-z0-9][a-z0-9._-]*)\]/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function normalizeBody(input: ForwardedEmailInput): string {
  const text = input.text ?? input.html ?? "";
  return text.replace(/\r\n/g, "\n").trim();
}

function cleanHeaderValue(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function makeMessageKey(alias: EmailAliasRow, parts: { messageId: string | null; from: string | null; subject: string; body: string; receivedAt: string }): string {
  if (parts.messageId) return `email:${alias.team_id}:${alias.id}:${parts.messageId}`;
  const digest = crypto
    .createHash("sha256")
    .update([alias.team_id, alias.id, parts.from ?? "", parts.subject, parts.body, parts.receivedAt].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `email:${alias.team_id}:${alias.id}:${digest}`;
}

async function uniqueTaskName(adapter: DbAdapter, teamId: string, subject: string): Promise<string> {
  const base = slugify(subject).slice(0, 72) || "forwarded-email";
  let candidate = base;
  let suffix = 1;
  while (await taskNameExists(adapter, teamId, candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

async function taskNameExists(adapter: DbAdapter, teamId: string, name: string): Promise<boolean> {
  const { rows } = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM tasks WHERE team_id = $1 AND name = $2`,
    [teamId, name],
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function excerpt(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240);
}

function formatForwardedEmailForTask(alias: EmailAliasRow, msg: { from: string | null; to: string; subject: string; body: string; receivedAt: string; inboxPhid: string }): string {
  return [
    `Forwarded to: ${alias.address}`,
    `User route: ${alias.user_id}`,
    `From: ${msg.from ?? "(unknown)"}`,
    `Received: ${msg.receivedAt}`,
    `Inbox: ${msg.inboxPhid}`,
    "",
    msg.body,
  ].join("\n");
}

function formatForwardedEmailForDispatch(alias: EmailAliasRow, msg: { from: string | null; to: string; subject: string; body: string; receivedAt: string; inboxPhid: string }): string {
  return [
    `Forwarded email for ${alias.user_id}`,
    "",
    `Subject: ${msg.subject}`,
    `From: ${msg.from ?? "(unknown)"}`,
    `To: ${msg.to}`,
    `Received: ${msg.receivedAt}`,
    `Inbox: ${msg.inboxPhid}`,
    "",
    msg.body,
  ].join("\n");
}

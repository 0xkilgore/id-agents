// Inbox 2.0 — projection adapter.
// Reads shadow JSON files + inbox.md and projects into read tables.
// Idempotent: safe to re-run; upserts on inbox_phid.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type { InboxItemRow, OperatorState, SourceKind } from './types.js';
import { upsertInboxItem, upsertLink, appendAuditEvent, appendPolicyViolation } from './storage.js';

// ── Shadow JSON projection ──────────────────────────────────────────

interface ShadowDoc {
  id: string;
  documentType: string;
  shadow?: boolean;
  state: {
    global: {
      origin_kind: string;
      origin_ref: string | null;
      received_at: string;
      received_by: string;
      lifecycle_state: string;
      classification: string | null;
      classification_reason: string | null;
      source_subject: string | null;
      source_from: string | null;
      source_text: string | null;
      source_excerpt: string | null;
      source_attachments: any[];
      project_hint: string | null;
      priority_hint: string | null;
      triaged_at: string | null;
      triaged_by: string | null;
      claimed_at: string | null;
      claimed_by: string | null;
      assigned_agent: string | null;
      dispatch_id: string | null;
      query_id: string | null;
      started_at: string | null;
      done_at: string | null;
      artifact_path: string | null;
      artifact_tl_dr: string | null;
      shadow_refs: Record<string, string>;
      external_refs: Record<string, string>;
      last_error_code: string | null;
      last_error_message: string | null;
      last_error_at: string | null;
    };
  };
}

function mapOperatorState(shadow: ShadowDoc): OperatorState {
  const s = shadow.state.global;
  if (s.last_error_code) return 'errored';
  if (s.done_at && s.artifact_path) return 'output_ready';
  if (s.done_at) return 'checked_off';
  if (s.assigned_agent || s.dispatch_id) return 'waiting_on_agent';
  if (s.triaged_at) return 'needs_route';
  if (s.lifecycle_state === 'received') return 'new';
  return 'new';
}

function mapSourceKind(kind: string): SourceKind {
  const mapping: Record<string, SourceKind> = {
    email: 'email',
    telegram: 'telegram',
    voice: 'voice_note',
    voice_note: 'voice_note',
    photo: 'manual_capture',
    manual: 'manual_capture',
    forwarded_instruction: 'forwarded_instruction',
    api: 'api',
  };
  return mapping[kind] ?? 'manual_capture';
}

export async function projectShadowJson(adapter: DbAdapter, shadowDir: string): Promise<{
  projected: number;
  skipped: number;
  errors: string[];
}> {
  const result = { projected: 0, skipped: 0, errors: [] as string[] };
  if (!existsSync(shadowDir)) return result;

  const files = readdirSync(shadowDir).filter(f => f.endsWith('.json'));
  const now = new Date().toISOString();

  for (const file of files) {
    try {
      const raw = readFileSync(join(shadowDir, file), 'utf8');
      const doc = JSON.parse(raw) as ShadowDoc;
      const s = doc.state.global;

      const row: InboxItemRow = {
        inbox_phid: doc.id,
        operator_state: mapOperatorState(doc),
        source_kind: mapSourceKind(s.origin_kind),
        source_external_id: s.origin_ref,
        source_text: s.source_text,
        source_excerpt: s.source_excerpt,
        source_subject: s.source_subject,
        source_from: s.source_from,
        classification_label: s.classification !== 'unknown' ? s.classification : null,
        classification_confidence: null,
        classification_classifier: null,
        classification_rationale: s.classification_reason,
        project_hint: s.project_hint,
        agent_hint: s.assigned_agent,
        origin_ref: s.origin_ref,
        received_at: s.received_at,
        triaged_at: s.triaged_at,
        resolved_at: s.done_at,
        snoozed_until: null,
        checked_off_at: s.done_at,
        checked_off_reason: null,
        source: 'index',
        parity_status: 'ok',
        generated_at: now,
        projection_version: 1,
        legacy_inbox_md_line: null,
        legacy_shadow_path: join(shadowDir, file),
      };

      await upsertInboxItem(adapter, row);

      if (s.dispatch_id) {
        await upsertLink(adapter, doc.id, 'dispatch', s.dispatch_id);
      }
      if (s.query_id) {
        await upsertLink(adapter, doc.id, 'dispatch', s.query_id);
      }
      if (s.artifact_path) {
        await upsertLink(adapter, doc.id, 'artifact', s.artifact_path);
      }

      await appendAuditEvent(adapter, {
        inbox_phid: doc.id,
        op_id: `proj-shadow-${file}`,
        op_type: 'PROJECTION_IMPORT',
        actor_id: 'system:projection',
        ts: now,
        reason: null,
        summary: `Projected from shadow JSON ${file}`,
        input_revision: createHash('sha256').update(raw).digest('hex').slice(0, 16),
        links_json: null,
      });

      result.projected++;
    } catch (err) {
      result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
    }
  }

  return result;
}

// ── inbox.md line projection ──────────────────────────────────────────

interface ParsedInboxLine {
  checked: boolean;
  date: string;
  channel: string | null;
  tag: string | null;
  text: string;
  resolution: string | null;
  raw: string;
  lineHash: string;
  bucket: string | null;
}

export function parseInboxMdLine(line: string): ParsedInboxLine | null {
  const match = line.match(
    /^- \[([ x])\] \[([^\]]+)\]\s*(?:\[([^\]]+)\])?\s*(?:#(\w+))?\s*(?:—\s*)?(.*)$/,
  );
  if (!match) return null;

  const [, check, date, channel, tag, rest] = match;
  const parts = rest.split(/\s*→\s*/);
  const text = parts[0]?.trim() ?? '';
  const resolution = parts[1]?.trim() ?? null;

  return {
    checked: check === 'x',
    date: date.trim(),
    channel: channel?.trim() ?? null,
    tag: tag?.trim() ?? null,
    text,
    resolution,
    raw: line,
    lineHash: createHash('sha256').update(line).digest('hex').slice(0, 16),
    bucket: null,
  };
}

function inferSourceKind(channel: string | null): SourceKind {
  if (channel === 'email') return 'email';
  if (channel === 'telegram') return 'telegram';
  if (channel === 'voice') return 'voice_note';
  if (channel === 'photo') return 'manual_capture';
  return 'manual_capture';
}

function inferOperatorStateFromMd(parsed: ParsedInboxLine): OperatorState {
  if (parsed.checked) return 'checked_off';
  return 'new';
}

function inferClassification(tag: string | null): string | null {
  const mapping: Record<string, string> = {
    task: 'action',
    link: 'reference',
    note: 'idea',
    instruction: 'action',
    actionable: 'action',
    personal: 'reference',
    newsletter: 'reference',
    notification: 'reference',
    expense_receipt: 'reference',
  };
  return tag ? (mapping[tag] ?? null) : null;
}

function normalizeDate(dateStr: string): string {
  const cleaned = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(cleaned)) {
    return new Date(cleaned.replace(' ', 'T') + ':00.000Z').toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return new Date(cleaned + 'T00:00:00.000Z').toISOString();
  }
  return cleaned;
}

export async function projectInboxMd(adapter: DbAdapter, inboxMdPath: string): Promise<{
  projected: number;
  skipped: number;
  errors: string[];
  currentBucket: string | null;
}> {
  const result = { projected: 0, skipped: 0, errors: [] as string[], currentBucket: null as string | null };
  if (!existsSync(inboxMdPath)) return result;

  const content = readFileSync(inboxMdPath, 'utf8');
  const lines = content.split('\n');
  const now = new Date().toISOString();
  let currentBucket: string | null = null;

  for (const line of lines) {
    const bucketMatch = line.match(/^## (.+)/);
    if (bucketMatch) {
      currentBucket = bucketMatch[1].trim();
      continue;
    }

    const parsed = parseInboxMdLine(line);
    if (!parsed) continue;

    parsed.bucket = currentBucket;

    const phid = `inbox-md-${parsed.lineHash}`;
    const row: InboxItemRow = {
      inbox_phid: phid,
      operator_state: inferOperatorStateFromMd(parsed),
      source_kind: inferSourceKind(parsed.channel),
      source_external_id: null,
      source_text: parsed.text,
      source_excerpt: parsed.text.slice(0, 200),
      source_subject: null,
      source_from: null,
      classification_label: inferClassification(parsed.tag),
      classification_confidence: null,
      classification_classifier: parsed.tag ? 'import' : null,
      classification_rationale: parsed.tag ? `Inferred from #${parsed.tag} tag` : null,
      project_hint: null,
      agent_hint: null,
      origin_ref: null,
      received_at: normalizeDate(parsed.date),
      triaged_at: parsed.checked ? normalizeDate(parsed.date) : null,
      resolved_at: parsed.checked ? normalizeDate(parsed.date) : null,
      snoozed_until: null,
      checked_off_at: parsed.checked ? normalizeDate(parsed.date) : null,
      checked_off_reason: parsed.resolution,
      source: 'index',
      parity_status: 'ok',
      generated_at: now,
      projection_version: 1,
      legacy_inbox_md_line: line,
      legacy_shadow_path: null,
    };

    try {
      await upsertInboxItem(adapter, row);

      if (parsed.resolution) {
        if (/dispatched?\s+to/i.test(parsed.resolution)) {
          const agentMatch = parsed.resolution.match(/dispatched?\s+to\s+(\w+)/i);
          if (agentMatch) {
            await upsertLink(adapter, phid, 'dispatch', agentMatch[1]);
          }
        }
        if (/saved?\s+to\s+/i.test(parsed.resolution)) {
          const pathMatch = parsed.resolution.match(/saved?\s+to\s+([^\s(]+)/i);
          if (pathMatch) {
            await upsertLink(adapter, phid, 'filed', pathMatch[1]);
          }
        }
        if (/added?\s+to\s+/i.test(parsed.resolution) && !parsed.resolution.includes('to-do')) {
          const pathMatch = parsed.resolution.match(/added?\s+to\s+([^\s(]+)/i);
          if (pathMatch) {
            await upsertLink(adapter, phid, 'filed', pathMatch[1]);
          }
        }
      }

      result.projected++;
    } catch (err) {
      result.errors.push(`line "${line.slice(0, 60)}...": ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
    }
  }

  result.currentBucket = currentBucket;
  return result;
}

// ── Parity check ──

export interface ParityReport {
  shadow_count: number;
  inbox_md_count: number;
  matched: number;
  shadow_only: string[];
  inbox_md_only: string[];
  drift_detected: string[];
  policy_violations: { phid: string; kind: string; message: string }[];
}

export async function checkParity(adapter: DbAdapter): Promise<ParityReport> {
  const { rows: shadowItems } = await adapter.query<{ inbox_phid: string }>(
    "SELECT inbox_phid FROM inbox_items WHERE legacy_shadow_path IS NOT NULL",
    [],
  );

  const { rows: mdItems } = await adapter.query<{ inbox_phid: string }>(
    "SELECT inbox_phid FROM inbox_items WHERE legacy_inbox_md_line IS NOT NULL",
    [],
  );

  const shadowPhids = new Set(shadowItems.map(r => r.inbox_phid));
  const mdPhids = new Set(mdItems.map(r => r.inbox_phid));

  const report: ParityReport = {
    shadow_count: shadowPhids.size,
    inbox_md_count: mdPhids.size,
    matched: 0,
    shadow_only: [...shadowPhids],
    inbox_md_only: [...mdPhids],
    drift_detected: [],
    policy_violations: [],
  };

  const { rows: newButChecked } = await adapter.query<{ inbox_phid: string }>(
    "SELECT inbox_phid FROM inbox_items WHERE operator_state = 'new' AND checked_off_at IS NOT NULL",
    [],
  );

  for (const { inbox_phid } of newButChecked) {
    report.policy_violations.push({
      phid: inbox_phid,
      kind: 'state_inconsistency',
      message: 'Item marked as new but has checked_off_at set',
    });
    report.drift_detected.push(inbox_phid);
  }

  return report;
}

// ── Run full projection ──

export async function runFullProjection(
  adapter: DbAdapter,
  shadowDir: string,
  inboxMdPath: string,
): Promise<{ shadow: Awaited<ReturnType<typeof projectShadowJson>>; inboxMd: Awaited<ReturnType<typeof projectInboxMd>>; parity: ParityReport }> {
  const shadow = await projectShadowJson(adapter, shadowDir);
  const inboxMd = await projectInboxMd(adapter, inboxMdPath);
  const parity = await checkParity(adapter);
  return { shadow, inboxMd, parity };
}

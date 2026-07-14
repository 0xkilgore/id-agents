import type { EventsRepository } from "../db/db-service.js";
import { deliverClarificationResume } from "./clarification-resume-delivery.js";
import type { SqliteDispatchReactor } from "./sqlite-dispatch-reactor.js";
import type { DispatchDoc } from "./types.js";

const RECEIPT_TOPIC = "dispatch:clarification_ttl_reconciled";
const RECEIPT_SCHEMA = "dispatch.clarification_ttl_reconciled.v1";
const DEFAULT_ACTOR = "manager:clarification-ttl-reconciler";

export type ClarificationTtlReconcileItem = {
  dispatch_id: string;
  clarification_id: string;
  action: "auto_resumed" | "needs_chris" | "skipped_already_surfaced" | "resume_delivery_failed";
  blocker: string;
  recommended_option: string | null;
  delivered_to_agent?: boolean;
  agent_query_id?: string | null;
  failure_detail?: string | null;
  event_seq?: number | null;
};

export type ClarificationTtlReconcileResult = {
  scanned: number;
  auto_resumed: number;
  needs_chris: number;
  skipped_already_surfaced: number;
  resume_delivery_failed: number;
  dry_run: boolean;
  items: ClarificationTtlReconcileItem[];
};

type ReadyResumePayload = {
  answer: string;
  actor: string;
  instructions: string | string[] | null;
  recommended_option: string | null;
};

export async function reconcileStaleClarifications(input: {
  reactor: SqliteDispatchReactor;
  events?: EventsRepository | null;
  teamId: string;
  resolveEndpoint: (agentName: string) => Promise<string | null>;
  nowMs?: number;
  nowIso?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<ClarificationTtlReconcileResult> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = input.nowIso ?? new Date(nowMs).toISOString();
  const dryRun = input.dryRun === true;
  const stale = await input.reactor.listOpenClarifications({
    staleOnly: true,
    now: nowIso,
    limit: input.limit,
  });
  const result: ClarificationTtlReconcileResult = {
    scanned: stale.length,
    auto_resumed: 0,
    needs_chris: 0,
    skipped_already_surfaced: 0,
    resume_delivery_failed: 0,
    dry_run: dryRun,
    items: [],
  };

  for (const doc of stale) {
    const blocker = doc.active_clarification;
    if (!blocker) continue;
    const clarificationId = blocker.clarification_id;
    const blockerText = exactBlocker(doc);
    const ready = extractReadyResumePayload(blocker.context);

    if (ready) {
      if (dryRun) {
        result.auto_resumed += 1;
        result.items.push({
          dispatch_id: doc.dispatch_phid,
          clarification_id: clarificationId,
          action: "auto_resumed",
          blocker: blockerText,
          recommended_option: ready.recommended_option,
          delivered_to_agent: false,
          event_seq: null,
        });
        continue;
      }

      const delivered = await deliverClarificationResume({
        reactor: input.reactor,
        resolveEndpoint: input.resolveEndpoint,
        dispatchPhid: doc.dispatch_phid,
        answer: ready.answer,
        actor: ready.actor,
        clarificationId,
        instructions: ready.instructions,
      });
      const action = delivered.delivered ? "auto_resumed" : "resume_delivery_failed";
      const receipt = await emitReceipt(input.events, {
        teamId: input.teamId,
        nowMs,
        actor: ready.actor,
        doc,
        clarificationId,
        action,
        blocker: blockerText,
        recommendedOption: ready.recommended_option,
        deliveredToAgent: delivered.delivered,
        agentQueryId: delivered.agent_query_id,
        failureDetail: delivered.failure_detail,
      });
      if (delivered.delivered) result.auto_resumed += 1;
      else result.resume_delivery_failed += 1;
      result.items.push({
        dispatch_id: doc.dispatch_phid,
        clarification_id: clarificationId,
        action,
        blocker: blockerText,
        recommended_option: ready.recommended_option,
        delivered_to_agent: delivered.delivered,
        agent_query_id: delivered.agent_query_id,
        failure_detail: delivered.failure_detail,
        event_seq: receipt?.seq ?? null,
      });
      continue;
    }

    if (hasCurrentStaleSurface(doc, clarificationId)) {
      result.skipped_already_surfaced += 1;
      result.items.push({
        dispatch_id: doc.dispatch_phid,
        clarification_id: clarificationId,
        action: "skipped_already_surfaced",
        blocker: blockerText,
        recommended_option: extractRecommendedOption(blocker.context),
        event_seq: null,
      });
      continue;
    }

    if (!dryRun) {
      await input.reactor.markClarificationStale(doc.dispatch_phid, {
        clarification_id: clarificationId,
        age_seconds: ageSeconds(blocker.created_at, nowMs),
      });
    }
    const receipt = dryRun
      ? null
      : await emitReceipt(input.events, {
        teamId: input.teamId,
        nowMs,
        actor: DEFAULT_ACTOR,
        doc,
        clarificationId,
        action: "needs_chris",
        blocker: blockerText,
        recommendedOption: extractRecommendedOption(blocker.context),
      });
    result.needs_chris += 1;
    result.items.push({
      dispatch_id: doc.dispatch_phid,
      clarification_id: clarificationId,
      action: "needs_chris",
      blocker: blockerText,
      recommended_option: extractRecommendedOption(blocker.context),
      event_seq: receipt?.seq ?? null,
    });
  }

  return result;
}

export function extractReadyResumePayload(context: unknown): ReadyResumePayload | null {
  const system = objectAt(context, "system");
  const payload =
    objectAt(context, "ready_resume_payload") ??
    objectAt(context, "resume_payload") ??
    objectAt(system, "ready_resume_payload") ??
    objectAt(system, "resume_payload");
  if (!payload) return null;
  const recommended = extractRecommendedOption(context);
  const answer = firstString(payload.answer, payload.manager_answer, payload.response, recommended);
  if (!answer) return null;
  return {
    answer,
    actor: firstString(payload.actor, payload.from) ?? DEFAULT_ACTOR,
    instructions: stringOrStringArray(payload.instructions),
    recommended_option: recommended,
  };
}

function extractRecommendedOption(context: unknown): string | null {
  const system = objectAt(context, "system");
  return firstString(
    objectAt(context)?.recommended_option,
    objectAt(context)?.recommendedOption,
    system?.recommended_option,
    system?.recommendedOption,
  );
}

function exactBlocker(doc: DispatchDoc): string {
  const blocker = doc.active_clarification;
  const question = blocker?.question?.trim() || "clarification required";
  const context = blocker?.context == null ? "" : ` context=${stableStringify(blocker.context)}`;
  return `${question}${context}`;
}

function hasCurrentStaleSurface(doc: DispatchDoc, clarificationId: string): boolean {
  return doc.clarification_history.some(
    (event) => event.type === "CLARIFICATION_STALE" && event.clarification_id === clarificationId,
  );
}

function ageSeconds(createdAt: string, nowMs: number): number {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / 1000));
}

async function emitReceipt(
  events: EventsRepository | null | undefined,
  input: {
    teamId: string;
    nowMs: number;
    actor: string;
    doc: DispatchDoc;
    clarificationId: string;
    action: ClarificationTtlReconcileItem["action"];
    blocker: string;
    recommendedOption: string | null;
    deliveredToAgent?: boolean;
    agentQueryId?: string | null;
    failureDetail?: string | null;
  },
): Promise<{ seq: number } | null> {
  if (!events) return null;
  return events.insert({
    team_id: input.teamId,
    topic: RECEIPT_TOPIC,
    actor_agent_id: input.actor,
    subject_kind: "dispatch",
    subject_id: input.doc.dispatch_phid,
    occurred_at: input.nowMs,
    data: {
      schema_version: RECEIPT_SCHEMA,
      dispatch_id: input.doc.dispatch_phid,
      query_id: input.doc.query_id,
      clarification_id: input.clarificationId,
      action: input.action,
      blocker: input.blocker,
      recommended_option: input.recommendedOption,
      delivered_to_agent: input.deliveredToAgent ?? null,
      agent_query_id: input.agentQueryId ?? null,
      failure_detail: input.failureDetail ?? null,
    },
  });
}

function objectAt(value: unknown, key?: string): Record<string, unknown> | null {
  const base = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!base || !key) return base;
  const child = base[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? child as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stringOrStringArray(value: unknown): string | string[] | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const strings = value
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim());
    return strings.length > 0 ? strings : null;
  }
  return null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

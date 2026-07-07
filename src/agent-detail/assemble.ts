// Agent detail v2 (T-CKPT.agent-v2) — best-effort assembly of the raw data the
// pure builder shapes. Each source is independently try/caught so a single
// missing/erroring source (e.g. usage tables absent on a fresh DB) degrades to
// empty/zero rather than failing the whole endpoint. The shaping itself lives in
// `buildAgentDetail` (pure, unit-tested).

import fs from "node:fs";
import path from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import { listArtifactCatalog } from "../outputs/storage.js";
import { listLoops } from "../loops/registry.js";
import { getRuntimePaths } from "../runtime/registry.js";
import type { AgentCatalog } from "../config-parser.js";
import {
  buildAgentDetail,
  type AgentDetailResponse,
  type DetailCommentReceiptRow,
  type DetailLoopRow,
  type DetailDispatchRow,
  type TokenSeriesPoint,
  RECENT_OUTPUT_LIMIT,
} from "./build.js";

export interface AssembleOpts {
  teamId: string;
  /** Agent name (artifacts/loops/dispatch attribution key). */
  name: string;
  /** Additional historical/current attribution keys (alias, requested name, project basename). */
  attributionNames?: string[];
  /** Agent row id (tasks.owner / usage attribution key). */
  agentId: string;
  runtime: string;
  workingDirectory: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Injectable clock for the token window math (ISO). */
  nowIso: string;
  /** AP6 — the agent's stored catalog (metadata.catalog), or null if absent. */
  catalog?: AgentCatalog | null;
}

const TOKEN_SERIES_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function assembleAgentDetail(
  adapter: DbAdapter,
  opts: AssembleOpts,
): Promise<AgentDetailResponse> {
  const { teamId, name, agentId, runtime, workingDirectory } = opts;
  const attributionNames = normalizeAttributionNames([
    name,
    ...(opts.attributionNames ?? []),
    workingDirectory ? path.basename(workingDirectory) : null,
  ]);

  const tasks = await safe(async () => {
    const { rows } = await adapter.query<{ status: string }>(
      `SELECT status FROM tasks WHERE team_id = $1 AND owner = $2`,
      [teamId, agentId],
    );
    return rows.map((r) => ({ status: r.status }));
  }, [] as Array<{ status: string }>);

  const now = new Date(opts.nowIso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const windowStart = startOfToday - (TOKEN_SERIES_DAYS - 1) * DAY_MS;

  const tokens_today = await safe(async () => {
    const { rows } = await adapter.query<{ w: number }>(
      `SELECT COALESCE(SUM(weighted_tokens), 0) AS w FROM agent_usage_event
        WHERE agent_id IN ($1, $2) AND ts >= $3`,
      [name, agentId, startOfToday],
    );
    return Number(rows[0]?.w ?? 0);
  }, 0);

  const token_series = await safe(async () => {
    const { rows } = await adapter.query<{ d: string; w: number }>(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS d,
              COALESCE(SUM(weighted_tokens), 0) AS w
         FROM agent_usage_event
        WHERE agent_id IN ($1, $2) AND ts >= $3
        GROUP BY d ORDER BY d`,
      [name, agentId, windowStart],
    );
    return rows.map((r): TokenSeriesPoint => ({ date: r.d, weighted: Number(r.w) }));
  }, [] as TokenSeriesPoint[]);

  const failed_dispatches = await safe(async () => {
    const { rows } = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM dispatch_scheduler_queue
        WHERE team_id = ? AND to_agent IN (${placeholders(attributionNames.length)}) AND status IN ('bounced', 'failed')`,
      [teamId, ...attributionNames],
    );
    return Number(rows[0]?.c ?? 0);
  }, 0);

  const recent_outputs = await safe(async () => {
    const rows = await Promise.all(
      attributionNames.map((agent) => listArtifactCatalog(adapter, { agent, limit: RECENT_OUTPUT_LIMIT })),
    );
    return rows.flat().map((a) => ({
      artifact_id: a.artifact_id,
      basename: a.basename,
      title: a.title ?? null,
      tag: a.tag ?? null,
      abs_path: a.abs_path,
      produced_at: a.produced_at,
    }));
  }, [] as AgentDetailResponse["recent_outputs"]);

  const recent_dispatches = await safe(async () => {
    const { rows } = await adapter.query<{
      dispatch_id: string;
      query_id: string | null;
      agent_name: string;
      status: string;
      verified: number;
      artifact_path: string | null;
      artifact_exists: number | null;
      artifact_mtime: string | null;
      dispatch_status: string;
      dispatch_created_at: string;
      dispatch_completed_at: string | null;
      tl_dr: string | null;
      kind: string;
    }>(
      `SELECT dispatch_id, query_id, agent_name, status, verified, artifact_path,
              artifact_exists, artifact_mtime, dispatch_status, dispatch_created_at,
              dispatch_completed_at, tl_dr, kind
         FROM dispatch_verifications
        WHERE team_id = ?
          AND agent_name IN (${placeholders(attributionNames.length)})
          AND dispatch_completed_at IS NOT NULL
        ORDER BY dispatch_completed_at DESC, dispatch_id
        LIMIT ?`,
      [teamId, ...attributionNames, RECENT_OUTPUT_LIMIT],
    );
    return rows.map(
      (r): DetailDispatchRow => ({
        dispatch_id: r.dispatch_id,
        query_id: r.query_id,
        time: r.dispatch_completed_at ?? r.dispatch_created_at,
        subject: r.tl_dr ?? "",
        dispatch_status: r.dispatch_status,
        verification_status: r.status,
        verified: r.verified !== 0,
        artifact_path: r.artifact_path,
        artifact_exists: r.artifact_exists == null ? null : r.artifact_exists !== 0,
        artifact_mtime: r.artifact_mtime,
        tl_dr: r.tl_dr,
        kind: r.kind,
        attributed_agent: r.agent_name,
      }),
    );
  }, [] as DetailDispatchRow[]);

  const recent_comment_receipts = await safe(async () => {
    const { rows } = await adapter.query<{
      op_id: number;
      artifact_id: string;
      actor: string;
      ts: string;
      payload_json: string | null;
      artifact_title: string | null;
      artifact_basename: string | null;
      artifact_agent: string | null;
    }>(
      `SELECT o.op_id, o.artifact_id, o.actor, o.ts, o.payload_json,
              a.title AS artifact_title, a.basename AS artifact_basename, a.agent AS artifact_agent
         FROM artifact_operations o
         LEFT JOIN artifacts a ON a.artifact_id = o.artifact_id
        WHERE o.op_type = 'comment_recorded'
        ORDER BY o.ts DESC, o.op_id DESC
        LIMIT 500`,
    );
    const receipts: DetailCommentReceiptRow[] = [];
    for (const row of rows) {
      const receipt = commentReceiptFromOperation(row, attributionNames);
      if (receipt) receipts.push(receipt);
      if (receipts.length >= RECENT_OUTPUT_LIMIT) break;
    }
    return receipts;
  }, [] as DetailCommentReceiptRow[]);

  const loops = await safe(async () => {
    const resp = listLoops(opts.nowIso, { owner_agent: name });
    return resp.loops.map(
      (l): DetailLoopRow => ({
        slug: l.slug,
        name: l.name,
        kind: l.kind,
        enabled: l.enabled,
        health_state: l.health.state,
        schedule_label: l.schedule_label,
      }),
    );
  }, [] as DetailLoopRow[]);

  const skills = listDirNames(skillsDirFor(workingDirectory, runtime));
  const scripts = listScriptNames(workingDirectory);

  return buildAgentDetail({
    name,
    now_iso: opts.nowIso,
    consecutive_failures: opts.consecutiveFailures,
    last_error: opts.lastError,
    tasks,
    tokens_today,
    token_series,
    failed_dispatches,
    recent_outputs,
    recent_dispatches,
    recent_comment_receipts,
    skills,
    loops,
    scripts,
    catalog: opts.catalog ?? null,
  });
}

export function normalizeAttributionNames(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : ["unknown"];
}

function placeholders(count: number): string {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(",");
}

function commentReceiptFromOperation(
  row: {
    op_id: number;
    artifact_id: string;
    actor: string;
    ts: string;
    payload_json: string | null;
    artifact_title: string | null;
    artifact_basename: string | null;
    artifact_agent: string | null;
  },
  attributionNames: string[],
): DetailCommentReceiptRow | null {
  const payload = parseObject(row.payload_json);
  const routeStatus = parseObject(payload.route_status);
  const visibleState = stringValue(routeStatus.visible_state);
  if (
    visibleState !== "recorded+routed" &&
    visibleState !== "recorded-but-route-failed-with-retry" &&
    visibleState !== "not-recorded"
  ) {
    return null;
  }
  const routeKind = stringValue(routeStatus.route_kind);
  if (routeKind !== "approval_signal" && routeKind !== "substantive_follow_up" && routeKind !== "question") {
    return null;
  }

  const dispatch = parseObject(routeStatus.dispatch);
  const targetAgent = stringValue(routeStatus.target_agent);
  const targetAgentRaw = stringValue(routeStatus.target_agent_raw);
  const candidates = [
    targetAgent,
    targetAgentRaw,
    row.artifact_agent,
    projectOwnerName(targetAgentRaw),
    projectOwnerName(row.artifact_agent),
  ];
  if (!matchesAttribution(candidates, attributionNames)) return null;

  const retryable = routeStatus.retryable === true;
  const skipped = stringValue(routeStatus.skipped);
  const error = parseObject(routeStatus.error);
  const errorMessage = stringValue(error.message);
  const dispatchId = stringValue(dispatch.dispatch_phid);
  const queryId = stringValue(dispatch.query_id);
  const updatedAt = stringValue(routeStatus.updated_at);
  const routeStatusLabel =
    visibleState === "recorded+routed"
      ? "routed"
      : visibleState === "recorded-but-route-failed-with-retry"
        ? "recorded-but-route-failed"
        : "not-recorded";

  return {
    receipt_id: `artifact-comment-receipt:${row.artifact_id}:${row.op_id}`,
    artifact_id: row.artifact_id,
    artifact_title: row.artifact_title,
    artifact_basename: row.artifact_basename,
    actor: row.actor,
    time: updatedAt || row.ts,
    route_status: routeStatusLabel,
    visible_state: visibleState,
    retryable,
    route_kind: routeKind,
    target_agent: targetAgent,
    target_agent_raw: targetAgentRaw,
    dispatch_id: dispatchId,
    query_id: queryId,
    failure_reason: errorMessage ?? skipped,
    retry_metadata: {
      retryable,
      skipped,
      error: errorMessage ? { message: errorMessage } : null,
      updated_at: updatedAt,
    },
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectOwnerName(value: string | null | undefined): string | null {
  const match = value?.match(/^project:\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

function matchesAttribution(values: Array<string | null | undefined>, attributionNames: string[]): boolean {
  const wanted = new Set(attributionNames.map((v) => v.toLowerCase()));
  return values.some((value) => {
    const normalized = value?.trim().toLowerCase();
    return normalized ? wanted.has(normalized) : false;
  });
}

/** Resolve the agent's runtime-specific skills dir (e.g. <wd>/.claude/skills). */
function skillsDirFor(workingDirectory: string | null, runtime: string): string | null {
  if (!workingDirectory) return null;
  try {
    return path.join(workingDirectory, getRuntimePaths(runtime).skillsDir);
  } catch {
    return null;
  }
}

/** Names of immediate entries (skill folders/files) in a dir; [] if absent. */
function listDirNames(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Script files under <wd>/scripts or <wd>/tools (.sh/.py/.ts/.js); [] if none. */
function listScriptNames(workingDirectory: string | null): string[] {
  if (!workingDirectory) return [];
  const out = new Set<string>();
  for (const sub of ["scripts", "tools"]) {
    try {
      for (const e of fs.readdirSync(path.join(workingDirectory, sub), { withFileTypes: true })) {
        if (e.isFile() && /\.(sh|py|ts|js|mjs)$/.test(e.name)) out.add(e.name);
      }
    } catch {
      /* dir absent — skip */
    }
  }
  return [...out].sort();
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

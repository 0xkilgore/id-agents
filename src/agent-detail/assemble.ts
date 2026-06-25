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
  type DetailLoopRow,
  type TokenSeriesPoint,
  RECENT_OUTPUT_LIMIT,
} from "./build.js";

export interface AssembleOpts {
  teamId: string;
  /** Agent name (artifacts/loops/dispatch attribution key). */
  name: string;
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
        WHERE team_id = $1 AND to_agent = $2 AND status IN ('bounced', 'failed')`,
      [teamId, name],
    );
    return Number(rows[0]?.c ?? 0);
  }, 0);

  const recent_outputs = await safe(async () => {
    const cat = await listArtifactCatalog(adapter, { agent: name, limit: RECENT_OUTPUT_LIMIT });
    return cat.map((a) => ({
      artifact_id: a.artifact_id,
      basename: a.basename,
      title: a.title ?? null,
      tag: a.tag ?? null,
      abs_path: a.abs_path,
      produced_at: a.produced_at,
    }));
  }, [] as AgentDetailResponse["recent_outputs"]);

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
    consecutive_failures: opts.consecutiveFailures,
    last_error: opts.lastError,
    tasks,
    tokens_today,
    token_series,
    failed_dispatches,
    recent_outputs,
    skills,
    loops,
    scripts,
    catalog: opts.catalog ?? null,
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

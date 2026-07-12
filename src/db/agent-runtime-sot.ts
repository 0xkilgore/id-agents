// Runtime Work-Share Slice 1 (§3) — runtime source-of-truth normalization.
//
// Problem: an agent's runtime lives in two places — the canonical
// `agents.runtime` COLUMN and an informational `metadata.runtime` COPY. They
// diverge when one is written without the other (the CTO/Regina/Rams bug).
//
// Fix: the COLUMN is the single source of truth. `metadata.runtime` is DERIVED
// from it at read time (so the API can never emit divergent values), and a
// one-time idempotent reconcile rewrites persisted metadata to match. No routing
// or runtime-selection behavior changes — this is the SoT bug fix only.

import type { DbAdapter } from "./db-adapter.js";

/**
 * Return the agent metadata with `runtime` derived from the canonical column,
 * so a read can never surface a `metadata.runtime` that disagrees with the
 * top-level runtime. Non-object metadata (null/legacy) is passed through
 * unchanged — there is no `metadata.runtime` to diverge in that case.
 */
export interface RuntimeUsageTruth {
  actualRuntime: string;
  actualModel: string;
  catalogDesiredModel: string | null;
  catalogModelStale: boolean;
  usageTelemetry: {
    provider: "anthropic" | "openai" | "cursor" | "local" | "other";
    source: "claude_cli_external" | "codex_cli" | "cursor_cli" | "remote_endpoint" | "runtime_meter";
    authoritativeFields: ["runtime", "model"];
  };
}

export function sanitizeCatalogRuntimeTruth(catalog: unknown): unknown {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return catalog;
  const next = { ...(catalog as Record<string, unknown>) };
  if (typeof next.model === "string" && next.model.trim()) {
    next.desiredModel ??= next.model;
    delete next.model;
  }
  return next;
}

function providerForRuntime(runtime: string): RuntimeUsageTruth["usageTelemetry"]["provider"] {
  if (runtime === "claude-code-cli" || runtime === "claude-code-local" || runtime === "claude-agent-sdk") return "anthropic";
  if (runtime === "codex") return "openai";
  if (runtime === "cursor-cli") return "cursor";
  if (runtime === "public-agent-remote") return "other";
  return "other";
}

function usageSourceForRuntime(runtime: string): RuntimeUsageTruth["usageTelemetry"]["source"] {
  if (runtime === "claude-code-cli" || runtime === "claude-code-local") return "claude_cli_external";
  if (runtime === "codex") return "codex_cli";
  if (runtime === "cursor-cli") return "cursor_cli";
  if (runtime === "public-agent-remote") return "remote_endpoint";
  return "runtime_meter";
}

export function buildRuntimeUsageTruth(input: {
  runtime: string;
  model: string;
  metadata: unknown;
}): RuntimeUsageTruth {
  const catalog = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? (input.metadata as Record<string, unknown>).catalog
    : undefined;
  const catalogDesiredModel = catalog && typeof catalog === "object" && !Array.isArray(catalog)
    ? typeof (catalog as Record<string, unknown>).desiredModel === "string"
      ? (catalog as Record<string, string>).desiredModel
      : typeof (catalog as Record<string, unknown>).model === "string"
        ? (catalog as Record<string, string>).model
        : null
    : null;

  return {
    actualRuntime: input.runtime,
    actualModel: input.model,
    catalogDesiredModel,
    catalogModelStale: !!catalogDesiredModel && catalogDesiredModel !== input.model,
    usageTelemetry: {
      provider: providerForRuntime(input.runtime),
      source: usageSourceForRuntime(input.runtime),
      authoritativeFields: ["runtime", "model"],
    },
  };
}

export function deriveMetadataWithRuntime(metadata: unknown, runtime: string, model = ""): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }
  const out: Record<string, unknown> = { ...(metadata as Record<string, unknown>), runtime };
  const catalog = out.catalog;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    out.catalog = sanitizeCatalogRuntimeTruth(catalog);
  }
  out.runtimeUsageTruth = buildRuntimeUsageTruth({ runtime, model, metadata: out });
  return out;
}

export interface ReconcileAgentRuntimeResult {
  /** Rows whose persisted metadata.runtime now equals the canonical column. */
  reconciled: number;
  /** Rows that already agreed (no write needed) — proves idempotency. */
  already_consistent: number;
  scanned: number;
}

export interface ReconcileCatalogModelResult {
  /** Rows where metadata.catalog.model was moved to metadata.catalog.desiredModel. */
  reconciled: number;
  already_consistent: number;
  stale_desired_model: number;
  scanned: number;
}

interface AgentRuntimeRow {
  id: string;
  runtime: string | null;
  metadata: string | null;
}

/**
 * One-time, idempotent reconcile: set `metadata.runtime := runtime` for every
 * live agent so persisted copies match the canonical column. Safe to run
 * repeatedly — a second run reconciles 0 rows. Scoped to a team when given.
 *
 * Done in app code (read → compare → write only the divergent rows) rather than
 * a blanket `json_set` UPDATE so the result reports how many actually needed
 * fixing (the idempotency signal) and so it never rewrites already-correct JSON.
 */
export async function reconcileAgentRuntime(
  adapter: DbAdapter,
  opts: { teamId?: string } = {},
): Promise<ReconcileAgentRuntimeResult> {
  const params: unknown[] = [];
  let where = "deleted_at IS NULL";
  if (opts.teamId) {
    where += " AND team_id = $1";
    params.push(opts.teamId);
  }
  const { rows } = await adapter.query<AgentRuntimeRow>(
    `SELECT id, runtime, metadata FROM agents WHERE ${where}`,
    params,
  );

  let reconciled = 0;
  let already_consistent = 0;
  for (const row of rows) {
    const runtime = row.runtime ?? "";
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        /* tolerate legacy/malformed metadata — treated as empty, then fixed */
      }
    }
    if (meta.runtime === runtime && row.metadata) {
      already_consistent += 1;
      continue;
    }
    meta.runtime = runtime;
    await adapter.query(`UPDATE agents SET metadata = $1 WHERE id = $2`, [JSON.stringify(meta), row.id]);
    reconciled += 1;
  }
  return { reconciled, already_consistent, scanned: rows.length };
}

/**
 * One-time, idempotent reconcile for stale catalog metadata:
 * `metadata.catalog.model` is legacy desired-state metadata, not live runtime
 * truth. Move it to `metadata.catalog.desiredModel` and remove `catalog.model`
 * so clients cannot mistake it for the running process model.
 */
export async function reconcileCatalogModelTruth(
  adapter: DbAdapter,
  opts: { teamId?: string } = {},
): Promise<ReconcileCatalogModelResult> {
  const params: unknown[] = [];
  let where = "deleted_at IS NULL";
  if (opts.teamId) {
    where += " AND team_id = $1";
    params.push(opts.teamId);
  }
  const { rows } = await adapter.query<AgentRuntimeRow & { model: string | null }>(
    `SELECT id, runtime, model, metadata FROM agents WHERE ${where}`,
    params,
  );

  let reconciled = 0;
  let already_consistent = 0;
  let stale_desired_model = 0;
  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        already_consistent += 1;
        continue;
      }
    }

    const catalog = meta.catalog;
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      already_consistent += 1;
      continue;
    }

    const originalCatalog = catalog as Record<string, unknown>;
    const legacyModel = originalCatalog.model;
    const nextCatalog = sanitizeCatalogRuntimeTruth(catalog) as Record<string, unknown>;
    if (typeof legacyModel !== "string") {
      if (typeof nextCatalog.desiredModel === "string" && nextCatalog.desiredModel !== (row.model ?? "")) {
        stale_desired_model += 1;
      }
      already_consistent += 1;
      continue;
    }

    if (typeof nextCatalog.desiredModel === "string" && nextCatalog.desiredModel !== (row.model ?? "")) {
      stale_desired_model += 1;
    }
    meta.catalog = nextCatalog;
    await adapter.query(`UPDATE agents SET metadata = $1 WHERE id = $2`, [JSON.stringify(meta), row.id]);
    reconciled += 1;
  }
  return { reconciled, already_consistent, stale_desired_model, scanned: rows.length };
}

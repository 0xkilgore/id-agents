import { basename as pathBasename } from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  artifactIdFromPath,
  registerArtifactPathDelivery,
} from "./storage.js";
import type { ArtifactCatalogRow } from "./types.js";

export interface FreshOutputBackfillSpec {
  abs_path: string;
  title: string;
  media_type?: "text/markdown" | "text/html" | "text/plain" | "application/pdf" | "unknown";
  project_ref?: string | null;
  agent?: string;
  produced_at?: string;
  dispatch_ref?: string | null;
  source_host?: string | null;
}

export interface FreshOutputBackfillResult {
  source_path: string;
  media_type: string | null;
  source_mtime: string | null;
  content_hash: string | null;
  stable_artifact_id: string;
  stable_url: string;
  copy_text_url: string;
  download_url: string;
  cached_body: boolean;
  body_unavailable: boolean;
  body_error: string | null;
  row: ArtifactCatalogRow;
  inserted: boolean;
}

export const DEFAULT_FINANCE_OUTPUT_BACKFILL_SPECS: readonly FreshOutputBackfillSpec[] = [
  {
    abs_path: "/Users/kilgore/Dropbox/Code/finances/output/2026-07-08-coming-month-cash-flow-preview.html",
    title: "Coming Month Cash-Flow Preview",
    project_ref: "finances",
    agent: "finances",
    source_host: "M4",
  },
  {
    abs_path: "/Users/kilgore/Dropbox/Code/finances/output/2026-07-08-cash-flow-cobra-boxx-addendum.md",
    title: "Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots",
    project_ref: "finances",
    agent: "finances",
    source_host: "M4",
  },
] as const;

export interface BackfillFreshFinanceOutputsOptions {
  specs?: readonly FreshOutputBackfillSpec[];
  now?: () => Date;
  maxArtifacts?: number;
}

export async function backfillFreshFinanceOutputs(
  adapter: DbAdapter,
  opts: BackfillFreshFinanceOutputsOptions = {},
): Promise<FreshOutputBackfillResult[]> {
  const specs = [...(opts.specs ?? DEFAULT_FINANCE_OUTPUT_BACKFILL_SPECS)];
  const maxArtifacts = Math.min(Math.max(opts.maxArtifacts ?? 2, 1), 20);
  const bounded = specs.slice(0, maxArtifacts);
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  const results: FreshOutputBackfillResult[] = [];

  for (const spec of bounded) {
    const artifactId = artifactIdFromPath(spec.abs_path);
    const registered = await registerArtifactPathDelivery(
      adapter,
      {
        abs_path: spec.abs_path,
        agent: spec.agent ?? spec.project_ref ?? "finances",
        produced_at: spec.produced_at ?? nowIso,
        title: spec.title || pathBasename(spec.abs_path),
        project_ref: spec.project_ref ?? "finances",
        dispatch_ref: spec.dispatch_ref ?? null,
        source_host: spec.source_host ?? "M4",
        source: "filesystem",
      },
      nowIso,
    );

    results.push({
      source_path: registered.row.abs_path,
      media_type: registered.row.media_type,
      source_mtime: registered.row.source_mtime,
      content_hash: registered.row.content_hash,
      stable_artifact_id: artifactId,
      stable_url: `/artifacts/${encodeURIComponent(artifactId)}/detail`,
      copy_text_url: `/artifacts/${encodeURIComponent(artifactId)}/copy-text`,
      download_url: `/artifacts/${encodeURIComponent(artifactId)}/download`,
      cached_body: registered.body_cached,
      body_unavailable: !registered.body_cached,
      body_error: registered.body_error,
      row: registered.row,
      inserted: registered.inserted,
    });
  }

  return results;
}

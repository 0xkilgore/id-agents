// D1 / T-MODEL.1 — models metadata seam (the "Models.dev metadata" coupling).
//
// Maps a model id (or a friendly alias) to the runtime that serves it; the
// provider lane derives from the runtime. This lets a model-policy entry name
// just a model ("opus", "gpt-5.4") and have its runtime + provider resolved.
//
// Seeded from the runtime registry's canonical models. Override/extend at load
// time from configs/models-metadata.json — a Models.dev-shaped list of
// { model, runtime, aliases? } rows — so the catalog can track models.dev
// without code changes.

import type { Provider, Runtime } from "../dispatch-scheduler/types.js";
import { normalizeRuntime, resolveProviderFromRuntime } from "../dispatch-scheduler/types.js";
import { getDefaultModelForRuntime } from "../runtime/registry.js";

export interface ModelMetadata {
  model: string; // canonical model id
  runtime: Runtime;
  provider: Provider;
  source: "seed" | "models_dev";
}

export interface RawModelMetadataRow {
  model: string;
  runtime: string;
  aliases?: string[];
}

// Seed catalog — canonical model → runtime. Aliases resolve to the same
// canonical metadata. Kept aligned with src/runtime/registry.ts defaults.
const SEED_ROWS: RawModelMetadataRow[] = [
  { model: "claude-opus-4-20250514", runtime: "claude-code-cli", aliases: ["opus", "claude-opus"] },
  { model: "claude-sonnet-4-5-20250514", runtime: "claude-code-cli", aliases: ["sonnet", "claude-sonnet"] },
  { model: "claude-haiku-4-5-20251001", runtime: "claude-agent-sdk", aliases: ["haiku", "claude-haiku"] },
  // Latest Anthropic models (2026) — served by the Claude Code CLI (BYO-Claude auth).
  { model: "claude-fable-5", runtime: "claude-code-cli", aliases: ["fable", "claude-fable"] },
  { model: "claude-sonnet-5", runtime: "claude-code-cli", aliases: ["sonnet-5", "claude-sonnet-5"] },
  { model: "gpt-5.4", runtime: "codex", aliases: ["gpt-5", "codex", "gpt"] },
  { model: "z-ai/glm-5.2", runtime: "openrouter", aliases: ["glm", "glm-5.2", "openrouter"] },
];

export class ModelsMetadata {
  private byKey = new Map<string, ModelMetadata>();

  constructor(rows: Array<RawModelMetadataRow & { source: ModelMetadata["source"] }>) {
    for (const row of rows) {
      const runtime = normalizeRuntime(row.runtime);
      const meta: ModelMetadata = {
        model: row.model,
        runtime,
        provider: resolveProviderFromRuntime(runtime),
        source: row.source,
      };
      this.byKey.set(row.model.toLowerCase(), meta);
      for (const alias of row.aliases ?? []) this.byKey.set(alias.toLowerCase(), meta);
    }
  }

  /** Resolve a model id or alias to its metadata, or null when unknown. */
  lookup(modelOrAlias: string): ModelMetadata | null {
    return this.byKey.get((modelOrAlias ?? "").trim().toLowerCase()) ?? null;
  }

  /** All canonical metadata rows (deduped), for the read API. */
  list(): ModelMetadata[] {
    const seen = new Set<string>();
    const out: ModelMetadata[] = [];
    for (const meta of this.byKey.values()) {
      if (seen.has(meta.model)) continue;
      seen.add(meta.model);
      out.push(meta);
    }
    return out;
  }
}

/** Build the metadata catalog from the seed plus optional Models.dev-shaped
 *  override rows (later rows win on key collision). */
export function buildModelsMetadata(overrides: RawModelMetadataRow[] = []): ModelsMetadata {
  return new ModelsMetadata([
    ...SEED_ROWS.map((r) => ({ ...r, source: "seed" as const })),
    ...overrides.map((r) => ({ ...r, source: "models_dev" as const })),
  ]);
}

/** Default model id for a runtime (re-export of the registry helper) so the
 *  policy loader has a single import surface. */
export function defaultModelForRuntime(runtime: Runtime): string {
  return getDefaultModelForRuntime(runtime);
}

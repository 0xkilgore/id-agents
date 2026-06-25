// AP6-EDIT / Slice A — durable catalog persistence: read the team YAML, merge a
// validated patch into the agent's catalog block, and write it back ATOMICALLY
// (temp file + rename) so the edit survives a manager restart. The runtime
// metadata write (AP6) keeps the change live immediately; THIS write makes it
// durable in the source-of-truth.

import fs from "node:fs";
import path from "node:path";
import type { AgentCatalog } from "../config-parser.js";
import {
  validateCatalogPatch,
  applyCatalogPatch,
  type CatalogPatch,
} from "../agent-detail/catalog-edit.js";
import { readAgentCatalogFromYaml, spliceAgentCatalog } from "./yaml-catalog.js";

export type DurableWriteResult =
  | { ok: true; catalog: AgentCatalog; file: string }
  | { ok: false; code: "invalid" | "agent_not_found" | "io_error"; error: string };

/**
 * Durably apply a (raw, unvalidated) catalog patch for `agentName` to the YAML
 * file at `filePath`. Validates → reads current catalog from the file → merges →
 * splices the agent's block → atomic-writes. Pure except the file read/write,
 * which go through `io` (injectable for tests).
 */
export function writeDurableCatalog(
  filePath: string,
  agentName: string,
  rawPatch: unknown,
  io: FileIO = nodeFileIO,
): DurableWriteResult {
  const validated = validateCatalogPatch(rawPatch);
  if (!validated.ok) {
    return { ok: false, code: "invalid", error: validated.errors.map((e) => `${e.field}: ${e.message}`).join("; ") };
  }
  if (Object.keys(validated.patch).length === 0) {
    return { ok: false, code: "invalid", error: "no editable catalog fields provided" };
  }
  return writeValidatedCatalog(filePath, agentName, validated.patch, io);
}

/** Same as writeDurableCatalog but for an already-validated patch (route reuse). */
export function writeValidatedCatalog(
  filePath: string,
  agentName: string,
  patch: CatalogPatch,
  io: FileIO = nodeFileIO,
): DurableWriteResult {
  let text: string;
  try {
    text = io.read(filePath);
  } catch (err) {
    return { ok: false, code: "io_error", error: `read failed: ${errMsg(err)}` };
  }

  const cur = readAgentCatalogFromYaml(text, agentName);
  if (!cur.found) {
    return { ok: false, code: "agent_not_found", error: `agent "${agentName}" not found in ${filePath}` };
  }

  const merged = applyCatalogPatch(cur.catalog, patch);
  const spliced = spliceAgentCatalog(text, agentName, merged);
  if (!spliced.ok) {
    return { ok: false, code: "agent_not_found", error: spliced.error };
  }

  // Verify the rewrite still parses and round-trips the merged catalog before we
  // commit it — never write a YAML we just corrupted.
  const check = readAgentCatalogFromYaml(spliced.yaml, agentName);
  if (!check.found) {
    return { ok: false, code: "io_error", error: "post-write YAML failed to re-parse (aborted, no write)" };
  }

  try {
    io.writeAtomic(filePath, spliced.yaml);
  } catch (err) {
    return { ok: false, code: "io_error", error: `atomic write failed: ${errMsg(err)}` };
  }
  return { ok: true, catalog: merged, file: filePath };
}

/**
 * Resolve which YAML config file under `configsDir` owns `agentName`. Refuses to
 * guess when the agent appears in more than one file (returns ambiguous with the
 * candidates) — writing to the wrong team config silently would be the worst
 * outcome. An env override (`ID_AGENTS_CATALOG_CONFIG`) wins when set + valid.
 */
export function resolveAgentConfigFile(
  configsDir: string,
  agentName: string,
  io: FileIO = nodeFileIO,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; file: string } | { ok: false; code: "not_found" | "ambiguous"; candidates: string[] } {
  const override = env.ID_AGENTS_CATALOG_CONFIG?.trim();
  if (override && io.exists(override) && readAgentCatalogFromYaml(io.read(override), agentName).found) {
    return { ok: true, file: override };
  }

  const matches: string[] = [];
  let files: string[];
  try {
    files = io.listYaml(configsDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      if (readAgentCatalogFromYaml(io.read(f), agentName).found) matches.push(f);
    } catch {
      /* skip unreadable/invalid file */
    }
  }
  if (matches.length === 1) return { ok: true, file: matches[0] };
  if (matches.length === 0) return { ok: false, code: "not_found", candidates: [] };
  return { ok: false, code: "ambiguous", candidates: matches };
}

// ── File IO seam (injectable for tests) ─────────────────────────────────────
export interface FileIO {
  read(p: string): string;
  writeAtomic(p: string, content: string): void;
  exists(p: string): boolean;
  /** Absolute paths of `*.yaml`/`*.yml` files directly under `dir`. */
  listYaml(dir: string): string[];
}

export const nodeFileIO: FileIO = {
  read: (p) => fs.readFileSync(p, "utf8"),
  writeAtomic: (p, content) => {
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p); // atomic on the same filesystem
  },
  exists: (p) => fs.existsSync(p),
  listYaml: (dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => path.join(dir, f)),
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Re-export for callers that want to read without writing.
export { readAgentCatalogFromYaml };

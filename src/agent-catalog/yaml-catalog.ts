// AP6-EDIT / Slice A — the DURABLE catalog write path: persist catalog edits to
// the YAML source-of-truth (the agent's `catalog:` block in the team config),
// NOT the ephemeral runtime metadata that a /sync or /deploy overwrites.
//
// The team YAML is human-edited and comment-rich, and js-yaml (the only YAML lib
// in-tree) does not preserve comments on load→dump. So this module does a
// SURGICAL TEXT splice: it parses only to read the current catalog, then
// rewrites just the one agent's `catalog:` block in the raw text, leaving every
// other byte (other agents, comments, field order, formatting) untouched.
//
// Pure + dependency-light (js-yaml is read-only here). Fully unit-tested:
// read/insert/update round-trips + comment preservation.

import yaml from "js-yaml";
import type { AgentCatalog } from "../config-parser.js";

/** Indentation of agent list-item fields (`    description:`) in the team YAML. */
const FIELD_INDENT = "    "; // 4 spaces
const SUBFIELD_INDENT = "      "; // 6 spaces

/** Canonical field order for a serialized catalog block (known keys first). */
const KNOWN_ORDER = ["role", "description", "expertise", "costTier", "notSuitableFor", "status"];

export interface ReadCatalogResult {
  /** True when the agent exists in the YAML's `agents:` list. */
  found: boolean;
  /** The agent's current catalog, or {} when the agent has none. */
  catalog: AgentCatalog;
}

/** Parse the team YAML and return the named agent's current catalog (read-only). */
export function readAgentCatalogFromYaml(yamlText: string, agentName: string): ReadCatalogResult {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText);
  } catch {
    return { found: false, catalog: {} };
  }
  const agents = (doc as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return { found: false, catalog: {} };
  const agent = agents.find(
    (a) => a && typeof a === "object" && (a as { name?: unknown }).name === agentName,
  ) as { catalog?: AgentCatalog } | undefined;
  if (!agent) return { found: false, catalog: {} };
  return { found: true, catalog: (agent.catalog ?? {}) as AgentCatalog };
}

/** A scalar string value, YAML-quoted only when needed (keeps simple values bare). */
function scalar(v: string): string {
  if (v === "") return '""';
  // Quote when the value could be misread as YAML (special leading chars, colons, #, etc.).
  if (/^[\s>&*!|#%@`"'\-?:,\[\]{}]|[:#]\s|[\n]/.test(v) || /^(true|false|null|yes|no|~)$/i.test(v) || /^[\d.]+$/.test(v)) {
    return JSON.stringify(v); // double-quoted, escapes safely
  }
  return v;
}

/**
 * Serialize a catalog object to YAML lines for an agent block. Pure + deterministic:
 * known keys first (in canonical order), then any extra keys (sorted). Arrays use
 * the inline flow form `[a, b]`; empty arrays/objects and undefined are omitted.
 * Returned WITHOUT a trailing newline; the `catalog:` header is included.
 */
export function serializeCatalogBlock(catalog: AgentCatalog): string {
  const keys = [
    ...KNOWN_ORDER.filter((k) => k in catalog),
    ...Object.keys(catalog).filter((k) => !KNOWN_ORDER.includes(k)).sort(),
  ];
  const lines = [`${FIELD_INDENT}catalog:`];
  for (const k of keys) {
    const v = (catalog as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === "string").map(scalar);
      lines.push(`${SUBFIELD_INDENT}${k}: [${items.join(", ")}]`);
    } else if (typeof v === "string") {
      lines.push(`${SUBFIELD_INDENT}${k}: ${scalar(v)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${SUBFIELD_INDENT}${k}: ${String(v)}`);
    }
    // nested objects are not part of the catalog schema — skipped
  }
  return lines.join("\n");
}

export type SpliceResult =
  | { ok: true; yaml: string }
  | { ok: false; error: string };

/**
 * Replace (or insert) the named agent's `catalog:` block in the team YAML text.
 * Surgical: only the agent's catalog block changes; all other text is preserved
 * byte-for-byte. Pure.
 *
 * - Locates the agent by a `- name: <agentName>` list item at 2-space indent.
 * - The agent block runs until the next `  - ` list item (2-space) or a dedent to
 *   column 0 (next top-level key) or EOF.
 * - If a `    catalog:` block (4-space) already exists in that range, it (and its
 *   deeper-indented body) is replaced. Otherwise the new block is appended at the
 *   end of the agent's field block.
 */
export function spliceAgentCatalog(
  yamlText: string,
  agentName: string,
  catalog: AgentCatalog,
): SpliceResult {
  const lines = yamlText.split("\n");
  const block = serializeCatalogBlock(catalog).split("\n");

  // Find the agent's list-item start: `  - ` ... `name: <agentName>` on that item.
  // Items are `  - name: X` OR `  - ` then `    name: X`; the team YAML uses the
  // inline `  - name: X` form, which we match directly.
  const isListItem = (l: string) => /^ {2}-\s/.test(l);
  const isTopLevel = (l: string) => /^\S/.test(l) && l.trim() !== "";

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isListItem(lines[i]) && new RegExp(`^ {2}-\\s+name:\\s*${escapeRe(agentName)}\\s*$`).test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { ok: false, error: `agent "${agentName}" not found in YAML agents list` };
  }

  // End of this agent's block: next list item at 2-indent, or next top-level key.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isListItem(lines[i]) || isTopLevel(lines[i])) { end = i; break; }
  }

  // Within [start+1, end), find an existing `    catalog:` (4-space) block.
  let catStart = -1;
  for (let i = start + 1; i < end; i++) {
    if (/^ {4}catalog:\s*$/.test(lines[i]) || /^ {4}catalog:\s/.test(lines[i])) { catStart = i; break; }
  }

  let next: string[];
  if (catStart !== -1) {
    // Existing block: its body is the following lines indented > 4 (>=6) or blank
    // lines interleaved; stop at the first line indented <= 4 that's non-blank.
    let catEnd = catStart + 1;
    while (catEnd < end) {
      const l = lines[catEnd];
      if (l.trim() === "") { catEnd++; continue; }
      if (/^ {6,}/.test(l)) { catEnd++; continue; }
      break;
    }
    next = [...lines.slice(0, catStart), ...block, ...lines.slice(catEnd)];
  } else {
    // No catalog yet: insert after the agent's last non-blank field line, before
    // any trailing blank lines that separate this item from the next.
    let insertAt = end;
    while (insertAt - 1 > start && lines[insertAt - 1].trim() === "") insertAt--;
    next = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
  }

  return { ok: true, yaml: next.join("\n") };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

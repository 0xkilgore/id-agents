// AP6 (AGENT-V2) — inline view/edit of an agent's catalog (role, expertise,
// costTier, notSuitableFor) from the agent detail page.
//
// The catalog lives in the agent's `metadata.catalog` (seeded from YAML, also
// runtime-PATCHable; see config-parser AgentCatalog). This module is the pure,
// unit-tested core the detail page + the manager PATCH route share:
//   - pickCatalogView  — narrow a stored catalog to the AP6 view fields,
//   - validateCatalogPatch — validate an inline edit (same rules the YAML parser
//     enforces) and reject non-editable keys, so the route is a thin wrapper,
//   - applyCatalogPatch — merge a validated patch onto the stored catalog
//     (null clears a field; other catalog/custom fields are left untouched).
//
// Keeping validation here (not inline in the route) means the edit semantics are
// verifiable without a live DB, and the manager surfaces the same errors the
// deploy-time validator would.

import type { AgentCatalog } from "../config-parser.js";

/** The catalog fields AP6 surfaces for inline view/edit. */
export const AP6_EDITABLE_FIELDS = [
  "role",
  "description",
  "expertise",
  "costTier",
  "notSuitableFor",
  "status",
] as const;

export type EditableCatalogField = (typeof AP6_EDITABLE_FIELDS)[number];

export type CostTier = "low" | "medium" | "high";
const COST_TIERS: readonly CostTier[] = ["low", "medium", "high"];

/** The AP6 view of a catalog — the editable fields, normalized for rendering. */
export interface CatalogView {
  role: string | null;
  description: string | null;
  expertise: string[];
  costTier: CostTier | null;
  notSuitableFor: string[];
  status: string | null;
}

// ────────────────────────────────────────────────────────────────────
// AP6 — self-describing edit schema for the inline editor (Slice B).
//
// The detail page renders an inline editor; rather than hard-coding which
// fields are editable, their input types, and the costTier enum on the
// frontend (where it drifts from the server's validation rules), the GET
// /agents/:name/detail payload carries this schema. The frontend renders +
// pre-validates generically from it, and `validateCatalogPatch` remains the
// single source of truth the server enforces.
// ────────────────────────────────────────────────────────────────────

/** How the inline editor should render a field. */
export type CatalogFieldInput = "text" | "textarea" | "tags" | "enum";

/** A self-describing descriptor for one editable catalog field. */
export interface CatalogFieldSchema {
  field: EditableCatalogField;
  /** Human-readable label for the editor. */
  label: string;
  /** The input control the field maps to. */
  input: CatalogFieldInput;
  /** Allowed values when input === "enum" (e.g. costTier). */
  options?: string[];
  /** Whether the field may be cleared (true for all AP6 fields). */
  clearable: boolean;
}

/** Canonical schema, ordered to match AP6_EDITABLE_FIELDS. */
const CATALOG_EDIT_SCHEMA: readonly CatalogFieldSchema[] = [
  { field: "role", label: "Role", input: "text", clearable: true },
  { field: "description", label: "Description", input: "textarea", clearable: true },
  { field: "expertise", label: "Expertise", input: "tags", clearable: true },
  { field: "costTier", label: "Cost tier", input: "enum", options: [...COST_TIERS], clearable: true },
  { field: "notSuitableFor", label: "Not suitable for", input: "tags", clearable: true },
  { field: "status", label: "Status", input: "text", clearable: true },
];

/**
 * The inline-editor schema: one descriptor per editable field, in canonical
 * order, with enum options resolved. Pure; returns a fresh deep copy so callers
 * cannot mutate the shared definition.
 */
export function catalogEditSchema(): CatalogFieldSchema[] {
  return CATALOG_EDIT_SCHEMA.map((f) => ({
    ...f,
    options: f.options ? [...f.options] : undefined,
  }));
}

/** Narrow a stored catalog (or absent catalog) to the AP6 view. Pure. */
export function pickCatalogView(catalog: AgentCatalog | null | undefined): CatalogView {
  const c = catalog ?? {};
  return {
    role: typeof c.role === "string" ? c.role : null,
    description: typeof c.description === "string" ? c.description : null,
    expertise: stringArray(c.expertise),
    costTier: COST_TIERS.includes(c.costTier as CostTier) ? (c.costTier as CostTier) : null,
    notSuitableFor: stringArray(c.notSuitableFor),
    status: typeof c.status === "string" ? c.status : null,
  };
}

/** A validated patch: field → new value, or `null` to clear the field. */
export type CatalogPatch = Partial<Record<EditableCatalogField, string | string[] | null>>;

export interface CatalogFieldError {
  field: string;
  message: string;
}

export type ValidateCatalogResult =
  | { ok: true; patch: CatalogPatch }
  | { ok: false; errors: CatalogFieldError[] };

/**
 * Validate an inline catalog edit. Pure. Accepts only the AP6-editable fields
 * (a non-editable / unknown key is an error, so an edit can't clobber unrelated
 * metadata). Per field, mirrors the YAML parser's rules:
 *   - role / description / status: string (or null/"" to clear),
 *   - expertise / notSuitableFor: string[] (or null to clear; entries trimmed,
 *     blanks dropped),
 *   - costTier: 'low' | 'medium' | 'high' (or null to clear).
 * An empty/whitespace string on a scalar field normalizes to a clear (null).
 */
export function validateCatalogPatch(input: unknown): ValidateCatalogResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: "(root)", message: "catalog patch must be an object" }] };
  }
  const raw = input as Record<string, unknown>;
  const errors: CatalogFieldError[] = [];
  const patch: CatalogPatch = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!AP6_EDITABLE_FIELDS.includes(key as EditableCatalogField)) {
      errors.push({ field: key, message: `"${key}" is not an editable catalog field` });
      continue;
    }
    const field = key as EditableCatalogField;

    if (field === "expertise" || field === "notSuitableFor") {
      if (value === null) {
        patch[field] = null;
      } else if (Array.isArray(value) && value.every((e) => typeof e === "string")) {
        const cleaned = (value as string[]).map((e) => e.trim()).filter((e) => e.length > 0);
        patch[field] = cleaned;
      } else {
        errors.push({ field, message: `catalog.${field} must be a string array (or null to clear)` });
      }
      continue;
    }

    if (field === "costTier") {
      if (value === null || value === "") {
        patch.costTier = null;
      } else if (typeof value === "string" && COST_TIERS.includes(value as CostTier)) {
        patch.costTier = value;
      } else {
        errors.push({ field, message: "catalog.costTier must be one of: low, medium, high (or null to clear)" });
      }
      continue;
    }

    // role / description / status — scalar strings.
    if (value === null) {
      patch[field] = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      patch[field] = trimmed.length === 0 ? null : trimmed;
    } else {
      errors.push({ field, message: `catalog.${field} must be a string (or null to clear)` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

/**
 * Merge a validated patch onto the stored catalog. Pure: returns a NEW catalog
 * object. A `null` patch value deletes the field; any other value overwrites it.
 * Fields not present in the patch — including custom/non-AP6 catalog keys — are
 * preserved unchanged.
 */
export function applyCatalogPatch(
  current: AgentCatalog | null | undefined,
  patch: CatalogPatch,
): AgentCatalog {
  const next: AgentCatalog = { ...(current ?? {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

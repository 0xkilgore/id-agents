// AP6 (AGENT-V2) — pure catalog view/edit core: narrow a stored catalog to the
// editable view, validate an inline edit, and merge it onto the stored catalog.

import { describe, it, expect } from "vitest";
import {
  pickCatalogView,
  validateCatalogPatch,
  applyCatalogPatch,
  catalogEditSchema,
  AP6_EDITABLE_FIELDS,
} from "../../src/agent-detail/catalog-edit.js";
import type { AgentCatalog } from "../../src/config-parser.js";

describe("pickCatalogView", () => {
  it("null/undefined → empty view", () => {
    const empty = { role: null, description: null, expertise: [], costTier: null, notSuitableFor: [], status: null };
    expect(pickCatalogView(null)).toEqual(empty);
    expect(pickCatalogView(undefined)).toEqual(empty);
  });

  it("narrows a populated catalog and ignores custom fields", () => {
    const cat: AgentCatalog = {
      role: "developer",
      description: "builds backend",
      expertise: ["typescript", "node"],
      costTier: "medium",
      notSuitableFor: ["pixel-pushing"],
      status: "available",
      currentTask: "AP6",
      customField: 123,
    };
    expect(pickCatalogView(cat)).toEqual({
      role: "developer",
      description: "builds backend",
      expertise: ["typescript", "node"],
      costTier: "medium",
      notSuitableFor: ["pixel-pushing"],
      status: "available",
    });
  });

  it("coerces malformed stored values to safe view defaults", () => {
    const cat = { role: 42, expertise: "ts", costTier: "extreme", notSuitableFor: [1, "ok"] } as unknown as AgentCatalog;
    const v = pickCatalogView(cat);
    expect(v.role).toBeNull();
    expect(v.expertise).toEqual([]);
    expect(v.costTier).toBeNull();
    expect(v.notSuitableFor).toEqual(["ok"]);
  });
});

describe("validateCatalogPatch", () => {
  it("accepts the AP6 editable fields", () => {
    const r = validateCatalogPatch({
      role: "auditor",
      expertise: ["security"],
      costTier: "high",
      notSuitableFor: ["frontend"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({
        role: "auditor",
        expertise: ["security"],
        costTier: "high",
        notSuitableFor: ["frontend"],
      });
    }
  });

  it("trims scalar strings and treats empty/whitespace as a clear (null)", () => {
    const r = validateCatalogPatch({ role: "  lead  ", description: "   " });
    expect(r.ok && r.patch.role).toBe("lead");
    expect(r.ok && r.patch.description).toBeNull();
  });

  it("trims array entries and drops blanks", () => {
    const r = validateCatalogPatch({ expertise: [" ts ", "", "  ", "node"] });
    expect(r.ok && r.patch.expertise).toEqual(["ts", "node"]);
  });

  it("null clears a field (scalar and array)", () => {
    const r = validateCatalogPatch({ role: null, expertise: null, costTier: null });
    expect(r.ok && r.patch.role).toBeNull();
    expect(r.ok && r.patch.expertise).toBeNull();
    expect(r.ok && r.patch.costTier).toBeNull();
  });

  it("rejects a non-editable / unknown key", () => {
    const r = validateCatalogPatch({ role: "x", endpoints: { talk: "/t" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].field).toBe("endpoints");
  });

  it("rejects bad types per field", () => {
    expect(validateCatalogPatch({ role: 5 }).ok).toBe(false);
    expect(validateCatalogPatch({ expertise: "ts" }).ok).toBe(false);
    expect(validateCatalogPatch({ expertise: [1, 2] }).ok).toBe(false);
    expect(validateCatalogPatch({ costTier: "extreme" }).ok).toBe(false);
  });

  it("rejects a non-object patch", () => {
    expect(validateCatalogPatch(null).ok).toBe(false);
    expect(validateCatalogPatch([]).ok).toBe(false);
    expect(validateCatalogPatch("role").ok).toBe(false);
  });

  it("AP6_EDITABLE_FIELDS is exactly the four named fields plus description/status", () => {
    expect([...AP6_EDITABLE_FIELDS].sort()).toEqual(
      ["costTier", "description", "expertise", "notSuitableFor", "role", "status"].sort(),
    );
  });
});

describe("catalogEditSchema", () => {
  it("describes every editable field in canonical order", () => {
    const schema = catalogEditSchema();
    expect(schema.map((f) => f.field)).toEqual([...AP6_EDITABLE_FIELDS]);
    for (const f of schema) expect(f.clearable).toBe(true);
  });

  it("maps each field to the expected input control", () => {
    const byField = Object.fromEntries(catalogEditSchema().map((f) => [f.field, f.input]));
    expect(byField).toEqual({
      role: "text",
      description: "textarea",
      expertise: "tags",
      costTier: "enum",
      notSuitableFor: "tags",
      status: "text",
    });
  });

  it("costTier carries the enum options the validator accepts (no drift)", () => {
    const costTier = catalogEditSchema().find((f) => f.field === "costTier");
    expect(costTier?.options).toEqual(["low", "medium", "high"]);
    // Every advertised option must validate; an off-menu value must not.
    for (const opt of costTier!.options!) {
      expect(validateCatalogPatch({ costTier: opt }).ok).toBe(true);
    }
    expect(validateCatalogPatch({ costTier: "extreme" }).ok).toBe(false);
  });

  it("non-enum fields omit options", () => {
    for (const f of catalogEditSchema().filter((f) => f.input !== "enum")) {
      expect(f.options).toBeUndefined();
    }
  });

  it("returns a fresh copy callers cannot use to mutate the shared schema", () => {
    const a = catalogEditSchema();
    a[0].label = "MUTATED";
    a.find((f) => f.field === "costTier")!.options!.push("x");
    const b = catalogEditSchema();
    expect(b[0].label).toBe("Role");
    expect(b.find((f) => f.field === "costTier")!.options).toEqual(["low", "medium", "high"]);
  });
});

describe("applyCatalogPatch", () => {
  it("overwrites provided fields and preserves untouched + custom fields", () => {
    const current: AgentCatalog = {
      role: "developer",
      expertise: ["ts"],
      status: "busy",
      currentTask: "AP6",
      endpoints: { talk: "/talk" },
    };
    const r = validateCatalogPatch({ role: "lead", expertise: ["ts", "node"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const next = applyCatalogPatch(current, r.patch);
      expect(next.role).toBe("lead");
      expect(next.expertise).toEqual(["ts", "node"]);
      expect(next.status).toBe("busy"); // untouched
      expect(next.currentTask).toBe("AP6"); // untouched
      expect(next.endpoints).toEqual({ talk: "/talk" }); // custom field preserved
    }
  });

  it("null patch values delete the field", () => {
    const current: AgentCatalog = { role: "developer", costTier: "high", expertise: ["ts"] };
    const r = validateCatalogPatch({ costTier: null, role: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const next = applyCatalogPatch(current, r.patch);
      expect("costTier" in next).toBe(false);
      expect("role" in next).toBe(false);
      expect(next.expertise).toEqual(["ts"]);
    }
  });

  it("does not mutate the input catalog", () => {
    const current: AgentCatalog = { role: "developer" };
    const r = validateCatalogPatch({ role: "lead" });
    if (r.ok) applyCatalogPatch(current, r.patch);
    expect(current.role).toBe("developer");
  });

  it("works from an absent (null) catalog", () => {
    const r = validateCatalogPatch({ role: "developer", costTier: "low" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(applyCatalogPatch(null, r.patch)).toEqual({ role: "developer", costTier: "low" });
  });
});

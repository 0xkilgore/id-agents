// AP6-EDIT / Slice A — the pure YAML catalog splicer: read, serialize, and
// surgically replace/insert one agent's `catalog:` block while preserving the
// rest of a comment-rich team config byte-for-byte.

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  readAgentCatalogFromYaml,
  serializeCatalogBlock,
  spliceAgentCatalog,
} from "../../src/agent-catalog/yaml-catalog.js";

const FIXTURE = `# Kilgore team — DO NOT lose these comments
team: kilgore
agents:
  # CANE — infra agent
  - name: cane
    description: >
      Agent infrastructure and task management.
    model: claude-sonnet-4-6
    workingDirectory: /Users/kilgore/Dropbox/Code/cane

  # FINANCES — already has a catalog
  - name: finances
    description: Finance specialist.
    model: claude-sonnet-4-6
    catalog:
      role: auditor
      expertise: [accounting, banking]
      costTier: low
    workingDirectory: /Users/kilgore/Dropbox/Code/finances

  - name: roger
    description: Coding agent.
    model: claude-sonnet-4-6
`;

function reparse(yamlText: string): any {
  return yaml.load(yamlText);
}

describe("readAgentCatalogFromYaml", () => {
  it("reads an existing catalog", () => {
    const r = readAgentCatalogFromYaml(FIXTURE, "finances");
    expect(r.found).toBe(true);
    expect(r.catalog).toMatchObject({ role: "auditor", expertise: ["accounting", "banking"], costTier: "low" });
  });
  it("returns found+empty for an agent with no catalog", () => {
    const r = readAgentCatalogFromYaml(FIXTURE, "roger");
    expect(r.found).toBe(true);
    expect(r.catalog).toEqual({});
  });
  it("returns not-found for an unknown agent", () => {
    expect(readAgentCatalogFromYaml(FIXTURE, "ghost").found).toBe(false);
  });
});

describe("serializeCatalogBlock", () => {
  it("emits known keys in canonical order with inline arrays", () => {
    const block = serializeCatalogBlock({
      costTier: "high",
      role: "lead",
      expertise: ["ts", "node"],
      notSuitableFor: ["design"],
    });
    expect(block).toBe(
      [
        "    catalog:",
        "      role: lead",
        "      expertise: [ts, node]",
        "      costTier: high",
        "      notSuitableFor: [design]",
      ].join("\n"),
    );
  });
  it("quotes values that could be misread as YAML", () => {
    const block = serializeCatalogBlock({ role: "yes", description: "a: b #x" });
    expect(block).toContain('role: "yes"');
    expect(block).toContain('description: "a: b #x"');
  });
});

describe("spliceAgentCatalog — update existing", () => {
  it("replaces only the target catalog and preserves comments + other agents", () => {
    const r = spliceAgentCatalog(FIXTURE, "finances", {
      role: "auditor",
      expertise: ["accounting", "banking", "tax"],
      costTier: "medium",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // comments intact
    expect(r.yaml).toContain("# Kilgore team — DO NOT lose these comments");
    expect(r.yaml).toContain("# FINANCES — already has a catalog");
    expect(r.yaml).toContain("# CANE — infra agent");
    // round-trips the new value
    const doc = reparse(r.yaml);
    const fin = doc.agents.find((a: any) => a.name === "finances");
    expect(fin.catalog).toMatchObject({ role: "auditor", expertise: ["accounting", "banking", "tax"], costTier: "medium" });
    // finances' OTHER fields preserved
    expect(fin.workingDirectory).toBe("/Users/kilgore/Dropbox/Code/finances");
    expect(fin.description).toBe("Finance specialist.");
    // other agents untouched
    expect(doc.agents.find((a: any) => a.name === "roger").catalog).toBeUndefined();
    expect(doc.agents.find((a: any) => a.name === "cane").workingDirectory).toBe("/Users/kilgore/Dropbox/Code/cane");
  });
});

describe("spliceAgentCatalog — insert when absent", () => {
  it("adds a catalog block to an agent that had none, without disturbing others", () => {
    const r = spliceAgentCatalog(FIXTURE, "roger", { role: "developer", costTier: "low" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = reparse(r.yaml);
    expect(doc.agents.find((a: any) => a.name === "roger").catalog).toEqual({ role: "developer", costTier: "low" });
    // finances' existing catalog untouched
    expect(doc.agents.find((a: any) => a.name === "finances").catalog).toMatchObject({ role: "auditor" });
    expect(r.yaml).toContain("# Kilgore team — DO NOT lose these comments");
  });

  it("inserts into the middle agent (cane) keeping the blank-line separator + next agent", () => {
    const r = spliceAgentCatalog(FIXTURE, "cane", { role: "infra", expertise: ["taskview"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = reparse(r.yaml);
    expect(doc.agents.find((a: any) => a.name === "cane").catalog).toEqual({ role: "infra", expertise: ["taskview"] });
    expect(doc.agents.find((a: any) => a.name === "finances").catalog).toMatchObject({ role: "auditor" });
    expect(doc.agents.length).toBe(3);
  });
});

describe("spliceAgentCatalog — errors", () => {
  it("errors on an unknown agent", () => {
    const r = spliceAgentCatalog(FIXTURE, "ghost", { role: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });
});

// AP6-EDIT / Slice A — durable write: validated patch → merged catalog →
// atomic write to the YAML SoT, surviving a re-read (the "restart" guarantee).
// Plus the config-file resolver (refuses to guess across multiple files).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  writeDurableCatalog,
  resolveAgentConfigFile,
} from "../../src/agent-catalog/durable-write.js";

const FIXTURE = `team: kilgore
agents:
  - name: finances
    description: Finance specialist.
    model: claude-sonnet-4-6
    catalog:
      role: auditor
      costTier: low
    workingDirectory: /x/finances
  - name: roger
    description: Coding agent.
    model: claude-sonnet-4-6
`;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-durable-"));
  file = path.join(dir, "kilgore-team.yaml");
  fs.writeFileSync(file, FIXTURE);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeDurableCatalog — survives restart (re-read from disk)", () => {
  it("merges a patch and persists it to the YAML file", () => {
    const r = writeDurableCatalog(file, "finances", { expertise: ["accounting", "tax"], costTier: "medium" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catalog).toMatchObject({ role: "auditor", expertise: ["accounting", "tax"], costTier: "medium" });

    // Re-read from disk = simulate a manager restart re-loading the SoT.
    const reloaded: any = yaml.load(fs.readFileSync(file, "utf8"));
    const fin = reloaded.agents.find((a: any) => a.name === "finances");
    expect(fin.catalog).toMatchObject({ role: "auditor", expertise: ["accounting", "tax"], costTier: "medium" });
    expect(fin.workingDirectory).toBe("/x/finances"); // untouched
  });

  it("inserts a catalog for an agent that had none and it persists", () => {
    const r = writeDurableCatalog(file, "roger", { role: "developer", expertise: ["typescript"] });
    expect(r.ok).toBe(true);
    const reloaded: any = yaml.load(fs.readFileSync(file, "utf8"));
    expect(reloaded.agents.find((a: any) => a.name === "roger").catalog).toEqual({ role: "developer", expertise: ["typescript"] });
  });

  it("clears a field with null and persists the removal", () => {
    const r = writeDurableCatalog(file, "finances", { costTier: null });
    expect(r.ok).toBe(true);
    const reloaded: any = yaml.load(fs.readFileSync(file, "utf8"));
    const fin = reloaded.agents.find((a: any) => a.name === "finances");
    expect("costTier" in fin.catalog).toBe(false);
    expect(fin.catalog.role).toBe("auditor");
  });

  it("the write is atomic — no leftover temp files", () => {
    writeDurableCatalog(file, "finances", { role: "lead" });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("writeDurableCatalog — validation + errors", () => {
  it("rejects an invalid patch without touching the file", () => {
    const before = fs.readFileSync(file, "utf8");
    const r = writeDurableCatalog(file, "finances", { costTier: "extreme" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(fs.readFileSync(file, "utf8")).toBe(before); // unchanged
  });

  it("rejects an empty patch", () => {
    const r = writeDurableCatalog(file, "finances", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
  });

  it("rejects a non-editable field", () => {
    const r = writeDurableCatalog(file, "finances", { endpoints: { talk: "/t" } });
    expect(r.ok).toBe(false);
  });

  it("errors agent_not_found for an unknown agent (file unchanged)", () => {
    const before = fs.readFileSync(file, "utf8");
    const r = writeDurableCatalog(file, "ghost", { role: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("agent_not_found");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("errors io_error when the file is missing", () => {
    const r = writeDurableCatalog(path.join(dir, "nope.yaml"), "finances", { role: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("io_error");
  });
});

describe("resolveAgentConfigFile", () => {
  it("finds the single file that owns the agent", () => {
    const r = resolveAgentConfigFile(dir, "finances");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toBe(file);
  });

  it("returns not_found when no file owns the agent", () => {
    const r = resolveAgentConfigFile(dir, "ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("refuses to guess when the agent appears in multiple files", () => {
    fs.writeFileSync(path.join(dir, "other-team.yaml"), FIXTURE);
    const r = resolveAgentConfigFile(dir, "finances");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ambiguous");
      expect(r.candidates.length).toBe(2);
    }
  });

  it("honors the ID_AGENTS_CATALOG_CONFIG override", () => {
    fs.writeFileSync(path.join(dir, "other-team.yaml"), FIXTURE); // would be ambiguous otherwise
    const r = resolveAgentConfigFile(dir, "finances", undefined, { ID_AGENTS_CATALOG_CONFIG: file } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toBe(file);
  });
});

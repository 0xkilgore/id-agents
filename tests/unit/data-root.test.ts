import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { resolveDefaultWorkspaceDir, resolveIdAgentsHome } from "../../src/lib/data-root.js";

describe("data root resolution", () => {
  it("honors ID_AGENTS_HOME for stranger-account boots", () => {
    const home = path.join(path.sep, "tmp", "stranger-id-agents");
    expect(resolveIdAgentsHome({ ID_AGENTS_HOME: home } as NodeJS.ProcessEnv)).toBe(home);
    expect(resolveDefaultWorkspaceDir({ ID_AGENTS_HOME: home } as NodeJS.ProcessEnv)).toBe(
      path.join(home, "workspace"),
    );
  });

  it("uses XDG_DATA_HOME before falling back to the OS home", () => {
    const env = { XDG_DATA_HOME: path.join(path.sep, "var", "data") } as NodeJS.ProcessEnv;
    expect(resolveIdAgentsHome(env)).toBe(path.join(path.sep, "var", "data", "id-agents"));
  });
});

describe("bundled manager start script", () => {
  it("does not pin operator-specific paths or identity", () => {
    const script = readFileSync("scripts/start-id-agents-manager.sh", "utf8");
    const forbiddenIdentity = new RegExp([["kil", "gore"].join(""), "Ch" + "ris", "ch" + "ris"].join("|"));
    const forbiddenUsersPath = ["", "Users", ""].join("/");
    expect(script).not.toMatch(forbiddenIdentity);
    expect(script).not.toContain(forbiddenUsersPath);
    expect(script).toContain("ID_TEAM");
    expect(script).toContain("ID_AGENTS_HOME");
  });
});

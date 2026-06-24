// Boot-spawn filter — which roster agents the manager (re)spawns on boot.

import { describe, it, expect } from "vitest";
import { isBootSpawnableAgent, type BootSpawnCandidate } from "../../src/lib/boot-spawn.js";

function cand(over: Partial<BootSpawnCandidate> = {}): BootSpawnCandidate {
  return { status: "pending", type: "claude", port: 4197, runtime: "claude-code-cli", ...over };
}

describe("isBootSpawnableAgent", () => {
  it("spawns a pending local claude agent with a real port (the builder case)", () => {
    expect(isBootSpawnableAgent(cand())).toBe(true);
    expect(isBootSpawnableAgent(cand({ runtime: "codex" }))).toBe(true);
    expect(isBootSpawnableAgent(cand({ runtime: "cursor-cli" }))).toBe(true);
  });

  it("does NOT spawn non-pending agents (running/stopped are not boot's job)", () => {
    expect(isBootSpawnableAgent(cand({ status: "running" }))).toBe(false);
    expect(isBootSpawnableAgent(cand({ status: "stopped" }))).toBe(false);
    expect(isBootSpawnableAgent(cand({ status: "offline" }))).toBe(false);
  });

  it("does NOT spawn virtual/external agents (port 0)", () => {
    expect(isBootSpawnableAgent(cand({ type: "virtual", port: 0 }))).toBe(false);
    expect(isBootSpawnableAgent(cand({ port: 0 }))).toBe(false);
  });

  it("does NOT spawn remote-endpoint runtimes", () => {
    expect(isBootSpawnableAgent(cand({ runtime: "public-agent-remote" }))).toBe(false);
  });
});

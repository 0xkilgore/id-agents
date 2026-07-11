import { describe, expect, it } from "vitest";

import {
  evaluateRuntimeMixDrift,
  readRuntimeMixDrift,
} from "../../src/model-policy/runtime-mix-drift.js";

describe("runtime mix drift guard", () => {
  it("catches the live 95/5 policy vs zero-Claude generated runtime-mode disagreement", () => {
    const drift = evaluateRuntimeMixDrift({
      policyPath: "configs/model-policy.json",
      runtimeModePath: "configs/runtime-mode.generated.yaml",
      desiredTargets: { openai: 0.95, anthropic: 0.05 },
      runtimeModeRuntimes: ["codex", "codex", "codex"],
    });

    expect(drift.status).toBe("drift");
    expect(drift.runtime_mode_actual?.runtimes).toEqual({ codex: 3 });
    expect(drift.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "runtime_mode", provider: "anthropic", desired: 0.05, actual: 0 }),
      ]),
    );
  });

  it("matches when generated runtime-mode and agent telemetry are within tolerance", () => {
    const drift = evaluateRuntimeMixDrift({
      policyPath: "configs/model-policy.json",
      runtimeModePath: "configs/runtime-mode.generated.yaml",
      desiredTargets: { openai: 0.5, anthropic: 0.5 },
      runtimeModeRuntimes: ["codex", "claude-code-cli"],
      actualAgentRuntimes: new Map([
        ["a", "codex"],
        ["b", "claude-code-cli"],
      ]),
    });

    expect(drift.status).toBe("match");
    expect(drift.diffs).toEqual([]);
  });

  it("parses runtime-mode yaml maps and compares provider shares", () => {
    const files = new Map([
      [
        "/policy.json",
        JSON.stringify({
          work_share: { targets: { openai: 0.95, anthropic: 0.05 } },
        }),
      ],
      [
        "/runtime-mode.generated.yaml",
        ["agents:", "  one:", "    runtime: codex", "  two:", "    runtime: codex"].join("\n"),
      ],
    ]);

    const drift = readRuntimeMixDrift({
      policyPath: "/policy.json",
      runtimeModePath: "/runtime-mode.generated.yaml",
      readFile: (path) => files.get(path) ?? "",
    });

    expect(drift.status).toBe("drift");
    expect(drift.runtime_mode_actual?.providers.openai).toBe(1);
  });
});

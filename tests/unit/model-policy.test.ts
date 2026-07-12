// D1 / T-MODEL.1 (2026-06-22) — per-agent model policy + provider fallback.
// Covers the models-metadata seam, config normalization, and the lane-aware
// resolver ("Codex Light": codex primary → claude fallback when openai is
// constrained).

import { describe, it, expect } from "vitest";
import { buildModelsMetadata } from "../../src/model-policy/metadata.js";
import {
  buildModelPolicyService,
  loadModelPolicy,
  DEFAULT_CONSTRAINED_PROVIDERS,
} from "../../src/model-policy/policy.js";
import type { RawModelPolicyConfig } from "../../src/model-policy/types.js";

const CODEX_LIGHT: RawModelPolicyConfig = {
  schema_version: 1,
  constrained_providers: ["openai"],
  default: {
    primary: { runtime: "codex" },
    fallback: [{ runtime: "claude-code-cli" }, { runtime: "openrouter" }],
  },
  agents: {
    sentinel: { primary: { runtime: "claude-code-cli" }, fallback: [] }, // always Claude
  },
};

describe("models metadata seam", () => {
  it("maps canonical models and aliases to runtime + provider", () => {
    const md = buildModelsMetadata();
    expect(md.lookup("opus")?.runtime).toBe("claude-code-cli");
    expect(md.lookup("opus")?.provider).toBe("anthropic");
    expect(md.lookup("gpt-5.4")?.provider).toBe("openai");
    expect(md.lookup("codex")?.runtime).toBe("codex");
    expect(md.lookup("glm")?.provider).toBe("other"); // openrouter → other lane
    expect(md.lookup("nope")).toBeNull();
  });

  it("accepts Models.dev-shaped overrides", () => {
    const md = buildModelsMetadata([{ model: "gpt-6", runtime: "codex", aliases: ["next-codex"] }]);
    expect(md.lookup("next-codex")?.model).toBe("gpt-6");
    expect(md.lookup("gpt-6")?.source).toBe("models_dev");
  });

  it("registers claude-fable-5 (canonical + aliases) → claude-code-cli / anthropic", () => {
    const md = buildModelsMetadata();
    for (const key of ["claude-fable-5", "fable", "claude-fable"]) {
      expect(md.lookup(key)?.model).toBe("claude-fable-5");
      expect(md.lookup(key)?.runtime).toBe("claude-code-cli");
      expect(md.lookup(key)?.provider).toBe("anthropic");
    }
  });

  it("registers claude-sonnet-5 (canonical + aliases) → claude-code-cli / anthropic", () => {
    const md = buildModelsMetadata();
    for (const key of ["claude-sonnet-5", "sonnet-5"]) {
      expect(md.lookup(key)?.model).toBe("claude-sonnet-5");
      expect(md.lookup(key)?.runtime).toBe("claude-code-cli");
      expect(md.lookup(key)?.provider).toBe("anthropic");
    }
  });
});

describe("known_models catalog (config enumeration)", () => {
  it("parses the declared known_models, deduped, and includes the new models", () => {
    const svc = buildModelPolicyService(
      {
        default: { primary: { runtime: "claude-code-cli", model: "claude-opus-4-8" } },
        known_models: ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-fable-5", "  "],
      },
      "file",
    );
    expect(svc.knownModels()).toEqual(["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"]);
    expect(svc.config.known_models).toContain("claude-fable-5");
    expect(svc.config.known_models).toContain("claude-sonnet-5");
  });

  it("defaults to an empty catalog when known_models is absent", () => {
    const svc = buildModelPolicyService({ default: { primary: { runtime: "codex" } } }, "file");
    expect(svc.knownModels()).toEqual([]);
  });
});

describe("config normalization", () => {
  it("derives runtime+provider+model for each choice; runtime-only and model-only both work", () => {
    const svc = buildModelPolicyService(
      {
        default: { primary: { model: "opus" }, fallback: [{ runtime: "codex" }] },
      },
      "file",
    );
    const def = svc.config.default;
    expect(def.primary.runtime).toBe("claude-code-cli"); // resolved from model "opus"
    expect(def.primary.provider).toBe("anthropic");
    expect(def.primary.model).toBe("claude-opus-4-20250514");
    expect(def.fallback[0].provider).toBe("openai"); // codex runtime → openai
    expect(def.fallback[0].model).toBeTruthy(); // filled from runtime default
  });

  it("defaults constrained_providers to openai when omitted", () => {
    const svc = buildModelPolicyService({ default: { primary: { runtime: "codex" } } }, "file");
    expect(svc.constrainedProviders()).toEqual(DEFAULT_CONSTRAINED_PROVIDERS);
  });

  it("treats explicit empty constrained_providers as no constrained lanes", () => {
    const svc = buildModelPolicyService(
      { constrained_providers: [], default: { primary: { runtime: "codex" } } },
      "file",
    );
    expect(svc.constrainedProviders()).toEqual([]);
  });

  it("falls back to default constrained_providers when all configured providers are invalid", () => {
    const svc = buildModelPolicyService(
      { constrained_providers: ["bogus"], default: { primary: { runtime: "codex" } } },
      "file",
    );
    expect(svc.constrainedProviders()).toEqual(DEFAULT_CONSTRAINED_PROVIDERS);
  });

  it("filters invalid configured providers without discarding valid providers", () => {
    const svc = buildModelPolicyService(
      { constrained_providers: ["bogus", "anthropic"], default: { primary: { runtime: "codex" } } },
      "file",
    );
    expect(svc.constrainedProviders()).toEqual(["anthropic"]);
  });
});

describe("resolver — Codex Light", () => {
  const svc = buildModelPolicyService(CODEX_LIGHT, "file");

  it("uses the primary (codex) when nothing is constrained", () => {
    const r = svc.resolveModelChoice({ agent: "roger", unavailableProviders: [] });
    expect(r.choice.runtime).toBe("codex");
    expect(r.choice.provider).toBe("openai");
    expect(r.source).toBe("primary");
    expect(r.fallback_applied).toBe(false);
  });

  it("falls back to Claude when openai is constrained", () => {
    const r = svc.resolveModelChoice({ agent: "roger", unavailableProviders: ["openai"] });
    expect(r.choice.runtime).toBe("claude-code-cli");
    expect(r.choice.provider).toBe("anthropic");
    expect(r.source).toBe("fallback");
    expect(r.fallback_applied).toBe(true);
  });

  it("walks the chain to openrouter when openai AND anthropic are constrained", () => {
    const r = svc.resolveModelChoice({ agent: "roger", unavailableProviders: ["openai", "anthropic"] });
    expect(r.choice.runtime).toBe("openrouter");
    expect(r.choice.provider).toBe("other");
    expect(r.fallback_applied).toBe(true);
  });

  it("forces the primary when every provider in the chain is constrained", () => {
    const r = svc.resolveModelChoice({ agent: "roger", unavailableProviders: ["openai", "anthropic", "other"] });
    expect(r.source).toBe("primary_forced");
    expect(r.choice.runtime).toBe("codex");
  });

  it("honors a per-agent override (sentinel = Claude primary, no codex)", () => {
    const r = svc.resolveModelChoice({ agent: "sentinel", unavailableProviders: [] });
    expect(r.policy_agent).toBe("sentinel");
    expect(r.choice.runtime).toBe("claude-code-cli");
  });

  it("an unknown agent falls through to the default policy", () => {
    const r = svc.resolveModelChoice({ agent: "totally-new-agent", unavailableProviders: [] });
    expect(r.policy_agent).toBe("*");
    expect(r.choice.runtime).toBe("codex");
  });
});

describe("loadModelPolicy degradation", () => {
  it("degrades to the builtin Codex Light default when the config is missing/broken", () => {
    const svc = loadModelPolicy({
      configPath: "/nonexistent/model-policy.json",
      readFile: () => {
        throw new Error("ENOENT");
      },
      onWarn: () => {},
    });
    expect(svc.config.source).toBe("builtin_default");
    expect(svc.config.default.primary.runtime).toBe("codex");
    expect(svc.config.default.fallback[0].runtime).toBe("claude-code-cli");
  });

  it("loads a valid config via the injected reader", () => {
    const svc = loadModelPolicy({
      configPath: "/x/model-policy.json",
      readFile: () => JSON.stringify(CODEX_LIGHT),
      onWarn: () => {},
    });
    expect(svc.config.source).toBe("file");
    expect(svc.config.agents.sentinel.primary.runtime).toBe("claude-code-cli");
  });
});

describe("Slice G project-agent policy migration", () => {
  const claudePrimaryAgents = new Set(["cto", "maestra", "rams"]);
  const projectAgents = [
    "blowout",
    "brunel",
    "cane",
    "cleveland-park",
    "cto",
    "defi",
    "eames",
    "finances",
    "gaudi",
    "hopper",
    "maestra",
    "personal",
    "pipeline",
    "politics",
    "rams",
    "regina",
    "roger",
    "sentinel",
    "trinity",
  ];

  it("gives every canonical project agent an explicit policy with documented Fable exceptions", () => {
    const svc = loadModelPolicy({
      configPath: "configs/model-policy.json",
      onWarn: (msg) => {
        throw new Error(msg);
      },
    });

    expect(Object.keys(svc.config.agents).sort()).toEqual(projectAgents);
    for (const agent of projectAgents) {
      const policy = svc.policyForAgent(agent);
      expect(policy.agent).toBe(agent);
      if (claudePrimaryAgents.has(agent)) {
        expect(policy.primary).toMatchObject({
          runtime: "claude-code-cli",
          model: "claude-fable-5",
          provider: "anthropic",
        });
        expect(policy.fallback).toHaveLength(1);
        expect(policy.fallback[0]).toMatchObject({
          runtime: "codex",
          model: "gpt-5.6",
          provider: "openai",
        });

        const fallback = svc.resolveModelChoice({ agent, unavailableProviders: ["anthropic"] });
        expect(fallback.choice.runtime).toBe("codex");
        expect(fallback.choice.provider).toBe("openai");
        expect(fallback.fallback_applied).toBe(true);
      } else {
        expect(policy.primary).toMatchObject({
          runtime: "codex",
          model: "gpt-5.6",
          provider: "openai",
        });
        expect(policy.fallback).toHaveLength(1);
        expect(policy.fallback[0]).toMatchObject({
          runtime: "claude-code-cli",
          model: "claude-sonnet-5",
          provider: "anthropic",
        });

        const fallback = svc.resolveModelChoice({ agent, unavailableProviders: ["openai"] });
        expect(fallback.choice.runtime).toBe("claude-code-cli");
        expect(fallback.choice.provider).toBe("anthropic");
        expect(fallback.fallback_applied).toBe(true);
      }
    }
  });
});

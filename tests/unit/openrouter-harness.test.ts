// OpenRouter harness + runtime/provider wiring (D3 runtime-provider slice).
// Proves the harness targets the OpenRouter endpoint (NOT Anthropic), passes
// the model + bearer key, and that the `openrouter` runtime resolves to the
// "other" provider lane for usage attribution. fetch is mocked — no spend.

import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterHarness } from "../../src/harness/openrouter.js";
import { createHarness } from "../../src/harness/index.js";
import { getRuntimeProfile, validateRuntimePreflight } from "../../src/runtime/registry.js";
import { resolveProviderFromRuntime, normalizeRuntime } from "../../src/dispatch-scheduler/types.js";
import { providerLabel } from "../../src/usage-meter/daily-report.js";
import type { HarnessMessage } from "../../src/harness/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function drain(gen: AsyncGenerator<HarnessMessage>): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("OpenRouter harness", () => {
  it("POSTs to the OpenRouter endpoint (not Anthropic) with model + bearer, and returns the completion + usage", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) =>
      new Response(
        JSON.stringify({
          model: "z-ai/glm-5.2",
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const harness = new OpenRouterHarness();
    const messages = await drain(
      harness.run("ping", { model: "z-ai/glm-5.2", env: { OPENROUTER_API_KEY: "sk-or-test" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("openrouter.ai");
    expect(String(url)).not.toContain("anthropic");
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("z-ai/glm-5.2");
    expect(body.stream).toBe(false);

    const result = messages.find((m) => m.type === "result");
    expect(result?.result).toBe("pong");
    expect(result?.provider).toBe("openrouter");
    expect(result?.usage).toEqual({ input_tokens: 5, output_tokens: 1, total_tokens: 6 });
  });

  it("errors (without calling fetch) when OPENROUTER_API_KEY is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = new OpenRouterHarness();
    const messages = await drain(harness.run("ping", { model: "z-ai/glm-5.2", env: {} }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === "error" && /OPENROUTER_API_KEY/.test(m.content ?? ""))).toBe(true);
  });

  it("surfaces non-2xx HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const harness = new OpenRouterHarness();
    const messages = await drain(harness.run("ping", { env: { OPENROUTER_API_KEY: "sk-or-test" } }));
    expect(messages.some((m) => m.type === "error" && /401/.test(m.content ?? ""))).toBe(true);
  });
});

describe("openrouter runtime + provider wiring", () => {
  it("createHarness('openrouter') returns the OpenRouter harness", () => {
    expect(createHarness("openrouter")).toBeInstanceOf(OpenRouterHarness);
  });

  it("registry profile is OpenRouter, api-key auth, default z-ai/glm-5.2", () => {
    const p = getRuntimeProfile("openrouter");
    expect(p.providerName).toBe("OpenRouter");
    expect(p.auth.mode).toBe("api-key");
    expect(p.auth.requiredEnv).toContain("OPENROUTER_API_KEY");
    expect(p.defaultModel).toBe("z-ai/glm-5.2");
  });

  it("preflight flags a missing OPENROUTER_API_KEY", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const issues = validateRuntimePreflight("openrouter");
      expect(issues.some((i) => i.code === "openrouter_api_key_missing")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("attributes the openrouter runtime to the 'other' provider lane => label 'Other'", () => {
    expect(normalizeRuntime("openrouter")).toBe("openrouter");
    expect(resolveProviderFromRuntime("openrouter")).toBe("other");
    expect(providerLabel(resolveProviderFromRuntime("openrouter"))).toBe("Other");
  });
});

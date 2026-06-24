// S2 — suggest-next-step: prompt construction, actor attribution, and the route.

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import { buildSuggestPrompt, suggestNextStep } from "../../src/suggest/service.js";
import {
  mountSuggestRoutes,
  parseSuggestRuntimeFlag,
  selectSuggestRuntime,
  type CursorHealthProbe,
} from "../../src/suggest/routes.js";
import { createCursorCliLlmComplete } from "../../src/suggest/llm-cursor-cli.js";
import { LlmUnavailableError, type LlmComplete } from "../../src/suggest/types.js";

const fakeLlm = (text: string, model = "anthropic/claude-opus-4-8"): LlmComplete =>
  async () => ({ text, model, provider: "openrouter", usage: { input_tokens: 10, output_tokens: 5 } });

describe("buildSuggestPrompt", () => {
  it("includes the task text, project, owner, and context", () => {
    const p = buildSuggestPrompt({
      task: { text: "Wire the dead button", project: "kapelle", owner: "regina" },
      context: "TaskSweep.tsx:759",
    });
    expect(p).toContain("Wire the dead button");
    expect(p).toContain("project: kapelle");
    expect(p).toContain("owner: regina");
    expect(p).toContain("TaskSweep.tsx:759");
    expect(p).toMatch(/single most useful NEXT STEP/i);
  });

  it("is deterministic and omits absent fields", () => {
    const a = buildSuggestPrompt({ task: { text: "do x" } });
    const b = buildSuggestPrompt({ task: { text: "do x" } });
    expect(a).toBe(b);
    expect(a).not.toContain("project:");
    expect(a).not.toContain("owner:");
  });
});

describe("suggestNextStep service", () => {
  it("returns an actor-attributed suggestion", async () => {
    const r = await suggestNextStep(
      { task: { text: "do the thing", id: "t1" } },
      { llmComplete: fakeLlm("Open the file and implement the handler."), now: () => new Date("2026-06-23T00:00:00Z") },
    );
    expect(r.suggestion).toBe("Open the file and implement the handler.");
    expect(r.actor).toEqual({
      kind: "service",
      id: "suggest-next-step",
      label: "Suggest Next Step",
      model: "anthropic/claude-opus-4-8",
      provider: "openrouter",
    });
    expect(r.model).toBe("anthropic/claude-opus-4-8");
    expect(r.task_id).toBe("t1");
    expect(r.generated_at).toBe("2026-06-23T00:00:00.000Z");
  });

  it("throws on empty task text", async () => {
    await expect(suggestNextStep({ task: { text: "" } }, { llmComplete: fakeLlm("x") })).rejects.toThrow(
      /task\.text is required/,
    );
  });

  it("treats an empty LLM response as unavailable", async () => {
    await expect(
      suggestNextStep({ task: { text: "do x" } }, { llmComplete: fakeLlm("   ") }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

// ── Route ──
async function call(app: Express, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}/suggest-next-step`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function appWith(llm: LlmComplete): Express {
  const app = express();
  app.use(express.json());
  mountSuggestRoutes(app, { llmComplete: llm, now: () => new Date("2026-06-23T00:00:00Z") });
  return app;
}

describe("POST /suggest-next-step", () => {
  it("returns 200 with an actor-attributed suggestion (nested task)", async () => {
    const app = appWith(fakeLlm("Run the failing test and read the stack trace."));
    const { status, body } = await call(app, { task: { text: "fix the bug", project: "kapelle", id: "t9" } });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.suggestion).toMatch(/failing test/);
    expect(body.actor.id).toBe("suggest-next-step");
    expect(body.actor.model).toBe("anthropic/claude-opus-4-8");
    expect(body.task_id).toBe("t9");
  });

  it("accepts a flat body { text }", async () => {
    const app = appWith(fakeLlm("Draft the spec."));
    const { status, body } = await call(app, { text: "write the spec" });
    expect(status).toBe(200);
    expect(body.suggestion).toBe("Draft the spec.");
  });

  it("returns 400 when task text is missing", async () => {
    const app = appWith(fakeLlm("x"));
    const { status, body } = await call(app, { task: { project: "kapelle" } });
    expect(status).toBe(400);
    expect(body.error).toBe("task_text_required");
  });

  it("returns 503 when the LLM is unavailable (no key)", async () => {
    const app = appWith(async () => {
      throw new LlmUnavailableError("no key");
    });
    const { status, body } = await call(app, { text: "do x" });
    expect(status).toBe(503);
    expect(body.error).toBe("llm_unavailable");
  });

  it("returns 502 on a generic LLM failure", async () => {
    const app = appWith(async () => {
      throw new Error("OpenRouter HTTP 500");
    });
    const { status, body } = await call(app, { text: "do x" });
    expect(status).toBe(502);
    expect(body.error).toBe("suggest_failed");
  });
});

// ── cursor-cli runtime lane ──

describe("parseSuggestRuntimeFlag", () => {
  it("defaults to openrouter", () => {
    expect(parseSuggestRuntimeFlag({})).toBe("openrouter");
    expect(parseSuggestRuntimeFlag({ SUGGEST_NEXT_STEP_RUNTIME: "" })).toBe("openrouter");
    expect(parseSuggestRuntimeFlag({ SUGGEST_NEXT_STEP_RUNTIME: "openrouter" })).toBe("openrouter");
  });

  it("selects cursor-cli for cursor-cli / cursor (case-insensitive)", () => {
    expect(parseSuggestRuntimeFlag({ SUGGEST_NEXT_STEP_RUNTIME: "cursor-cli" })).toBe("cursor-cli");
    expect(parseSuggestRuntimeFlag({ SUGGEST_NEXT_STEP_RUNTIME: "Cursor" })).toBe("cursor-cli");
    expect(parseSuggestRuntimeFlag({ SUGGEST_NEXT_STEP_RUNTIME: " CURSOR-CLI " })).toBe("cursor-cli");
  });
});

describe("selectSuggestRuntime", () => {
  it("routes to cursor-cli only when flagged AND cursor is live", () => {
    expect(selectSuggestRuntime("cursor-cli", "live")).toBe("cursor-cli");
  });

  it("auto-excludes a degraded/unavailable host (falls back to openrouter)", () => {
    expect(selectSuggestRuntime("cursor-cli", "degraded")).toBe("openrouter");
    expect(selectSuggestRuntime("cursor-cli", "unavailable")).toBe("openrouter");
    expect(selectSuggestRuntime("cursor-cli", null)).toBe("openrouter");
  });

  it("stays on openrouter when the flag is off, regardless of health", () => {
    expect(selectSuggestRuntime("openrouter", "live")).toBe("openrouter");
  });
});

describe("createCursorCliLlmComplete", () => {
  it("shells cursor-agent with --print/text/-f and a pinned model, returning the trimmed text", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const complete = createCursorCliLlmComplete({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "  Open the file and add the handler.\n", stderr: "" };
      },
    });
    const r = await complete("the prompt");
    expect(r.text).toBe("Open the file and add the handler.");
    expect(r.provider).toBe("cursor-cli");
    expect(r.model).toBe("sonnet-4");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["--print", "--output-format", "text", "-f", "--model", "sonnet-4", "the prompt"]);
  });

  it("honors a model override and CURSOR_AGENT_PATH", async () => {
    let usedFile = "";
    let usedArgs: string[] = [];
    const complete = createCursorCliLlmComplete({
      env: { CURSOR_AGENT_PATH: "/opt/cursor-agent", SUGGEST_NEXT_STEP_CURSOR_MODEL: "gpt-5.2" },
      execFile: async (file, args) => {
        usedFile = file;
        usedArgs = args;
        return { stdout: "ok", stderr: "" };
      },
    });
    await complete("p");
    expect(usedFile).toBe("/opt/cursor-agent");
    expect(usedArgs).toContain("gpt-5.2");
  });

  it("maps a spawn failure to LlmUnavailableError", async () => {
    const complete = createCursorCliLlmComplete({
      env: {},
      execFile: async () => {
        throw new Error("spawn cursor-agent ENOENT");
      },
    });
    await expect(complete("p")).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("treats empty stdout as unavailable", async () => {
    const complete = createCursorCliLlmComplete({
      env: {},
      execFile: async () => ({ stdout: "   ", stderr: "" }),
    });
    await expect(complete("p")).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("POST /suggest-next-step — flag-gated cursor-cli", () => {
  const cursorLlm: LlmComplete = async () => ({
    text: "Pin the model and re-run.",
    model: "sonnet-4",
    provider: "cursor-cli",
  });

  function appWithRuntime(env: NodeJS.ProcessEnv, cursorStatus: CursorHealthProbe): Express {
    const app = express();
    app.use(express.json());
    mountSuggestRoutes(app, {
      env,
      llmComplete: fakeLlm("openrouter answer"),
      cursorLlmComplete: cursorLlm,
      checkCursorHealth: cursorStatus,
      now: () => new Date("2026-06-23T00:00:00Z"),
    });
    return app;
  }

  it("routes through cursor-cli when flagged and the host is live", async () => {
    const app = appWithRuntime({ SUGGEST_NEXT_STEP_RUNTIME: "cursor-cli" }, async () => "live");
    const { status, body } = await call(app, { text: "do x" });
    expect(status).toBe(200);
    expect(body.provider).toBe("cursor-cli");
    expect(body.suggestion).toBe("Pin the model and re-run.");
  });

  it("falls back to openrouter when the host is degraded", async () => {
    const app = appWithRuntime({ SUGGEST_NEXT_STEP_RUNTIME: "cursor-cli" }, async () => "degraded");
    const { status, body } = await call(app, { text: "do x" });
    expect(status).toBe(200);
    expect(body.provider).toBe("openrouter");
  });

  it("stays on openrouter when the flag is off (cursor health never probed)", async () => {
    let probed = false;
    const app = appWithRuntime({}, async () => {
      probed = true;
      return "live";
    });
    const { status, body } = await call(app, { text: "do x" });
    expect(status).toBe(200);
    expect(body.provider).toBe("openrouter");
    expect(probed).toBe(false);
  });
});

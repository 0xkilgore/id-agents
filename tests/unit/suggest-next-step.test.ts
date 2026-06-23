// S2 — suggest-next-step: prompt construction, actor attribution, and the route.

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import { buildSuggestPrompt, suggestNextStep } from "../../src/suggest/service.js";
import { mountSuggestRoutes } from "../../src/suggest/routes.js";
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

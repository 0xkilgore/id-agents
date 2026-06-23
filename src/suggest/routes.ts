// S2 — Express route: POST /suggest-next-step.
//
// Manager LLM route the kapelle-site TaskSweep "Suggest next step" button calls.
// Accepts a task (+ optional project/context) and returns ONE actor-attributed
// next-step suggestion. The LLM caller is injectable; production defaults to the
// OpenRouter-backed caller routed to a Claude model.

import type { Application, Request, Response } from "express";
import { suggestNextStep, type SuggestDeps } from "./service.js";
import { createOpenRouterLlmComplete } from "./llm-openrouter.js";
import { LlmUnavailableError, type LlmComplete, type SuggestNextStepInput } from "./types.js";

export interface MountSuggestRoutesOptions {
  /** Override the LLM caller (tests / alternate providers). Defaults to OpenRouter→Claude. */
  llmComplete?: LlmComplete;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export function mountSuggestRoutes(app: Application, opts: MountSuggestRoutesOptions = {}): void {
  const llmComplete = opts.llmComplete ?? createOpenRouterLlmComplete({ env: opts.env });
  const deps: SuggestDeps = { llmComplete, now: opts.now };

  // POST /suggest-next-step { task: { text, project?, owner?, id? }, project?, context? }
  app.post("/suggest-next-step", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const input = normalizeInput(body);
      if (!input) {
        res.status(400).json({
          ok: false,
          error: "task_text_required",
          message: "body.task.text (or body.text) is required",
        });
        return;
      }
      const result = await suggestNextStep(input, deps);
      res.json(result);
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        res.status(503).json({ ok: false, error: "llm_unavailable", message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/task\.text is required/.test(message)) {
        res.status(400).json({ ok: false, error: "task_text_required", message });
        return;
      }
      res.status(502).json({ ok: false, error: "suggest_failed", message });
    }
  });
}

/** Accept either `{ task: {...} }` or a flat `{ text, project, owner, id }` body. */
function normalizeInput(body: Record<string, unknown>): SuggestNextStepInput | null {
  const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const taskRaw = (body.task && typeof body.task === "object" ? (body.task as Record<string, unknown>) : body) as Record<
    string,
    unknown
  >;
  const text = asStr(taskRaw.text);
  if (!text) return null;
  return {
    task: {
      text,
      project: asStr(taskRaw.project),
      owner: asStr(taskRaw.owner),
      id: asStr(taskRaw.id),
    },
    project: asStr(body.project),
    context: asStr(body.context),
  };
}

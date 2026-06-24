// S2 — Express route: POST /suggest-next-step.
//
// Manager LLM route the kapelle-site TaskSweep "Suggest next step" button calls.
// Accepts a task (+ optional project/context) and returns ONE actor-attributed
// next-step suggestion. The LLM caller is injectable; production defaults to the
// OpenRouter-backed caller routed to a Claude model.

import type { Application, Request, Response } from "express";
import { suggestNextStep, type SuggestDeps } from "./service.js";
import { createOpenRouterLlmComplete } from "./llm-openrouter.js";
import { createCursorCliLlmComplete } from "./llm-cursor-cli.js";
import { LlmUnavailableError, type LlmComplete, type SuggestNextStepInput } from "./types.js";
import {
  checkCursorFallbackHealth,
  type CursorFallbackStatus,
} from "../harness/cursor-fallback-health.js";

/** Which runtime serves a suggestion. OpenRouter→Claude is the default lane. */
export type SuggestRuntime = "openrouter" | "cursor-cli";

/** A live-or-cached cursor health probe; returns just the status. */
export type CursorHealthProbe = () => Promise<CursorFallbackStatus>;

/** How long a live cursor-health smoke result is reused before re-probing. */
const DEFAULT_HEALTH_TTL_MS = 60_000;

export interface MountSuggestRoutesOptions {
  /** Override the LLM caller (tests / alternate providers). Defaults to OpenRouter→Claude. */
  llmComplete?: LlmComplete;
  /** Override the cursor-cli LLM caller (tests). Defaults to the cursor-agent caller. */
  cursorLlmComplete?: LlmComplete;
  /** Override the cursor health probe (tests). Defaults to a live cursor-agent smoke. */
  checkCursorHealth?: CursorHealthProbe;
  /** TTL for caching the cursor-health probe between requests. */
  healthTtlMs?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read the runtime flag. `cursor-cli` (or `cursor`) routes through the Cursor
 * Agent CLI (budget-independent, Chris's paid plan); anything else stays on the
 * default OpenRouter→Claude lane.
 */
export function parseSuggestRuntimeFlag(env: NodeJS.ProcessEnv = process.env): SuggestRuntime {
  const v = (env.SUGGEST_NEXT_STEP_RUNTIME || "").trim().toLowerCase();
  return v === "cursor-cli" || v === "cursor" ? "cursor-cli" : "openrouter";
}

/**
 * Pure runtime selector. Cursor only wins when the flag asks for it AND the
 * host's cursor fallback is `live` — a `degraded`/`unavailable` host auto-excludes
 * itself and the suggestion falls back to OpenRouter.
 */
export function selectSuggestRuntime(
  flag: SuggestRuntime,
  cursorStatus: CursorFallbackStatus | null,
): SuggestRuntime {
  return flag === "cursor-cli" && cursorStatus === "live" ? "cursor-cli" : "openrouter";
}

/** TTL-cached wrapper around a cursor-health probe so we do not smoke every request. */
function makeHealthGate(
  probe: CursorHealthProbe,
  ttlMs: number,
  now: () => number,
): CursorHealthProbe {
  let cached: { status: CursorFallbackStatus; at: number } | null = null;
  return async () => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.status;
    const status = await probe();
    cached = { status, at: t };
    return status;
  };
}

export function mountSuggestRoutes(app: Application, opts: MountSuggestRoutesOptions = {}): void {
  const env = opts.env ?? process.env;
  const openrouterComplete = opts.llmComplete ?? createOpenRouterLlmComplete({ env });
  const cursorComplete = opts.cursorLlmComplete ?? createCursorCliLlmComplete({ env });
  const runtimeFlag = parseSuggestRuntimeFlag(env);
  const probe: CursorHealthProbe =
    opts.checkCursorHealth ?? (async () => (await checkCursorFallbackHealth({ live: true })).status);
  const healthGate = makeHealthGate(probe, opts.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS, () => Date.now());

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
      // Flag-gated runtime selection: cursor-cli only when the flag asks for it
      // AND the host's cursor fallback probes `live`; otherwise OpenRouter. A
      // probe failure is treated as `unavailable` so the host excludes itself.
      const cursorStatus =
        runtimeFlag === "cursor-cli"
          ? await healthGate().catch((): CursorFallbackStatus => "unavailable")
          : null;
      const runtime = selectSuggestRuntime(runtimeFlag, cursorStatus);
      const deps: SuggestDeps = {
        llmComplete: runtime === "cursor-cli" ? cursorComplete : openrouterComplete,
        now: opts.now,
      };
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

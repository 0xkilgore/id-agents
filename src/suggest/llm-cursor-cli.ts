// S2.cursor — production LLM caller for suggest-next-step via the Cursor Agent CLI.
//
// Budget-independent runtime lane: routes the suggestion through `cursor-agent`
// (driven by Chris's PAID Cursor plan) instead of the Anthropic weekly budget,
// which is the system's recurring constraint. One-shot, non-interactive:
//   cursor-agent --print --output-format text -f [--model <m>] <prompt>
// (mirrors the invocation in src/harness/cursor-fallback-health.ts). The
// execFile is INJECTED so the caller is unit-testable without spawning the
// binary, exactly like the OpenRouter caller injects fetch via env. Swapping
// providers stays a one-function change on the route deps.

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { LlmUnavailableError, type LlmComplete, type LlmCompletion } from "./types.js";

const execFileP = promisify(execFileCb);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
// Pin a fast chat model by DEFAULT. `Auto` selects an agentic (Codex-class)
// model that tries to *act* on a task-shaped prompt — it explores the workspace
// and times out instead of answering. A pinned chat model returns a single
// direct next-step in ~10s. Override with SUGGEST_NEXT_STEP_CURSOR_MODEL.
const DEFAULT_CURSOR_MODEL = "sonnet-4";

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface CursorCliLlmOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the cursor-agent binary path (defaults to env CURSOR_AGENT_PATH or PATH lookup). */
  binary?: string;
  /** Pin a model; default lets cursor-agent pick (Auto). Override via SUGGEST_NEXT_STEP_CURSOR_MODEL. */
  model?: string | null;
  timeoutMs?: number;
  /** Injected for tests; defaults to child_process.execFile. */
  execFile?: ExecFileLike;
}

function asText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value || "";
}

/**
 * Build an `LlmComplete` backed by the Cursor Agent CLI. Throws
 * `LlmUnavailableError` when the binary is missing, unauthenticated, or returns
 * no content — the route maps that to a clean 503, and the flag-gated selector
 * falls back to OpenRouter so a degraded host excludes itself.
 */
export function createCursorCliLlmComplete(opts: CursorCliLlmOptions = {}): LlmComplete {
  const env = opts.env ?? process.env;
  const binary = opts.binary || env.CURSOR_AGENT_PATH || "cursor-agent";
  const model = opts.model ?? env.SUGGEST_NEXT_STEP_CURSOR_MODEL ?? DEFAULT_CURSOR_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.execFile || execFileP;

  return async function cursorCliComplete(prompt: string): Promise<LlmCompletion> {
    const args = ["--print", "--output-format", "text", "-f"];
    if (model) args.push("--model", model);
    args.push(prompt);

    let stdout: string;
    let stderr: string;
    try {
      const res = await run(binary, args, { timeout: timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER });
      stdout = asText(res.stdout).trim();
      stderr = asText(res.stderr).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmUnavailableError(`cursor-agent suggest call failed: ${msg.slice(0, 300)}`);
    }

    if (!stdout) {
      throw new LlmUnavailableError(
        `cursor-agent returned an empty suggestion${stderr ? `; stderr=${stderr.slice(0, 200)}` : ""}`,
      );
    }

    return {
      text: stdout,
      model: model || "auto",
      provider: "cursor-cli",
    };
  };
}

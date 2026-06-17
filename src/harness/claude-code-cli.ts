// SPDX-License-Identifier: MIT
/**
 * Claude Code CLI Harness
 *
 * Wraps the Claude Code CLI (`claude`) for local agents that use the user's
 * logged-in Claude Code session instead of API keys.
 *
 * This harness spawns `claude -p "prompt" --output-format json` for each request.
 * Unlike the SDK-based ClaudeCodeHarness, this uses whatever authentication
 * method the user has configured in their local Claude Code installation.
 *
 * Session support:
 * - Uses --resume <session_id> to continue existing sessions
 * - Each agent maintains its own session for context continuity
 */

import { spawn, ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import { rotateSessionsIfNeeded } from './session-rotation.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// W-004 subprocess-timeout reliability fix.
//
// The spawned `claude` process can hang indefinitely during a dispatch — a
// child blocked on stdin (the "Not logged in · Please run /login" interactive
// prompt) or a stalled network call never closes, so the dispatch neither
// resolves nor fails: it just wedges silently. A watchdog kills the process
// and rejects so the dispatch closes as a typed error instead of hanging.
//
// The default is a generous backstop so legitimate long agent runs are not
// killed; operators tune it down via ID_AGENT_HARNESS_TIMEOUT_MS, and 0
// disables the watchdog entirely.
export const DEFAULT_HARNESS_TIMEOUT_MS = 30 * 60_000; // 30 minutes
const KILL_GRACE_MS = 2000;

/**
 * Resolve the effective harness timeout (ms). Precedence: explicit option →
 * ID_AGENT_HARNESS_TIMEOUT_MS env → DEFAULT_HARNESS_TIMEOUT_MS. A value of 0
 * disables the watchdog; a garbage/negative env value is ignored. Pure.
 */
export function resolveHarnessTimeoutMs(
  opts: { timeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0) {
    return opts.timeoutMs;
  }
  const raw = env.ID_AGENT_HARNESS_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_HARNESS_TIMEOUT_MS;
}

/** A child process we can signal — the subset of ChildProcess the watchdog needs. */
export interface KillableProcess {
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Arm a SIGTERM→SIGKILL watchdog on a child process. After `timeoutMs` it
 * calls `onTimeout()` and sends SIGTERM; if the process is still alive after
 * `graceMs` it sends SIGKILL. `timeoutMs <= 0` disables the watchdog. Returns
 * a `clear()` that cancels both timers (call it when the process exits in
 * time). Pure aside from the timers it owns; testable with fake clocks.
 */
export function armProcessTimeout(
  proc: KillableProcess,
  timeoutMs: number,
  options: { graceMs: number; onTimeout: () => void },
): () => void {
  if (!(timeoutMs > 0)) {
    return () => {};
  }
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    options.onTimeout();
    try {
      proc.kill('SIGTERM');
    } catch {
      // process already gone
    }
    killTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, options.graceMs);
    if (typeof (killTimer as { unref?: () => void }).unref === 'function') {
      (killTimer as { unref?: () => void }).unref!();
    }
  }, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref?: () => void }).unref!();
  }
  return () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  };
}

export class ClaudeCodeCliHarness implements AgentHarness {
  readonly type: HarnessType = 'claude-code-cli' as HarnessType;

  // Track the current running process for cancellation
  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();

    console.log(`[Claude CLI] Starting harness`);
    console.log(`[Claude CLI] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Claude CLI] Model: ${options.model} (will use alias if available)`);

    // Pre-launch session rotation: archive an oversize/stale Claude Code session
    // store so a long-lived agent never reloads a bloated resumed context into a
    // provider rate-limit (the Sentinel session-bloat failure). Best-effort; if
    // the resume target is rotated, we start a fresh session this launch.
    let effectiveResume = options.resume;
    try {
      const rot = rotateSessionsIfNeeded({ workingDirectory: workingDir, resume: options.resume });
      effectiveResume = rot.resume;
      if (rot.rotated.length > 0) {
        console.log(
          `[Claude CLI] 🔄 session rotation archived ${rot.rotated.length} transcript(s)` +
            `${rot.reason ? ' — ' + rot.reason : ''}`,
        );
      }
    } catch (err) {
      console.warn(`[Claude CLI] session rotation skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (effectiveResume) console.log(`[Claude CLI] Resuming session: ${effectiveResume}`);

    // Build arguments for claude CLI
    // Use stream-json for real-time visibility into what the agent is doing
    const verbose = process.env.ID_AGENT_VERBOSE === 'true';
    // Default to --dangerously-skip-permissions because background agents have
    // no interactive shell to approve prompts. The agent's
    // `dangerouslySkipPermissions: false` config can opt out; the spawn site
    // sets ID_AGENT_SKIP_PERMISSIONS=false in that case.
    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    const args: string[] = [
      '-p', prompt,
      ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
      '--output-format', verbose ? 'stream-json' : 'json',
      ...(verbose ? ['--verbose'] : [])
    ];
    console.log(`[Claude CLI] Permission mode: ${skipPermissions ? '--dangerously-skip-permissions (default)' : 'interactive (config opt-out)'}`);

    // Don't pass --model flag for CLI harness - let Claude Code use its default settings
    // This ensures Max subscription users don't get charged API credits
    // The model can still be overridden via CLAUDE_CLI_MODEL env var if needed
    if (process.env.CLAUDE_CLI_MODEL) {
      args.push('--model', process.env.CLAUDE_CLI_MODEL);
    }

    // Add session resume if provided (post-rotation: cleared when the prior
    // session was archived for being oversize).
    if (effectiveResume) {
      args.push('--resume', effectiveResume);
    }

    // Add allowed tools if specified
    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    // Build environment - inherit user's env for auth
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      // Override working directory for Claude
      PWD: workingDir
    };

    // Add any additional env vars from options
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }

    try {
      // Reset cancelled flag at start of new run
      this.cancelled = false;

      const timeoutMs = resolveHarnessTimeoutMs(options);
      const result = await this.spawnClaude(args, workingDir, env, timeoutMs);

      // Check if cancelled during execution
      if (this.cancelled) {
        yield {
          type: 'error',
          content: 'Query was cancelled'
        };
        return;
      }

      // Parse output - handle both json and stream-json formats
      if (result.stdout.trim()) {
        try {
          let jsonResult: any;

          if (verbose) {
            // stream-json: multiple JSON objects, one per line - find the result
            const lines = result.stdout.trim().split('\n');
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (msg.type === 'result') {
                  jsonResult = msg;
                  break;
                }
              } catch {
                // Skip non-JSON lines
              }
            }
          } else {
            // json: single JSON object
            jsonResult = JSON.parse(result.stdout.trim());
          }

          if (jsonResult) {
            // Yield the result
            yield {
              type: 'result',
              subtype: jsonResult.is_error ? 'error' : 'success',
              content: jsonResult.result || '',
              result: jsonResult.result || '',
              session_id: jsonResult.session_id,
              duration_ms: jsonResult.duration_ms,
              cost_usd: jsonResult.total_cost_usd
            };
          }
        } catch (parseErr) {
          // If not valid JSON, treat as plain text result
          yield {
            type: 'result',
            subtype: 'success',
            content: result.stdout.trim(),
            result: result.stdout.trim()
          };
        }
      }

      // Check for errors
      if (result.exitCode !== 0) {
        const errorMsg = result.stderr || `Claude CLI exited with code ${result.exitCode}`;
        console.error(`[Claude CLI] Error: ${errorMsg}`);
        yield {
          type: 'error',
          content: errorMsg
        };
      }
    } catch (err: any) {
      console.error(`[Claude CLI] Exception: ${err.message}`);
      yield {
        type: 'error',
        content: err.message
      };
    }
  }

  /**
   * Log a streaming message from Claude CLI in a readable format
   */
  private logStreamMessage(msg: any): void {
    const timestamp = new Date().toLocaleTimeString();

    switch (msg.type) {
      case 'assistant':
        // Assistant is thinking/responding
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              console.log(`[${timestamp}] 💭 Assistant: ${block.text.slice(0, 200)}${block.text.length > 200 ? '...' : ''}`);
            } else if (block.type === 'tool_use') {
              console.log(`[${timestamp}] 🔧 Tool: ${block.name}`);
              if (block.input) {
                const inputStr = JSON.stringify(block.input).slice(0, 150);
                console.log(`[${timestamp}]    Input: ${inputStr}${inputStr.length >= 150 ? '...' : ''}`);
              }
            }
          }
        }
        break;

      case 'user':
        // Tool results
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              const status = block.is_error ? '❌' : '✅';
              console.log(`[${timestamp}] ${status} Tool result for ${block.tool_use_id?.slice(0, 20)}...`);
            }
          }
        }
        break;

      case 'result':
        // Final result
        console.log(`[${timestamp}] 🏁 Completed (${msg.subtype})`);
        if (msg.duration_ms) {
          console.log(`[${timestamp}]    Duration: ${(msg.duration_ms / 1000).toFixed(1)}s`);
        }
        if (msg.total_cost_usd) {
          console.log(`[${timestamp}]    Cost: $${msg.total_cost_usd.toFixed(4)}`);
        }
        break;

      case 'system':
        // System messages
        if (msg.message) {
          console.log(`[${timestamp}] ℹ️  System: ${msg.message}`);
        }
        break;
    }
  }

  /**
   * Spawn the claude CLI and capture output
   */
  private spawnClaude(
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs = 0
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let clearTimeoutWatchdog: () => void = () => {};

      // Use full path to claude to avoid PATH resolution issues in detached processes
      // Can be overridden via CLAUDE_PATH env var
      const claudePath = process.env.CLAUDE_PATH || 'claude';

      console.log(`[Claude CLI] Spawning: ${claudePath} ${args.slice(0, 3).join(' ')}...`);
      console.log(`[Claude CLI] Working directory: ${cwd}`);
      console.log(`[Claude CLI] PATH: ${env.PATH?.slice(0, 100)}...`);

      // Write prompt to temp file to avoid command line length issues
      const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}.txt`);

      // Get the prompt from args (first arg after -p)
      const promptIndex = args.indexOf('-p');
      const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';

      // Write prompt to file
      fs.writeFileSync(tmpFile, prompt);

      // Build args without the prompt, using file input
      const newArgs = args.filter((_, i) => i !== promptIndex && i !== promptIndex + 1);

      // Read prompt from file using shell redirection
      const quotedArgs = newArgs.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
      const fullCommand = `${claudePath} -p "$(cat ${tmpFile})" ${quotedArgs}; rm ${tmpFile}`;

      console.log(`[Claude CLI] Prompt written to temp file: ${tmpFile} (${prompt.length} chars)`);
      console.log(`[Claude CLI] Full command: ${claudePath} -p "$(cat ...)" ${quotedArgs}`);

      // Strip Claude Code session vars so the child `claude` process doesn't
      // refuse to start ("cannot be launched inside another Claude Code session").
      // Incident 2026-05-28: manager inherited CLAUDECODE from a parent Claude
      // Code shell and poisoned every spawned agent.
      const childEnv = { ...env };
      delete childEnv.CLAUDECODE;
      delete childEnv.CLAUDE_CODE_SSE_PORT;
      delete childEnv.CLAUDE_CODE_ENTRYPOINT;

      const proc = spawn('/bin/bash', ['-c', fullCommand], {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Store process reference for cancellation
      this.currentProcess = proc;

      // Close stdin immediately since we don't need it
      proc.stdin?.end();

      console.log(`[Claude CLI] Process spawned, PID: ${proc.pid}`);

      // W-004: arm a watchdog so a hung child (e.g. blocked on the
      // "Not logged in" interactive prompt, or a stalled network call) is
      // killed and surfaced as a typed error instead of wedging the dispatch.
      clearTimeoutWatchdog = armProcessTimeout(proc, timeoutMs, {
        graceMs: KILL_GRACE_MS,
        onTimeout: () => {
          timedOut = true;
          this.currentProcess = null;
          console.error(`[Claude CLI] Timed out after ${timeoutMs}ms (PID: ${proc.pid}); killing.`);
          // Best-effort temp-file cleanup (the trailing `rm` won't run on kill).
          try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
          reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
        },
      });

      const verbose = process.env.ID_AGENT_VERBOSE === 'true';

      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // In verbose mode, parse and log streaming JSON messages
        if (verbose) {
          // Stream-json outputs one JSON object per line
          const lines = chunk.split('\n').filter((l: string) => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              this.logStreamMessage(msg);
            } catch {
              // Not valid JSON, might be partial - ignore
            }
          }
        } else {
          // Log progress for long-running processes
          if (stdout.length % 1000 < chunk.length) {
            console.log(`[Claude CLI] Received ${stdout.length} bytes of stdout...`);
          }
        }
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        // Log stderr in real-time for debugging
        if (chunk.trim()) {
          console.log(`[Claude CLI] stderr: ${chunk.trim()}`);
        }
      });

      proc.on('error', (err) => {
        clearTimeoutWatchdog();
        if (timedOut) return; // already rejected by the watchdog
        console.error(`[Claude CLI] Spawn error: ${err.message}`);
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeoutWatchdog();
        if (timedOut) return; // already rejected by the watchdog

        // Clear process reference
        this.currentProcess = null;

        console.log(`[Claude CLI] Process exited with code ${code}`);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1
        });
      });
    });
  }

  /**
   * Cancel the currently running query.
   * Kills the underlying process if one is running.
   * @returns true if a process was cancelled, false if nothing was running
   */
  cancel(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      const pid = this.currentProcess.pid;
      console.log(`[Claude CLI] Cancelling process PID: ${pid}`);
      this.cancelled = true;

      // Kill the bash process (which will also kill claude as its child)
      this.currentProcess.kill('SIGTERM');

      // Force kill after 2 seconds if still running
      const proc = this.currentProcess;
      setTimeout(() => {
        if (proc && !proc.killed) {
          console.log(`[Claude CLI] Force killing process PID: ${pid}`);
          proc.kill('SIGKILL');
        }
      }, 2000);

      return true;
    }
    return false;
  }
}

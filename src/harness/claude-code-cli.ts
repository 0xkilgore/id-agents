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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    if (options.resume) console.log(`[Claude CLI] Resuming session: ${options.resume}`);

    // Build arguments for claude CLI
    // Use stream-json for real-time visibility into what the agent is doing
    const verbose = process.env.ID_AGENT_VERBOSE === 'true';
    // --dangerously-skip-permissions is non-negotiable for this runtime.
    // Agents run as background processes with no interactive shell; any
    // permission prompt would hang the process silently. The YAML field
    // `dangerouslySkipPermissions` is ignored — the flag is always passed.
    const args: string[] = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', verbose ? 'stream-json' : 'json',
      ...(verbose ? ['--verbose'] : [])
    ];
    console.log(`[Claude CLI] Permission mode: --dangerously-skip-permissions (forced for background agents)`);

    // Don't pass --model flag for CLI harness - let Claude Code use its default settings
    // This ensures Max subscription users don't get charged API credits
    // The model can still be overridden via CLAUDE_CLI_MODEL env var if needed
    if (process.env.CLAUDE_CLI_MODEL) {
      args.push('--model', process.env.CLAUDE_CLI_MODEL);
    }

    // Add session resume if provided
    if (options.resume) {
      args.push('--resume', options.resume);
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

      const result = await this.spawnClaude(args, workingDir, env);

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
    env: Record<string, string>
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

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

      const proc = spawn('/bin/bash', ['-c', fullCommand], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Store process reference for cancellation
      this.currentProcess = proc;

      // Close stdin immediately since we don't need it
      proc.stdin?.end();

      console.log(`[Claude CLI] Process spawned, PID: ${proc.pid}`);

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
        console.error(`[Claude CLI] Spawn error: ${err.message}`);
        reject(err);
      });

      proc.on('close', (code) => {
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

// SPDX-License-Identifier: MIT
/**
 * Codex CLI Harness
 *
 * Wraps the OpenAI Codex CLI (`codex exec`) for agents.
 * Supports both API key auth (OPENAI_API_KEY) and OAuth login (codex login).
 *
 * Spawns `codex exec "<prompt>" --json --cd <dir>` for each request.
 * Parses JSONL output and yields HarnessMessage objects.
 *
 * Session support:
 * - Runs each request as a fresh `codex exec` invocation
 * - Ignores resume IDs because the installed Codex CLI does not support
 *   combining `resume` with the non-interactive flags used here
 */

import { spawn, ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export class CodexHarness implements AgentHarness {
  readonly type: HarnessType = 'codex' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();

    console.log(`[Codex] Starting harness`);
    console.log(`[Codex] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Codex] Model: ${options.model}`);

    // Build arguments for codex exec. For this Codex CLI version, flags must
    // come before the `resume` subcommand.
    const args: string[] = ['exec'];

    // Working directory
    args.push('--cd', workingDir);

    // JSON output for parsing
    args.push('--json');

    // Model override
    if (options.model) {
      args.push('--model', options.model);
    }

    // Full auto mode — no interactive approvals
    args.push('--full-auto');

    // Skip git repo check in case working dir isn't a git repo
    args.push('--skip-git-repo-check');

    // Write prompt to temp file to avoid shell escaping issues
    const promptFile = path.join(os.tmpdir(), `codex-prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, prompt);
    console.log(`[Codex] Prompt written to temp file: ${promptFile} (${prompt.length} chars)`);

    // The installed Codex CLI does not support `resume` combined with the
    // non-interactive flags we need here. Run each query as a fresh exec.
    if (options.resume) {
      console.log(`[Codex] Ignoring resume session for compatibility: ${options.resume}`);
    }

    // Read prompt from stdin
    args.push('-');

    console.log(`[Codex] Full command: codex ${args.join(' ')}`);

    this.cancelled = false;

    // Issue 4: Merge options.env WITH process.env instead of replacing
    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;

    const proc = spawn('codex', args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;

    // Issue 4: Handle spawn errors
    let spawnError: Error | null = null;
    proc.on('error', (err) => {
      console.error(`[Codex] Process error: ${err.message}`);
      spawnError = err;
    });

    console.log(`[Codex] Process spawned, PID: ${proc.pid}`);

    // Write prompt to stdin and close
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Clean up temp file
    try { fs.unlinkSync(promptFile); } catch {}

    let lastResult = '';
    let sessionId: string | undefined;
    let buffer = '';

    // Issue 4: Guard stdout/stderr with null checks
    const stdout = proc.stdout;
    const stderr = proc.stderr;

    // Collect stderr for error reporting
    let stderrText = '';
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
      });
    }

    // Issue 3: Track both stdout end and process exit with a counter
    let completionCount = 0;
    const targetCompletions = 2; // stdout end + process exit
    let exitCode: number | null = null;

    const completionPromise = new Promise<void>((resolve) => {
      const checkDone = () => {
        completionCount++;
        if (completionCount >= targetCompletions) {
          resolve();
        }
      };

      if (stdout) {
        stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            if (line.trim()) lines.push(line.trim());
          }
        });
        stdout.on('end', () => {
          if (buffer.trim()) lines.push(buffer.trim());
          checkDone();
        });
      } else {
        checkDone(); // No stdout — count it as done
      }

      proc.on('exit', (code) => {
        console.log(`[Codex] Process exited with code ${code}`);
        exitCode = code;
        checkDone();
      });
    });

    // Process lines as they arrive
    const lines: string[] = [];
    const processedLines = new Set<number>();
    let done = false;

    completionPromise.then(() => { done = true; });

    // Yield messages as lines arrive
    while (!done || processedLines.size < lines.length) {
      await new Promise(r => setTimeout(r, 100));

      for (let i = processedLines.size; i < lines.length; i++) {
        processedLines.add(i);
        const line = lines[i];

        try {
          const event = JSON.parse(line);

          switch (event.type) {
            case 'thread.started': {
              sessionId = event.thread_id;
              yield {
                type: 'system',
                subtype: 'init',
                session_id: sessionId,
              };
              break;
            }

            // Issue 2: session_configured event
            case 'session_configured': {
              yield {
                type: 'system',
                subtype: 'configured',
                session_id: sessionId,
              };
              break;
            }

            case 'turn.started': {
              yield {
                type: 'progress',
                content: 'Processing...',
              };
              break;
            }

            case 'item.completed': {
              const item = event.item;
              if (!item) break;

              switch (item.type) {
                case 'agent_message': {
                  // Issue 5: Track last result but yield as progress, not result
                  lastResult = item.text || '';
                  yield {
                    type: 'progress',
                    subtype: 'agent_message',
                    content: lastResult,
                  };
                  break;
                }

                case 'reasoning': {
                  yield {
                    type: 'thinking',
                    content: item.text || '',
                  };
                  break;
                }

                case 'command_execution': {
                  const status = item.status === 'completed' ? 'completed' : 'running';
                  yield {
                    type: 'tool_use',
                    tool_name: 'bash',
                    subtype: status,
                    content: item.command || '',
                    output: item.aggregated_output?.slice(0, 500) || '',
                    exit_code: item.exit_code,
                  };
                  break;
                }

                case 'file_edit':
                case 'file_create':
                case 'file_read': {
                  yield {
                    type: 'tool_use',
                    tool_name: item.type,
                    content: item.path || item.file || '',
                  };
                  break;
                }

                default: {
                  // Unknown item type — yield as progress
                  if (item.text) {
                    yield {
                      type: 'progress',
                      content: item.text,
                    };
                  }
                  break;
                }
              }
              break;
            }

            case 'item.started': {
              const item = event.item;
              if (item?.type === 'command_execution') {
                yield {
                  type: 'tool_use',
                  tool_name: 'bash',
                  subtype: 'started',
                  content: item.command || '',
                };
              }
              break;
            }

            // Issue 2: exec_command_begin
            case 'exec_command_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'started',
                content: event.command || '',
              };
              break;
            }

            // Issue 2: exec_command_output_delta
            case 'exec_command_output_delta': {
              yield {
                type: 'progress',
                subtype: 'command_output',
                content: event.delta || event.output || '',
              };
              break;
            }

            // Issue 2: exec_command_end
            case 'exec_command_end': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'completed',
                content: event.command || '',
                exit_code: event.exit_code,
              };
              break;
            }

            // Issue 2: agent_message_delta — streaming text
            case 'agent_message_delta': {
              yield {
                type: 'progress',
                subtype: 'message_delta',
                content: event.delta || event.text || '',
              };
              break;
            }

            // Issue 2: agent_reasoning
            case 'agent_reasoning': {
              yield {
                type: 'thinking',
                content: event.text || event.reasoning || '',
              };
              break;
            }

            // Issue 2: web_search_begin/end
            case 'web_search_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'started',
                content: event.query || '',
              };
              break;
            }
            case 'web_search_end': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'completed',
                content: event.query || '',
              };
              break;
            }

            // Issue 2: patch_apply_begin/end
            case 'patch_apply_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'started',
                content: event.path || event.file || '',
              };
              break;
            }
            case 'patch_apply_end': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'completed',
                content: event.path || event.file || '',
              };
              break;
            }

            case 'turn.completed': {
              // Issue 5: Only emit type:result here, on turn.completed
              if (lastResult) {
                yield {
                  type: 'result',
                  result: lastResult,
                  session_id: sessionId,
                };
              }
              break;
            }

            case 'error': {
              yield {
                type: 'error',
                content: event.message || event.error || 'Unknown error',
              };
              break;
            }

            default: {
              // Issue 6: Log unknown event types at debug level
              console.log(`[Codex] Unknown event type: ${event.type}`);
              break;
            }
          }
        } catch {
          // Not valid JSON — skip
        }
      }

      if (this.cancelled) {
        proc.kill('SIGTERM');
        yield { type: 'error', content: 'Cancelled' };
        break;
      }
    }

    // Issue 3: Wait for both stdout end AND process exit
    await completionPromise;

    // Issue 4: If spawn failed, yield error
    if (spawnError) {
      yield {
        type: 'error',
        content: `Process spawn error: ${(spawnError as Error).message}`,
      };
    }

    // If no result was captured, check stderr
    if (!lastResult && stderrText) {
      yield {
        type: 'error',
        content: stderrText.trim().slice(0, 500),
      };
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess) {
      this.cancelled = true;
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      return true;
    }
    return false;
  }
}

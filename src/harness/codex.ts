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
 * - Uses `codex exec resume --last` to continue existing sessions
 */

import { spawn, ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class CodexHarness implements AgentHarness {
  readonly type: HarnessType = 'codex' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();

    console.log(`[Codex] Starting harness`);
    console.log(`[Codex] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Codex] Model: ${options.model}`);

    // Build arguments for codex exec
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

    // Read prompt from stdin via the file
    args.push('-');  // Read prompt from stdin

    console.log(`[Codex] Full command: codex ${args.join(' ')}`);

    this.cancelled = false;

    const proc = spawn('codex', args, {
      cwd: workingDir,
      env: options.env as NodeJS.ProcessEnv || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;
    console.log(`[Codex] Process spawned, PID: ${proc.pid}`);

    // Write prompt to stdin and close
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Clean up temp file
    try { fs.unlinkSync(promptFile); } catch {}

    let lastResult = '';
    let sessionId: string | undefined;
    let buffer = '';

    const stdout = proc.stdout!;
    const stderr = proc.stderr!;

    // Collect stderr for error reporting
    let stderrText = '';
    stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    // Process JSONL from stdout
    const lines: string[] = [];
    const linePromise = new Promise<void>((resolve) => {
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
        resolve();
      });
    });

    // Process lines as they arrive
    const processedLines = new Set<number>();
    let done = false;

    proc.on('exit', (code) => {
      console.log(`[Codex] Process exited with code ${code}`);
      done = true;
    });

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
                  lastResult = item.text || '';
                  yield {
                    type: 'result',
                    subtype: 'text',
                    content: lastResult,
                    result: lastResult,
                    session_id: sessionId,
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

            case 'turn.completed': {
              // Final result — use the last agent_message we captured
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

    await linePromise;

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

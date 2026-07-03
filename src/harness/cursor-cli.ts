// SPDX-License-Identifier: MIT
/**
 * Cursor Agent CLI Harness
 *
 * Wraps the Cursor Agent CLI (`cursor-agent`) for local agents. Uses
 * `cursor-agent -p --output-format stream-json` in non-interactive mode.
 *
 * Authentication:
 * - CURSOR_API_KEY env var (preferred for headless agents), or
 * - an interactive `cursor-agent login` session on the host.
 *
 * Session support:
 * - Supports --resume <chatId> when `options.resume` is provided.
 *
 * Stream-json event schema (observed from cursor-agent):
 *   {type:"system",   subtype:"init",      session_id, model, cwd, permissionMode}
 *   {type:"user",     message:{role,content:[{type:"text",text}]}, session_id}
 *   {type:"thinking", subtype:"delta",     text, session_id, timestamp_ms}
 *   {type:"thinking", subtype:"completed", session_id, timestamp_ms}
 *   {type:"assistant",message:{role:"assistant",content:[{type:"text",text}]}, session_id}
 *   {type:"result",   subtype:"success"|"error", is_error, result, session_id, duration_ms, usage}
 */

import { spawn, ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import { armProcessTimeout, resolveHarnessTimeoutMs, KILL_GRACE_MS, HANG_TIMEOUT_MARKER } from './process-timeout.js';

/** Extract concatenated text from a Cursor message.content[] block. */
function extractMessageText(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

/** Mutable state for the Cursor stream-json parser. */
export interface CursorParserState {
  sessionId?: string;
  sessionInitEmitted: boolean;
  assistantReply: string;
  thinkingBuffer: string[];
  terminalEmitted: boolean;
}

export function createCursorParserState(): CursorParserState {
  return {
    sessionId: undefined,
    sessionInitEmitted: false,
    assistantReply: '',
    thinkingBuffer: [],
    terminalEmitted: false,
  };
}

/**
 * Convert a single Cursor stream-json event into zero or more HarnessMessages
 * and update the parser state. Pure function — no I/O.
 */
export function parseCursorEvent(event: any, state: CursorParserState): HarnessMessage[] {
  const out: HarnessMessage[] = [];
  if (!event || typeof event !== 'object') return out;

  const evType: string | undefined = event.type;
  const evSub: string | undefined = event.subtype;
  const evSession: string | undefined = event.session_id;

  if (evSession && !state.sessionId) {
    state.sessionId = evSession;
    if (!state.sessionInitEmitted) {
      state.sessionInitEmitted = true;
      out.push({ type: 'system', subtype: 'init', session_id: state.sessionId });
    }
  }

  switch (evType) {
    case 'system': {
      if (evSub && evSub !== 'init') {
        console.log(`[Cursor CLI] system event subtype=${evSub}`);
      }
      break;
    }

    case 'user': {
      // Echo of our own input — ignore.
      break;
    }

    case 'thinking': {
      if (evSub === 'delta' && typeof event.text === 'string' && event.text) {
        state.thinkingBuffer.push(event.text);
      }
      break;
    }

    case 'assistant': {
      const text = extractMessageText(event.message);
      if (text) state.assistantReply += text;
      break;
    }

    case 'result': {
      const isError = event.is_error === true || evSub === 'error';
      const payload: string = typeof event.result === 'string' ? event.result : '';
      if (isError) {
        const msg = payload || (typeof event.error === 'string' ? event.error : '') || 'cursor-agent reported an error';
        out.push({ type: 'error', content: msg });
      } else {
        const finalText = state.assistantReply || payload;
        if (finalText) {
          out.push({ type: 'result', result: finalText, content: finalText, session_id: state.sessionId });
        } else {
          out.push({ type: 'error', content: 'cursor-agent returned success with no assistant content' });
        }
      }
      state.terminalEmitted = true;
      break;
    }

    case 'error': {
      const msg = (typeof event.message === 'string' && event.message)
        || (typeof event.error === 'string' && event.error)
        || 'Unknown cursor-agent error';
      out.push({ type: 'error', content: msg });
      state.terminalEmitted = true;
      break;
    }

    default: {
      console.log(`[Cursor CLI] Unknown event type: ${evType}`);
      break;
    }
  }

  return out;
}

export class CursorCliHarness implements AgentHarness {
  readonly type: HarnessType = 'cursor-cli' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();

    console.log(`[Cursor CLI] Starting harness`);
    console.log(`[Cursor CLI] Working directory: ${workingDir}`);
    if (options.model) console.log(`[Cursor CLI] Model: ${options.model}`);
    if (options.resume) console.log(`[Cursor CLI] Resuming chat: ${options.resume}`);

    // Mirror claude-code-cli/codex convention: force-allow unless config opts out.
    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    const args: string[] = ['-p', '--output-format', 'stream-json'];
    if (skipPermissions) args.push('-f');
    if (options.model) args.push('--model', options.model);
    if (options.resume) args.push('--resume', options.resume);
    console.log(`[Cursor CLI] Permission mode: ${skipPermissions ? '-f (force, default)' : 'interactive (config opt-out)'}`);

    const mergedEnv = { ...process.env, ...(options.env || {}) } as NodeJS.ProcessEnv;

    const cursorPath = process.env.CURSOR_AGENT_PATH || 'cursor-agent';
    console.log(`[Cursor CLI] Full command: ${cursorPath} ${args.join(' ')}`);

    this.cancelled = false;

    const proc = spawn(cursorPath, args, {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;

    const timeoutMs = resolveHarnessTimeoutMs(options);
    let timedOut = false;
    const clearWatchdog = armProcessTimeout(proc, timeoutMs, {
      graceMs: KILL_GRACE_MS,
      onTimeout: () => {
        timedOut = true;
        console.error(`[Cursor CLI] Timed out after ${timeoutMs}ms (PID: ${proc.pid}); killing.`);
      },
    });

    let spawnError: Error | null = null;
    proc.on('error', (err) => {
      clearWatchdog();
      console.error(`[Cursor CLI] Process error: ${err.message}`);
      spawnError = err;
    });

    console.log(`[Cursor CLI] Process spawned, PID: ${proc.pid}`);

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    const state = createCursorParserState();

    let stderrText = '';
    let buffer = '';
    const lines: string[] = [];
    const processedLines = new Set<number>();
    let exitCode: number | null = null;

    const stdout = proc.stdout;
    const stderr = proc.stderr;

    if (stderr) {
      stderr.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });
    }

    let completionCount = 0;
    const targetCompletions = 2;

    const completionPromise = new Promise<void>((resolve) => {
      const checkDone = () => {
        completionCount++;
        if (completionCount >= targetCompletions) resolve();
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
        checkDone();
      }

      proc.on('exit', (code) => {
        clearWatchdog();
        console.log(`[Cursor CLI] Process exited with code ${code}`);
        exitCode = code;
        checkDone();
      });
    });

    let done = false;
    completionPromise.then(() => { done = true; });

    while (!done || processedLines.size < lines.length) {
      await new Promise(r => setTimeout(r, 100));

      for (let i = processedLines.size; i < lines.length; i++) {
        processedLines.add(i);
        const line = lines[i];

        let event: any;
        try { event = JSON.parse(line); } catch {
          console.log(`[Cursor CLI] Skipping non-JSON line: ${line.slice(0, 120)}`);
          continue;
        }

        for (const msg of parseCursorEvent(event, state)) {
          yield msg;
        }
      }

      if (this.cancelled) {
        proc.kill('SIGTERM');
        yield { type: 'error', content: 'Cancelled' };
        state.terminalEmitted = true;
        break;
      }
    }

    await completionPromise;

    if (timedOut) {
      yield {
        type: 'error',
        content: `Cursor CLI timed out after ${timeoutMs}ms (${HANG_TIMEOUT_MARKER})`,
      };
      this.currentProcess = null;
      return;
    }

    if (spawnError) {
      yield { type: 'error', content: `Process spawn error: ${(spawnError as Error).message}` };
      this.currentProcess = null;
      return;
    }

    if (!state.terminalEmitted) {
      if (state.assistantReply && exitCode === 0) {
        yield { type: 'result', result: state.assistantReply, content: state.assistantReply, session_id: state.sessionId };
      } else if (stderrText.trim()) {
        yield { type: 'error', content: stderrText.trim().slice(0, 500) };
      } else {
        yield { type: 'error', content: `cursor-agent exited with code ${exitCode} and no terminal event` };
      }
    }

    this.currentProcess = null;
  }

  cancel(): boolean {
    if (this.currentProcess && !this.currentProcess.killed) {
      const pid = this.currentProcess.pid;
      console.log(`[Cursor CLI] Cancelling process PID: ${pid}`);
      this.cancelled = true;
      this.currentProcess.kill('SIGTERM');
      const proc = this.currentProcess;
      setTimeout(() => {
        if (proc && !proc.killed) {
          console.log(`[Cursor CLI] Force killing process PID: ${pid}`);
          proc.kill('SIGKILL');
        }
      }, 2000);
      return true;
    }
    return false;
  }
}

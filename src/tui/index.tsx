#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const args = process.argv.slice(2);
const staticMode = args.includes('--static') || args.includes('--no-poll');

// log-update emits `(ESC[2K ESC[1A){N-1} ESC[2K ESC[G` to erase N lines then
// position cursor at column 1 of the top line, followed by the rewritten
// content. iTerm2 paints the erase step before the rewrite, producing a
// visible flash on every render — even a single arrow-key selection change.
// Replace the erase sequence with a single cursor-home (ESC[H) so cells are
// overwritten in place with no intermediate blank frame. Safe because the
// TUI is in alt-screen and content dimensions are fixed-width.
if (process.stdout.isTTY) {
  const ERASE_TO_HOME = /(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/g;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const patchedWrite = ((chunk: unknown, ...rest: unknown[]): boolean => {
    let s: string;
    if (typeof chunk === 'string') s = chunk;
    else if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8');
    else s = String(chunk);
    const out = s.replace(ERASE_TO_HOME, '\x1b[H');
    return (originalWrite as (...a: unknown[]) => boolean)(out, ...rest);
  }) as typeof process.stdout.write;
  process.stdout.write = patchedWrite;

  // Enter alt screen + hide cursor. Both exits restore.
  originalWrite('\u001b[?1049h');
  originalWrite('\u001b[?25l');
  const cleanup = (): void => {
    originalWrite('\u001b[?25h');
    originalWrite('\u001b[?1049l');
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}

render(<App staticMode={staticMode} />, { patchConsole: false });

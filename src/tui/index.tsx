#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const args = process.argv.slice(2);
const staticMode = args.includes('--static') || args.includes('--no-poll');

if (process.stdout.isTTY) {
  // Enter alternate screen buffer so ink's redraws don't churn the user's
  // main buffer / scrollback; iTerm2 updates alt screen without line-erase
  // flashes.
  process.stdout.write('\u001b[?1049h');
  process.stdout.write('\u001b[?25l');
  const cleanup = (): void => {
    process.stdout.write('\u001b[?25h');
    process.stdout.write('\u001b[?1049l');
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

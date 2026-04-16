#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const args = process.argv.slice(2);
const staticMode = args.includes('--static') || args.includes('--no-poll');

if (process.stdout.isTTY) {
  process.stdout.write('\u001b[?25l');
  const showCursor = (): void => {
    process.stdout.write('\u001b[?25h');
  };
  process.on('exit', showCursor);
  process.on('SIGINT', () => {
    showCursor();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    showCursor();
    process.exit(0);
  });
}

render(<App staticMode={staticMode} />, { patchConsole: false });

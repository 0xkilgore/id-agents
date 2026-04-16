#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const args = process.argv.slice(2);
const staticMode = args.includes('--static') || args.includes('--no-poll');

render(<App staticMode={staticMode} />);

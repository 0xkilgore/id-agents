#!/bin/bash
tsc 2>/dev/null
node dist/interactive-agent-cli.js "$@"

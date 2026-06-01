#!/usr/bin/env bash
set -euo pipefail

cd /Users/kilgore/Dropbox/Code/cane/id-agents

export HOME=/Users/kilgore
export NODE_ENV=production
export AGENT_MANAGER_PORT="${AGENT_MANAGER_PORT:-4100}"
export AGENT_MANAGER_WORKDIR="${AGENT_MANAGER_WORKDIR:-/Users/kilgore/Dropbox/Code/id-agents/workspace}"
export PATH="/Users/kilgore/.local/bin:/Users/kilgore/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec /opt/homebrew/bin/node dist/start-agent-manager.js

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${ID_AGENTS_REPO_DIR:-"${SCRIPT_DIR}/.."}" && pwd)"
cd "$REPO_DIR"

export NODE_ENV=production
export AGENT_MANAGER_PORT="${AGENT_MANAGER_PORT:-4100}"
export ID_TEAM="${ID_TEAM:-default}"
export ID_AGENTS_HOME="${ID_AGENTS_HOME:-"${HOME}/.id-agents"}"
export AGENT_MANAGER_WORKDIR="${AGENT_MANAGER_WORKDIR:-"${ID_AGENTS_HOME}/workspace"}"
export CONTINUOUS_ORCHESTRATION_MAX_IN_FLIGHT="${CONTINUOUS_ORCHESTRATION_MAX_IN_FLIGHT:-12}"
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"

exec "$NODE_BIN" dist/start-agent-manager.js

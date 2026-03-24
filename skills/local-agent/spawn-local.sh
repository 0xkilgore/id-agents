#!/bin/bash
# SPDX-License-Identifier: MIT
# Spawn a local Claude Code agent (runs outside containers)
#
# Usage: ./spawn-local.sh <agent-name> [--team <team>] [--port <port>] [--dir <path>]
#
# This script starts a local Claude Code agent that:
# - Uses your local Claude Code authentication
# - Registers with the team manager
# - Exposes REST-AP endpoints for inter-agent communication

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Check if name is provided
if [ -z "$1" ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Spawn a local Claude Code agent (runs outside containers)"
    echo ""
    echo "Usage: $0 <agent-name> [options]"
    echo ""
    echo "Options:"
    echo "  --team, -t <name>    Team name (default: ID_TEAM env or 'default')"
    echo "  --port, -p <port>    Port to listen on (auto-allocated if not specified)"
    echo "  --dir, -d <path>     Working directory (auto-created if not specified)"
    echo ""
    echo "Environment Variables:"
    echo "  ID_TEAM              Default team name"
    echo "  MANAGER_URL          Manager URL (default: http://localhost:4100)"
    echo "  DATABASE_URL         PostgreSQL connection string (optional)"
    echo "  CLAUDE_MODEL         Default model"
    echo "  ID_AGENT_API_KEY     API key for inter-agent communication"
    echo ""
    echo "Examples:"
    echo "  $0 my-agent"
    echo "  $0 coder --team myproject --port 24001"
    echo "  ID_TEAM=myteam $0 researcher"
    exit 0
fi

# Change to project root so relative imports work
cd "$PROJECT_ROOT"

# Run the local agent server
exec npx tsx src/local-agent-server.ts "$@"

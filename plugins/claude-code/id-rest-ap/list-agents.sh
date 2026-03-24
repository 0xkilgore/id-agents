#!/bin/bash
# List all available agents in the container
set -euo pipefail

MANAGER_BASE_URL="${MANAGER_URL:-http://id-agent-manager:4100}"
HDRS=()
# Back-compat: some older scripts used "network"/"container" terminology; keep accepting it.
SCOPE="${ID_PROJECT:-${ID_CONTAINER:-${ID_NETWORK:-}}}"
if [[ -n "${SCOPE}" ]]; then
  HDRS+=(-H "X-Id-Project: ${SCOPE}")
  HDRS+=(-H "X-Id-Container: ${SCOPE}") # backwards compatibility
  HDRS+=(-H "X-Id-Network: ${SCOPE}")   # backwards compatibility
fi

curl -s "${HDRS[@]}" "${MANAGER_BASE_URL}/agents" | jq -r '
  .agents[] | 
  "- \(.name) (\(.id))\n  Model: \(.model)\n  Port: \(.port)\n  Status: \(.status)\n  URL: \(.url)\n"
'

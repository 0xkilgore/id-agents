#!/bin/bash
# Broadcast a message to all agents in the container (fire and forget)
# Usage: ./broadcast-to-agents.sh <message> [from-name] [exclude-self]

if [ $# -lt 1 ]; then
  echo "Usage: $0 <message> [from-name] [exclude-self]"
  echo "Example: $0 'Hello everyone, I need help with this task' coder"
  echo "Example: $0 'Status update: Task completed' manager false"
  exit 1
fi

MESSAGE="$1"
FROM_NAME="${2:-}"
EXCLUDE_SELF="${3:-true}"

# Require jq (installed in the id-agents image)
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not installed"
  exit 1
fi

# Get agent list
MANAGER_BASE_URL="${MANAGER_URL:-http://id-agent-manager:4100}"
HDRS=()
# Back-compat: some older scripts used "network"/"container" terminology; keep accepting it.
SCOPE="${ID_PROJECT:-${ID_CONTAINER:-${ID_NETWORK:-}}}"
if [[ -n "${SCOPE}" ]]; then
  HDRS+=(-H "X-Id-Project: ${SCOPE}")
  HDRS+=(-H "X-Id-Container: ${SCOPE}") # backwards compatibility
  HDRS+=(-H "X-Id-Network: ${SCOPE}")   # backwards compatibility
fi

AGENTS_JSON=$(curl -s "${HDRS[@]}" "${MANAGER_BASE_URL}/agents")

if [ $? -ne 0 ] || [ -z "$AGENTS_JSON" ]; then
  echo "Error: Failed to get agent list from manager"
  exit 1
fi

# Build JSON payload
if [ -n "$FROM_NAME" ]; then
  PAYLOAD=$(jq -n --arg message "$MESSAGE" --arg from "$FROM_NAME" '{message:$message, from:$from}')
else
  PAYLOAD=$(jq -n --arg message "$MESSAGE" '{message:$message}')
fi

# Determine if we should prefer internalUrl (when running inside container)
USE_INTERNAL=false
if [[ -n "${SCOPE}" ]] || [[ "${AGENT_ROLE:-}" = "worker" ]]; then
  USE_INTERNAL=true
fi

# Extract targets
AGENT_LINES=$(echo "$AGENTS_JSON" | jq -r --arg from "$FROM_NAME" --argjson excludeSelf "$( [ "$EXCLUDE_SELF" = "true" ] && echo true || echo false )" --argjson useInternal "$( [ "$USE_INTERNAL" = "true" ] && echo true || echo false )" '
  (.agents // [])
  | (if ($excludeSelf and ($from|length>0)) then map(select(.name != $from)) else . end)
  | map({name, url:(if $useInternal then (.internal_url // .internalUrl // .url) else .url end)})
  | map(select(.url != null and .url != ""))
  | .[]
  | "\(.name)\t\(.url)"
')

if [ -z "$AGENT_LINES" ]; then
  echo "No other agents found to broadcast to"
  exit 0
fi

SUCCESS=0
FAIL=0
FAILED=""

while IFS=$'\t' read -r AGENT_NAME_LINE AGENT_URL; do
  if [ -z "$AGENT_URL" ]; then
    FAIL=$((FAIL + 1))
    FAILED="${FAILED}\n- ${AGENT_NAME_LINE} (no URL)"
    continue
  fi
  RESP=$(curl -s -X POST "${AGENT_URL}/talk" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 3 \
    --max-time 5) || true
  QID=$(echo "$RESP" | jq -r '.query_id // empty' 2>/dev/null || true)
  if [ -n "$QID" ]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED="${FAILED}\n- ${AGENT_NAME_LINE} (failed)"
  fi
done <<< "$AGENT_LINES"

echo ""
echo "Broadcast summary:"
echo "  Successfully sent to: ${SUCCESS} agent(s)"
if [ "$FAIL" -gt 0 ]; then
  echo "  Failed to send to: ${FAIL} agent(s)"
  echo -e "$FAILED"
fi
echo ""
echo "Note: Fire-and-forget. Agents will process asynchronously."

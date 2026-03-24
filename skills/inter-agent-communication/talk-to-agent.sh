#!/bin/bash
# Talk to another agent and wait for response (direct reply pattern)
# Usage: ./talk-to-agent.sh <agent-name> <message> [from-name]
#
# The response comes back directly to YOUR /news feed via POST /news,
# not by polling the recipient's /news feed.

if [ $# -lt 2 ]; then
  echo "Usage: $0 <agent-name> <message> [from-name]"
  echo "Example: $0 manager 'Hello, can you help me?' coder"
  exit 1
fi

AGENT_NAME="$1"
MESSAGE="$2"
# from-name is required for direct reply - default to ID_CONTAINER env var
FROM_NAME="${3:-${ID_CONTAINER:-unknown}}"

# Require jq (installed in the id-agents image)
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not installed"
  exit 1
fi

# Get agent list and find the target agent
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
USE_INTERNAL=false
if [[ -n "${SCOPE}" ]] || [[ "${AGENT_ROLE:-}" = "worker" ]]; then
  USE_INTERNAL=true
fi

if [[ "$USE_INTERNAL" = "true" ]]; then
  AGENT_URL=$(echo "$AGENTS_JSON" | jq -r --arg n "$AGENT_NAME" '
    (.agents // [])
    | map(select(.name == $n or .id == $n))
    | first
    | (.internal_url // .internalUrl // .url // empty)
  ')
else
  AGENT_URL=$(echo "$AGENTS_JSON" | jq -r --arg n "$AGENT_NAME" '
    (.agents // [])
    | map(select(.name == $n or .id == $n))
    | first
    | (.url // empty)
  ')
fi

if [ "$AGENT_URL" = "NOT_FOUND" ]; then
  echo "Error: Agent '$AGENT_NAME' not found"
  exit 1
fi

# If jq didn't find anything, fail
if [ -z "$AGENT_URL" ] || [ "$AGENT_URL" = "null" ]; then
  echo "Error: Agent '$AGENT_NAME' not found"
  exit 1
fi

# Send message (build JSON payload - properly escape the message)
if [ -n "$FROM_NAME" ]; then
  PAYLOAD=$(jq -n --arg message "$MESSAGE" --arg from "$FROM_NAME" '{message:$message, from:$from}')
else
  PAYLOAD=$(jq -n --arg message "$MESSAGE" '{message:$message}')
fi

RESPONSE=$(curl -s -X POST "$AGENT_URL/talk" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

QUERY_ID=$(echo "$RESPONSE" | jq -r '.query_id // empty')

if [ -z "$QUERY_ID" ]; then
  echo "Error: Failed to send message"
  echo "$RESPONSE"
  exit 1
fi

# Wait for response in OUR OWN /news feed (direct reply pattern)
# The recipient will POST the reply to our /news endpoint
/app/plugins/id-rest-ap/wait-for-response.sh "$QUERY_ID"

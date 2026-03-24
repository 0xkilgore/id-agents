#!/bin/bash
# REST-AP Client: Send a message to an agent
# Usage: ./talk.sh <message> [from] [reply_endpoint]

set -e

AGENT_URL="${AGENT_URL:-http://localhost:4101}"
MESSAGE="$1"
FROM="${2:-test-client}"
REPLY_ENDPOINT="$3"

if [ -z "$MESSAGE" ]; then
  echo "Usage: ./talk.sh <message> [from] [reply_endpoint]"
  echo ""
  echo "Environment:"
  echo "  AGENT_URL - Target agent URL (default: http://localhost:4101)"
  echo ""
  echo "Examples:"
  echo "  ./talk.sh 'What is your name?'"
  echo "  ./talk.sh 'Hello!' tester"
  echo "  ./talk.sh 'Hello!' tester 'http://localhost:4200/news'"
  exit 1
fi

# Build JSON payload
if [ -n "$REPLY_ENDPOINT" ]; then
  PAYLOAD=$(jq -n \
    --arg msg "$MESSAGE" \
    --arg from "$FROM" \
    --arg reply "$REPLY_ENDPOINT" \
    '{message: $msg, from: $from, reply_endpoint: $reply}')
else
  PAYLOAD=$(jq -n \
    --arg msg "$MESSAGE" \
    --arg from "$FROM" \
    '{message: $msg, from: $from}')
fi

echo "Sending to $AGENT_URL/talk"
echo "Payload: $PAYLOAD"
echo ""

curl -s -X POST "$AGENT_URL/talk" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .

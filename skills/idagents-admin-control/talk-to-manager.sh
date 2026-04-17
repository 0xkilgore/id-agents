#!/bin/bash
#
# Talk to Manager - Send a message to the manager CLI
#
# Usage: ./talk-to-manager.sh "message" [reply_endpoint]
#
# Arguments:
#   message        - The message to send
#   reply_endpoint - Where to receive the reply (default: http://127.0.0.1:4100/news)
#
# Environment:
#   MANAGER_URL - Manager endpoint (default: http://127.0.0.1:4000)
#

MESSAGE="$1"
REPLY_ENDPOINT="${2:-http://127.0.0.1:4100/news}"
MANAGER_URL="${MANAGER_URL:-http://127.0.0.1:4000}"

if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message\" [reply_endpoint]"
  echo ""
  echo "Example: $0 \"Can I spawn a new agent?\" http://127.0.0.1:4100/news"
  exit 1
fi

# Create temp file for JSON payload
PAYLOAD_FILE=$(mktemp)
cat > "$PAYLOAD_FILE" << EOF
{
  "message": $(echo "$MESSAGE" | jq -R .),
  "from": "admin",
  "reply_endpoint": "$REPLY_ENDPOINT"
}
EOF

echo "Sending message to manager..."
echo "  Manager: $MANAGER_URL"
echo "  Reply to: $REPLY_ENDPOINT"
echo ""

RESPONSE=$(curl -s -X POST "$MANAGER_URL/talk" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE")

rm -f "$PAYLOAD_FILE"

# Check if curl succeeded
if [ $? -ne 0 ]; then
  echo "Error: Failed to connect to manager at $MANAGER_URL"
  exit 1
fi

# Parse response
QUERY_ID=$(echo "$RESPONSE" | jq -r '.query_id // empty')
STATUS=$(echo "$RESPONSE" | jq -r '.status // empty')
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')

if [ -n "$ERROR" ]; then
  echo "Error: $ERROR"
  exit 1
fi

if [ -n "$QUERY_ID" ]; then
  echo "Message sent!"
  echo "  Query ID: $QUERY_ID"
  echo "  Status: $STATUS"
  echo ""
  echo "Waiting for reply at $REPLY_ENDPOINT..."
else
  echo "Unexpected response: $RESPONSE"
  exit 1
fi

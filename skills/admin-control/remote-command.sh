#!/bin/bash
#
# Remote Command - Execute CLI commands on the manager
#
# Usage: ./remote-command.sh "/command args"
#
# Arguments:
#   command - The CLI command to execute (e.g., "/agents", "/spawn myagent")
#
# Environment:
#   MANAGER_URL   - Manager endpoint (default: http://localhost:4000)
#

COMMAND="$1"
MANAGER_URL="${MANAGER_URL:-http://localhost:4000}"

if [ -z "$COMMAND" ]; then
  echo "Usage: $0 \"/command args\""
  echo ""
  echo "Available commands:"
  echo "  /agents                    - List all agents"
  echo "  /status                    - Show cluster health"
  echo "  /spawn <name>              - Create new agent"
  echo "  /delete <name>             - Delete agent"
  echo "  /ask <agent> <msg>         - Send message to agent"
  echo "  /hey <agent> <msg>         - Continue session with agent"
  echo "  /agent <name> start|stop   - Agent lifecycle"
  echo ""
  echo "Example: $0 \"/agents\""
  exit 1
fi

# Create temp file for JSON payload
PAYLOAD_FILE=$(mktemp)
cat > "$PAYLOAD_FILE" << EOF
{
  "command": $(echo "$COMMAND" | jq -R .),
  "from": "admin"
}
EOF

echo "Executing command: $COMMAND"
echo ""

RESPONSE=$(curl -s -X POST "$MANAGER_URL/remote" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE")

rm -f "$PAYLOAD_FILE"

# Check if curl succeeded
if [ $? -ne 0 ]; then
  echo "Error: Failed to connect to manager at $MANAGER_URL"
  exit 1
fi

# Parse response
SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')
RESULT=$(echo "$RESPONSE" | jq -r '.result // empty')
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')

if [ "$SUCCESS" = "true" ]; then
  echo "Success!"
  echo ""
  echo "$RESULT"
else
  echo "Failed!"
  echo ""
  if [ -n "$ERROR" ]; then
    echo "Error: $ERROR"
  else
    echo "Response: $RESPONSE"
  fi
  exit 1
fi

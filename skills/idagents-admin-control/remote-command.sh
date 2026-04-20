#!/bin/bash
#
# Remote Command - Execute CLI commands on the manager daemon
#
# Usage: ./remote-command.sh "/command args"
#
# Arguments:
#   command - The CLI command to execute (e.g., "/agents", "/ask ecs hi")
#
# Environment:
#   MANAGER_URL - Manager daemon endpoint (default: http://127.0.0.1:4100)
#   ID_TEAM     - Optional team name, sent as X-Id-Team header
#

COMMAND="$1"
MANAGER_URL="${MANAGER_URL:-http://127.0.0.1:4100}"

if [ -z "$COMMAND" ]; then
  echo "Usage: $0 \"/command args\""
  echo ""
  echo "Available commands:"
  echo "  /deploy <config>           - Deploy agents from config"
  echo "  /agents                    - List all agents"
  echo "  /status                    - Show team health"
  echo "  /delete <name>             - Delete agent"
  echo "  /ask <agent> <msg>         - Send message to agent"
  echo "  /hey <agent> <msg>         - Continue session with agent"
  echo "  /agent <name> start|stop   - Agent lifecycle"
  echo "  /team                      - Show current team"
  echo ""
  echo "Example: $0 \"/deploy idchain\""
  exit 1
fi

PAYLOAD_FILE=$(mktemp)
cat > "$PAYLOAD_FILE" << EOF
{
  "command": $(echo "$COMMAND" | jq -R .),
  "from": "admin"
}
EOF

echo "Executing command: $COMMAND"
echo "Target: $MANAGER_URL/remote"
echo ""

HEADERS=(-H "Content-Type: application/json")
if [ -n "$ID_TEAM" ]; then
  HEADERS+=(-H "X-Id-Team: $ID_TEAM")
fi

RESPONSE=$(curl -s -X POST "$MANAGER_URL/remote" "${HEADERS[@]}" -d @"$PAYLOAD_FILE")
CURL_STATUS=$?

rm -f "$PAYLOAD_FILE"

if [ $CURL_STATUS -ne 0 ]; then
  echo "Error: Failed to connect to manager at $MANAGER_URL"
  exit 1
fi

OK=$(echo "$RESPONSE" | jq -r '.ok // false')
RESULT=$(echo "$RESPONSE" | jq -r '.result // empty')
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')

if [ "$OK" = "true" ]; then
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

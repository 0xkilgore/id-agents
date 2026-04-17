#!/bin/bash
# Management Loop - Runs continuously, sending tasks to agents
#
# Usage: ./management-loop.sh <agent-name> <task> [interval_seconds]
#
# Example:
#   ./management-loop.sh claude-agent "Check memory.md and add a random number < 10" 30
#
# This script:
# 1. Sends a task to the agent via /ask
# 2. Polls for completion
# 3. Waits for the interval
# 4. Repeats forever

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT="${1:-claude-agent}"
TASK="${2:-Check memory.md and add a random number less than 10}"
INTERVAL="${3:-60}"  # seconds between tasks
POLL_INTERVAL=5      # seconds between polls
MAX_POLLS=120        # max polls before giving up (10 min)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Management Loop${NC}"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo -e "Agent: ${GREEN}$AGENT${NC}"
echo -e "Task: ${YELLOW}$TASK${NC}"
echo -e "Interval: ${INTERVAL}s between tasks"
echo -e "${CYAN}════════════════════════════════════════════${NC}"
echo ""

LOOP_COUNT=0

while true; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

  echo -e "${CYAN}[Loop $LOOP_COUNT - $TIMESTAMP]${NC}"

  # Send task
  echo -e "${GRAY}Sending task to $AGENT...${NC}"
  RESULT=$(node "$SCRIPT_DIR/admin-session.js" remote "/ask $AGENT $TASK" 2>&1)

  # Extract query_id
  QUERY_ID=$(echo "$RESULT" | grep -oE 'query_[0-9]+_[a-z0-9]+' | head -1)

  if [ -z "$QUERY_ID" ]; then
    echo -e "${YELLOW}Warning: Could not extract query_id. Result:${NC}"
    echo "$RESULT"
    echo -e "${GRAY}Waiting ${INTERVAL}s before retry...${NC}"
    sleep "$INTERVAL"
    continue
  fi

  echo -e "${GRAY}Query ID: $QUERY_ID${NC}"

  # Get agent port (assumes agent is running)
  AGENT_INFO=$(node "$SCRIPT_DIR/admin-session.js" remote "/agent $AGENT status" 2>&1)
  AGENT_PORT=$(echo "$AGENT_INFO" | grep -oE 'Port: [0-9]+' | grep -oE '[0-9]+')

  if [ -z "$AGENT_PORT" ]; then
    # Fallback: try common ports or skip polling
    echo -e "${YELLOW}Could not determine agent port, waiting...${NC}"
    sleep 15
  else
    # Poll for completion
    echo -e "${GRAY}Polling for response on port $AGENT_PORT...${NC}"
    POLLS=0
    COMPLETED=false

    while [ "$POLLS" -lt "$MAX_POLLS" ] && [ "$COMPLETED" = "false" ]; do
      sleep "$POLL_INTERVAL"
      POLLS=$((POLLS + 1))

      NEWS=$(curl -s "http://127.0.0.1:$AGENT_PORT/news?query_id=$QUERY_ID" 2>/dev/null || echo "{}")

      if echo "$NEWS" | grep -q "query.completed"; then
        COMPLETED=true
        RESPONSE=$(echo "$NEWS" | jq -r '.items[0].data.result.result // "No result"' 2>/dev/null || echo "Parse error")
        echo -e "${GREEN}Response:${NC} $RESPONSE"
      fi
    done

    if [ "$COMPLETED" = "false" ]; then
      echo -e "${YELLOW}Timeout waiting for response after $((POLLS * POLL_INTERVAL))s${NC}"
    fi
  fi

  echo -e "${GRAY}Waiting ${INTERVAL}s before next task...${NC}"
  echo ""
  sleep "$INTERVAL"
done

#!/bin/bash
# Wait for a reply to arrive in your own /news feed (direct reply pattern)
# Usage: ./wait-for-response.sh <query-id> [own-news-url]
#
# With direct reply delivery, the response comes TO YOU via POST /news,
# so we poll YOUR OWN /news feed, not the recipient's.
#
# POLLING TIMEOUT: 2 minutes max
# For longer tasks, the sender will receive a trigger notification when
# the reply arrives. Stop polling after 2 min and let triggers handle it.

if [ $# -lt 1 ]; then
  echo "Usage: $0 <query-id> [own-news-url]"
  echo "Example: $0 query_123"
  echo "Example: $0 query_123 http://localhost:4000"
  exit 1
fi

QUERY_ID="$1"
# Default to localhost:4100 (agent's own server inside container)
# Can be overridden for interactive agents or external callers
OWN_URL="${2:-http://localhost:4100}"
START_TIME=$(date +%s)
MAX_TIME=$((START_TIME + 120)) # 2 minutes max (triggers handle longer tasks)
LAST_INTERVAL=2

echo "Waiting for reply to query $QUERY_ID (polling for up to 2 minutes)..."

# Function to calculate polling interval based on elapsed time
get_poll_interval() {
  local elapsed_seconds=$1

  if [ $elapsed_seconds -lt 30 ]; then
    echo 2        # 0-30s: every 2 seconds
  elif [ $elapsed_seconds -lt 60 ]; then
    echo 5        # 30s-1min: every 5 seconds
  elif [ $elapsed_seconds -lt 120 ]; then
    echo 10       # 1-2min: every 10 seconds
  else
    echo -1       # Stop after 2 minutes
  fi
}

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED_SECONDS=$((CURRENT_TIME - START_TIME))

  # Check timeout (2 minutes)
  if [ $CURRENT_TIME -ge $MAX_TIME ]; then
    echo ""
    echo "⏱️  Polling timeout (2 min). Task may still be processing."
    echo "   The reply will trigger your agent when ready."
    echo "   Check your /news feed later: curl $OWN_URL/news"
    exit 0  # Exit successfully - trigger will handle long tasks
  fi

  # Get adaptive polling interval
  INTERVAL=$(get_poll_interval $ELAPSED_SECONDS)
  if [ "$INTERVAL" = "-1" ]; then
    echo ""
    echo "⏱️  Polling timeout (2 min). Task may still be processing."
    echo "   The reply will trigger your agent when ready."
    exit 0
  fi

  # Show interval change
  if [ "$INTERVAL" != "$LAST_INTERVAL" ]; then
    echo ""
    echo "⏱️  Polling interval: ${INTERVAL} seconds"
    LAST_INTERVAL=$INTERVAL
  fi

  # Poll OWN /news for a reply with in_reply_to matching our query_id
  RESPONSE=$(curl -s "$OWN_URL/news?since=0" | jq -r --arg qid "$QUERY_ID" '
    .items[]
    | select(.data.in_reply_to == $qid or .data.query_id == $qid)
    | select(.type == "reply" or .type == "reply.error")
  ' 2>/dev/null | head -1)

  if [ -n "$RESPONSE" ] && [ "$RESPONSE" != "null" ]; then
    TYPE=$(echo "$RESPONSE" | jq -r '.type')

    if [ "$TYPE" = "reply" ]; then
      echo ""
      echo "✅ Reply received:"
      echo "$RESPONSE" | jq -r '.data.message // .message'
      exit 0
    elif [ "$TYPE" = "reply.error" ]; then
      echo ""
      echo "❌ Error reply:"
      echo "$RESPONSE" | jq -r '.data.message // .message'
      exit 1
    fi
  fi

  echo -n "."
  sleep $INTERVAL
done

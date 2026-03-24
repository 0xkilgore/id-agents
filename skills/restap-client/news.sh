#!/bin/bash
# REST-AP Client: Get news feed from an agent
# Usage: ./news.sh [since]

set -e

AGENT_URL="${AGENT_URL:-http://localhost:4101}"
SINCE="${1:-0}"

echo "Fetching news from $AGENT_URL/news?since=$SINCE"
echo ""

curl -s "$AGENT_URL/news?since=$SINCE" | jq .

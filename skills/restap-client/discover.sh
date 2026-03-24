#!/bin/bash
# REST-AP Client: Get discovery document from an agent
# Usage: ./discover.sh

set -e

AGENT_URL="${AGENT_URL:-http://localhost:4101}"

echo "Fetching discovery from $AGENT_URL/.well-known/restap.json"
echo ""

curl -s "$AGENT_URL/.well-known/restap.json" | jq .

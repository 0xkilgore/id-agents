#!/usr/bin/env bash
set -euo pipefail

FROM_NAME="${1:-}"
TO_NAME="${2:-}"
AMOUNT_ETH="${3:-}"

if [[ -z "$FROM_NAME" || -z "$TO_NAME" || -z "$AMOUNT_ETH" ]]; then
  echo "Usage: pay-agent.sh <from-agent-name> <to-agent-name> <amount-eth>" >&2
  echo "Example: pay-agent.sh coder helper 0.01" >&2
  exit 1
fi

NET_HEADER=()
if [[ -n "${ID_NETWORK:-}" ]]; then
  NET_HEADER=(-H "X-Id-Network: ${ID_NETWORK}")
fi

curl -sS -X POST "http://localhost:4100/agents/pay" \
  "${NET_HEADER[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${FROM_NAME}\",\"to\":\"${TO_NAME}\",\"amount_eth\":\"${AMOUNT_ETH}\"}" \
  | jq .


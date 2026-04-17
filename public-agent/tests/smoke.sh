#!/bin/bash
# End-to-end smoke test for public-agent. Assumes the container is already
# running (docker compose up) and reachable on $PORT. Hits every endpoint
# and reports pass/fail. Exits non-zero on the first failure.
#
# Usage:
#   PORT=4200 ./tests/smoke.sh                  # open mode
#   PORT=4200 AUTH=changeme ./tests/smoke.sh    # keyed mode
#
# The /talk check requires a working OPENROUTER_API_KEY on the server side —
# set SKIP_TALK=1 to skip it if you want to exercise everything else.

set -u

PORT="${PORT:-4200}"
BASE="http://127.0.0.1:${PORT}"
AUTH_HEADER=""
if [ -n "${AUTH:-}" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer ${AUTH}\""
fi
SKIP_TALK="${SKIP_TALK:-0}"

pass=0
fail=0

check() {
  local name="$1"; shift
  local expected="$1"; shift
  local actual
  actual=$(eval "$@")
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name  (status=$actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name  (expected=$expected actual=$actual)"
    fail=$((fail + 1))
  fi
}

echo "Smoke-testing public-agent at ${BASE}"

check "GET /healthz"                  200 "curl -s -o /dev/null -w '%{http_code}' ${BASE}/healthz"
check "GET /.well-known/skill.md"     200 "curl -s -o /dev/null -w '%{http_code}' ${BASE}/.well-known/skill.md"
check "GET /.well-known/restap.json"  200 "curl -s -o /dev/null -w '%{http_code}' ${BASE}/.well-known/restap.json"

check "POST /news (valid)" 200 "curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/news \
  -H 'Content-Type: application/json' ${AUTH_HEADER} \
  -d '{\"from\":\"smoke\",\"message\":\"hello from tests\"}'"

check "POST /news (missing from -> 400)" 400 "curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/news \
  -H 'Content-Type: application/json' ${AUTH_HEADER} \
  -d '{\"message\":\"no sender\"}'"

check "GET /news"      200 "curl -s -o /dev/null -w '%{http_code}' '${BASE}/news?since_id=0&limit=5' ${AUTH_HEADER}"
check "GET /inbox"     200 "curl -s -o /dev/null -w '%{http_code}' '${BASE}/inbox?status=all' ${AUTH_HEADER}"
check "GET /inbox bad status -> 400" 400 "curl -s -o /dev/null -w '%{http_code}' '${BASE}/inbox?status=bogus' ${AUTH_HEADER}"
check "POST /inbox/nope/archive -> 404" 404 "curl -s -o /dev/null -w '%{http_code}' -X POST '${BASE}/inbox/nope/archive' ${AUTH_HEADER}"

if [ "$SKIP_TALK" = "1" ]; then
  echo "  SKIP  POST /talk  (SKIP_TALK=1)"
else
  check "POST /talk" 200 "curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/talk \
    -H 'Content-Type: application/json' ${AUTH_HEADER} \
    -d '{\"message\":\"reply with the word pong and nothing else\",\"from\":\"smoke\"}'"
fi

echo
echo "Result: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]

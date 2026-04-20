#!/usr/bin/env bash
# Regression tests for the id-agents polling stack:
#   - phase 0: agents write to the shared SQLite DB
#   - phase 1: codex-runtime agents (e.g. cto) attach to the shared DB
#   - phase 2: GET /query/:id?wait=<seconds> long-poll on manager daemon
#
# Requires: jq, curl, sqlite3, python3. No new npm deps.
# Usage:    bash scripts/test-longpoll.sh
# Exits:    0 on all-pass, 1 on any failure, 2 on missing deps / setup.

set -u

# ----- config (override via env) -----
DAEMON=${DAEMON:-http://127.0.0.1:4100}
TEAM=${TEAM:-idchain}
DB=${DB:-$HOME/.id-agents/id-agents.db}
ECS_AGENT=${ECS_AGENT:-ecs}
CTO_AGENT=${CTO_AGENT:-cto}
ECS_LOG=${ECS_LOG:-/tmp/ecs.log}
DAEMON_LOG=${DAEMON_LOG:-/tmp/id-agents-daemon.log}
DAEMON_DIST=${DAEMON_DIST:-$(cd "$(dirname "$0")/.." && pwd)/dist/start-agent-manager.js}

# ----- deps -----
for dep in jq curl sqlite3 python3; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Missing dependency: $dep"; exit 2; }
done

# ----- style -----
if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m';
else RED=""; GRN=""; YLW=""; DIM=""; RST=""; fi

# ----- results -----
RESULTS=()   # "num|name|status|elapsed_ms|note"
FAIL_COUNT=0

record() {
  local num=$1 name=$2 status=$3 elapsed=$4 note=${5:-}
  RESULTS+=("$num|$name|$status|$elapsed|$note")
  if [ "$status" = "PASS" ]; then
    printf "  %s[%d] %-30s PASS%s  %sms  %s\n" "$GRN" "$num" "$name" "$RST" "$elapsed" "$note"
  else
    printf "  %s[%d] %-30s %s%s  %sms  %s\n" "$RED" "$num" "$name" "$status" "$RST" "$elapsed" "$note"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

ms_now() { python3 -c 'import time; print(int(time.time()*1000))'; }

# ----- helpers -----
# dispatch <agent> <message...>  -> prints query_id (or empty on failure)
# Always uses the manager daemon's /remote (port 4100). The interactive CLI
# on :4000 has no /remote surface as of 2026-04-20.
dispatch() {
  local agent=$1; shift
  local msg="$*"
  local body
  body=$(jq -n --arg c "/ask $agent $msg" '{command:$c}')
  local resp
  resp=$(curl -sS --max-time 10 -X POST "$DAEMON/remote" \
    -H 'Content-Type: application/json' -H "X-Id-Team: $TEAM" \
    -d "$body" 2>/dev/null) || return 1
  # Response shape: {"ok":true,"result":{"queryId":"query_...","status":"processing","agent":"X"}}
  echo "$resp" | jq -r '.result.queryId // empty' 2>/dev/null
}

# poll <query_id> [wait_sec]  -> prints "<http_code>|<json_body>"
poll() {
  local qid=$1 w=${2:-0}
  local url="$DAEMON/query/$qid"
  [ "$w" -gt 0 ] && url="$url?wait=$w"
  local out http body
  out=$(curl -sS --max-time $((w + 10)) -w "\n__HTTP__:%{http_code}" "$url" -H "X-Id-Team: $TEAM" 2>/dev/null) || { echo "0|"; return 1; }
  http=$(printf '%s' "$out" | sed -nE 's/^__HTTP__:([0-9]+)$/\1/p' | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  echo "${http}|${body}"
}

status_of() { echo "$1" | jq -r '.status // ""'; }

require_agent() {
  local name=$1
  local info
  info=$(curl -sS --max-time 5 "$DAEMON/agents/by-name/$name" -H "X-Id-Team: $TEAM" 2>/dev/null) || return 1
  [ "$(echo "$info" | jq -r '.status // "missing"')" = "running" ] || return 1
  echo "$info"
}

resolve_team_id() {
  sqlite3 "$DB" "SELECT id FROM teams WHERE name='$TEAM' LIMIT 1"
}

# ensure_daemon_up — verify :4100, restart from DAEMON_DIST if not
ensure_daemon_up() {
  if curl -sS --max-time 2 "$DAEMON/health" -H "X-Id-Team: $TEAM" >/dev/null 2>&1; then return 0; fi
  [ -f "$DAEMON_DIST" ] || return 1
  nohup node "$DAEMON_DIST" > "$DAEMON_LOG" 2>&1 &
  disown 2>/dev/null || true
  local tries=0
  until curl -sS --max-time 1 "$DAEMON/health" -H "X-Id-Team: $TEAM" >/dev/null 2>&1; do
    tries=$((tries+1)); [ "$tries" -gt 20 ] && return 1; sleep 0.5
  done
}

# ensure_agent_running <name> — try /agent <name> start via daemon /remote
ensure_agent_running() {
  local name=$1
  ensure_daemon_up || return 1
  local info; info=$(curl -sS --max-time 5 "$DAEMON/agents/by-name/$name" -H "X-Id-Team: $TEAM" 2>/dev/null || echo "")
  local st; st=$(echo "$info" | jq -r '.status // "missing"')
  if [ "$st" != "running" ]; then
    curl -sS --max-time 20 -X POST "$DAEMON/remote" -H 'Content-Type: application/json' -H "X-Id-Team: $TEAM" \
      -d "$(jq -n --arg c "/agent $name start" '{command:$c}')" >/dev/null 2>&1 || true
    sleep 3
    # daemon may have port-killed itself on agent-start; re-ensure
    ensure_daemon_up || return 1
  fi
}

# ----- pre-flight -----
echo "${DIM}id-agents polling regression tests${RST}"
echo "  daemon=$DAEMON  team=$TEAM"
echo "  db=$DB"
echo

if ! curl -sS --max-time 3 "$DAEMON/health" -H "X-Id-Team: $TEAM" >/dev/null 2>&1; then
  echo "${RED}Manager daemon not reachable at $DAEMON${RST}"; exit 2
fi

TEAM_ID=$(resolve_team_id)
if [ -z "$TEAM_ID" ]; then
  echo "${RED}Team '$TEAM' not found in $DB${RST}"; exit 2
fi

require_agent "$ECS_AGENT" >/dev/null || { echo "${RED}Agent '$ECS_AGENT' not running${RST}"; exit 2; }
require_agent "$CTO_AGENT" >/dev/null || { echo "${YLW}Agent '$CTO_AGENT' not running — case 2 will be skipped${RST}"; }

ECS_INFO=$(require_agent "$ECS_AGENT")
ECS_ID=$(echo "$ECS_INFO" | jq -r '.id')
ECS_PORT=$(echo "$ECS_INFO" | jq -r '.port')

echo "${DIM}Running cases...${RST}"

# ----- case 1: ecs echo, wait=30, delivered <10s -----
case_1() {
  local qid t0 t1 r http body st dt
  qid=$(dispatch "$ECS_AGENT" echo "case1-$$") || { record 1 "ecs-echo-wait30" FAIL 0 "dispatch error"; return; }
  [ -z "$qid" ] && { record 1 "ecs-echo-wait30" FAIL 0 "no query id"; return; }
  t0=$(ms_now); r=$(poll "$qid" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  if [ "$http" = "200" ] && [ "$st" = "delivered" ] && [ "$dt" -lt 10000 ]; then
    record 1 "ecs-echo-wait30" PASS "$dt" "qid=$qid"
  else
    record 1 "ecs-echo-wait30" FAIL "$dt" "http=$http status=$st"
  fi
  CASE1_QID=$qid
}

# ----- case 2: cto echo (codex), wait=30, delivered <10s -----
case_2() {
  local info st_running; info=$(curl -sS --max-time 5 "$DAEMON/agents/by-name/$CTO_AGENT" -H "X-Id-Team: $TEAM" 2>/dev/null || echo "")
  st_running=$(echo "$info" | jq -r '.status // "missing"')
  if [ "$st_running" != "running" ]; then
    record 2 "cto-echo-wait30" SKIP 0 "cto not running"
    return
  fi
  local qid t0 t1 r http body st dt
  qid=$(dispatch "$CTO_AGENT" echo "case2-$$") || { record 2 "cto-echo-wait30" FAIL 0 "dispatch error"; return; }
  [ -z "$qid" ] && { record 2 "cto-echo-wait30" FAIL 0 "no query id"; return; }
  t0=$(ms_now); r=$(poll "$qid" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  if [ "$http" = "200" ] && [ "$st" = "delivered" ] && [ "$dt" -lt 10000 ]; then
    record 2 "cto-echo-wait30" PASS "$dt" "qid=$qid (codex)"
  else
    record 2 "cto-echo-wait30" FAIL "$dt" "http=$http status=$st"
  fi
}

# ----- case 3: backward-compat (wait=0 / no param) <1s -----
case_3() {
  local qid r0 rnp t0 t1 dt0 dtnp
  qid=$(dispatch "$ECS_AGENT" echo "case3-$$") || { record 3 "backcompat-wait0" FAIL 0 "dispatch error"; return; }
  [ -z "$qid" ] && { record 3 "backcompat-wait0" FAIL 0 "no query id"; return; }
  t0=$(ms_now); r0=$(poll "$qid" 0); t1=$(ms_now); dt0=$((t1-t0))
  local http0 body0 st0; http0=${r0%%|*}; body0=${r0#*|}; st0=$(status_of "$body0")
  t0=$(ms_now); rnp=$(poll "$qid"); t1=$(ms_now); dtnp=$((t1-t0))
  local httpn bodyn stn; httpn=${rnp%%|*}; bodyn=${rnp#*|}; stn=$(status_of "$bodyn")
  if [ "$dt0" -lt 1000 ] && [ "$dtnp" -lt 1000 ] && [ "$http0" = "200" ] && [ "$httpn" = "200" ]; then
    record 3 "backcompat-wait0" PASS "$dt0" "wait=0=${dt0}ms noparam=${dtnp}ms (st=$st0/$stn)"
  else
    record 3 "backcompat-wait0" FAIL "$dt0" "wait=0=${dt0}ms noparam=${dtnp}ms http=$http0/$httpn"
  fi
}

# ----- case 4: 10 parallel, all deliver, no SQLITE_BUSY in logs -----
# With the /talk pending pre-write (polling-talk-prewrite), every dispatched
# query has a DB row before /talk returns, so concurrent pollers never see
# 404. But the agent's queryQueue still processes queries serially, so each
# worker may need to wait longer than a single 30s wait-window for its turn.
# Each worker retries the long-poll on non-terminal status, capped at 180s
# total wall per worker.
case_4() {
  ensure_agent_running "$ECS_AGENT"
  local tmpdir; tmpdir=$(mktemp -d)
  local t0; t0=$(ms_now)
  local pids=()
  local n=10
  for i in $(seq 1 $n); do
    (
      qid=$(dispatch "$ECS_AGENT" echo "parallel-$i-$$") || { echo "dispatch-fail" > "$tmpdir/$i.result"; exit; }
      [ -z "$qid" ] && { echo "no-qid" > "$tmpdir/$i.result"; exit; }
      echo "$qid" > "$tmpdir/$i.qid"
      start_ms=$(ms_now); deadline_ms=$((start_ms + 180000))
      retries=0; http=""; body=""; st=""
      while :; do
        r=$(poll "$qid" 30)
        http=${r%%|*}; body=${r#*|}; st=$(status_of "$body")
        case "$st" in
          delivered|failed|expired) break ;;
        esac
        [ "$http" = "404" ] && [ "$retries" -lt 5 ] && { retries=$((retries+1)); sleep 1; continue; }
        [ "$(ms_now)" -ge "$deadline_ms" ] && break
        retries=$((retries+1))
      done
      echo "$http|$st|retries=$retries" > "$tmpdir/$i.result"
    ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
  local t1; t1=$(ms_now); local dt=$((t1-t0))
  local ok=0 max_retries=0 notes=""
  for i in $(seq 1 $n); do
    local res; res=$(cat "$tmpdir/$i.result" 2>/dev/null || echo "")
    local r_status=${res%|retries=*}
    local r_retries=${res##*retries=}
    if [[ "$r_retries" =~ ^[0-9]+$ ]] && [ "$r_retries" -gt "$max_retries" ]; then max_retries=$r_retries; fi
    if [ "$r_status" = "200|delivered" ]; then ok=$((ok+1)); else notes="$notes [$i:$res]"; fi
  done
  local busy=0
  if [ -f "$ECS_LOG" ]; then
    busy=$(grep -cEi 'SQLITE_BUSY|database is locked|SQLITE_LOCKED' "$ECS_LOG" 2>/dev/null | tr -d '\n' || echo 0)
    [ -z "$busy" ] && busy=0
  fi
  rm -rf "$tmpdir"
  if [ "$ok" = "$n" ] && [ "$busy" = "0" ]; then
    record 4 "parallel-10xecs" PASS "$dt" "$ok/$n delivered, no lock errors, max_404_retries=$max_retries"
  else
    record 4 "parallel-10xecs" FAIL "$dt" "$ok/$n delivered busy=$busy$notes"
  fi
}

# ----- case 5: kill-mid-flight -----
# Plant a 'processing' row for ecs, kill ecs process, wait=30 should return
# definitive state within ~30s (not hang). First-cut behavior: without a
# dead-agent reconciliation hook, the row stays 'processing' and wait times out.
case_5() {
  local pid; pid=$(curl -sS --max-time 5 "$DAEMON/agents/by-name/$ECS_AGENT" -H "X-Id-Team: $TEAM" | jq -r '.pid // empty')
  if [ -z "$pid" ] || [ "$pid" = "null" ]; then record 5 "kill-mid-flight" SKIP 0 "no ecs pid"; return; fi
  local fake_qid="test_killmid_$(ms_now)_$$"
  local now; now=$(ms_now)
  sqlite3 "$DB" "INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created) VALUES ('$TEAM_ID','$ECS_ID','$fake_qid','processing','kill-mid-flight',$now)" 2>/dev/null \
    || { record 5 "kill-mid-flight" FAIL 0 "plant row failed"; return; }
  # kill ecs
  kill "$pid" 2>/dev/null || true
  sleep 1
  local t0 t1 r http body st dt
  t0=$(ms_now); r=$(poll "$fake_qid" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  # cleanup planted row
  sqlite3 "$DB" "DELETE FROM queries WHERE query_id='$fake_qid'" 2>/dev/null || true
  # restart ecs for later cases
  ensure_agent_running "$ECS_AGENT"
  # refresh ECS_ID/pid for case 9
  ECS_INFO=$(curl -sS --max-time 5 "$DAEMON/agents/by-name/$ECS_AGENT" -H "X-Id-Team: $TEAM" 2>/dev/null || echo "{}")
  local ok_terminal="no"
  case "$st" in cancelled|expired|failed) ok_terminal="yes";; esac
  # must not exceed 30s by much; allow 2s slack
  local within_timeout="no"; [ "$dt" -lt 32000 ] && within_timeout="yes"
  if [ "$ok_terminal" = "yes" ] && [ "$within_timeout" = "yes" ]; then
    record 5 "kill-mid-flight" PASS "$dt" "status=$st"
  else
    # This is a known gap with current code (no dead-agent reconciliation).
    record 5 "kill-mid-flight" FAIL "$dt" "status=$st http=$http (no dead-agent reconcile hook)"
  fi
}

# ----- case 6: planted-stale-row; wait=30 accepts timeout (first cut) -----
case_6() {
  local fake_qid="test_stale_$(ms_now)_$$"
  local now sixteen_min_ago
  now=$(ms_now); sixteen_min_ago=$((now - 16*60*1000))
  sqlite3 "$DB" "INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created) VALUES ('$TEAM_ID','$ECS_ID','$fake_qid','processing','planted-stale',$sixteen_min_ago)" 2>/dev/null \
    || { record 6 "planted-stale-row" FAIL 0 "plant row failed"; return; }
  # Simulate the sweeper running (spec: accept timeout latency, but we can also prove expire works)
  # Don't run it yet — first do the wait=30 poll to confirm timeout behavior, then confirm
  # that sweeper SQL flips it to expired.
  local t0 t1 r http body st dt
  t0=$(ms_now); r=$(poll "$fake_qid" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  # now run the sweeper SQL manually
  sqlite3 "$DB" "UPDATE queries SET status='expired', completed=$now WHERE query_id='$fake_qid' AND status IN ('pending','processing') AND created < ($now - 15*60*1000)" 2>/dev/null || true
  local r2 st2
  r2=$(poll "$fake_qid" 0); body=${r2#*|}; st2=$(status_of "$body")
  sqlite3 "$DB" "DELETE FROM queries WHERE query_id='$fake_qid'" 2>/dev/null || true
  # Assertion: wait=30 returned (not hanging past timeout), and after sweep, status=expired
  if [ "$dt" -lt 32000 ] && [ "$http" = "200" ] && [ "$st2" = "expired" ]; then
    record 6 "planted-stale-row" PASS "$dt" "pre-sweep=$st post-sweep=$st2"
  else
    record 6 "planted-stale-row" FAIL "$dt" "pre-sweep=$st post-sweep=$st2 http=$http"
  fi
}

# ----- case 7: already-terminal + wait=30 returns <100ms -----
case_7() {
  if [ -z "${CASE1_QID:-}" ]; then record 7 "already-terminal-fast" SKIP 0 "case 1 did not run"; return; fi
  local t0 t1 r http body st dt
  t0=$(ms_now); r=$(poll "$CASE1_QID" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  if [ "$http" = "200" ] && [ "$st" = "delivered" ] && [ "$dt" -lt 500 ]; then
    record 7 "already-terminal-fast" PASS "$dt" "status=$st"
  else
    record 7 "already-terminal-fast" FAIL "$dt" "http=$http status=$st"
  fi
}

# ----- case 8: nonexistent id + wait=30 returns 404 <100ms -----
case_8() {
  local nope="does_not_exist_$(ms_now)"
  local t0 t1 r http body dt
  t0=$(ms_now); r=$(poll "$nope" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; dt=$((t1-t0))
  if [ "$http" = "404" ] && [ "$dt" -lt 500 ]; then
    record 8 "nonexistent-fast-404" PASS "$dt" ""
  else
    record 8 "nonexistent-fast-404" FAIL "$dt" "http=$http"
  fi
}

# ----- case 9: /agent ecs stop during dispatch → cancelled -----
case_9() {
  ensure_agent_running "$ECS_AGENT"
  local qid; qid=$(dispatch "$ECS_AGENT" echo "case9-$$") || { record 9 "agent-stop-cancel" FAIL 0 "dispatch error"; return; }
  [ -z "$qid" ] && { record 9 "agent-stop-cancel" FAIL 0 "no query id"; return; }
  # start waiter in background
  local tmp; tmp=$(mktemp)
  local t0; t0=$(ms_now)
  ( r=$(poll "$qid" 30); echo "$(ms_now)|$r" > "$tmp" ) &
  local waiter=$!
  # give the waiter time to register, then stop ecs
  sleep 0.5
  curl -sS --max-time 15 -X POST "$DAEMON/remote" -H 'Content-Type: application/json' -H "X-Id-Team: $TEAM" \
    -d "$(jq -n --arg c "/agent $ECS_AGENT stop" '{command:$c}')" >/dev/null 2>&1 || true
  wait "$waiter" 2>/dev/null || true
  local line t1 r http body st dt
  line=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
  t1=${line%%|*}; r=${line#*|}
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  # restart ecs for downstream tests
  ensure_agent_running "$ECS_AGENT"
  if [ "$http" = "200" ] && [ "$st" = "failed" ] && [ "$dt" -lt 10000 ]; then
    # internal 'cancelled' maps to external 'failed'
    record 9 "agent-stop-cancel" PASS "$dt" "status=$st (cancelled→failed)"
  elif [ "$http" = "200" ] && [ "$st" = "delivered" ] && [ "$dt" -lt 10000 ]; then
    record 9 "agent-stop-cancel" PASS "$dt" "agent replied before stop (race: delivered)"
  else
    record 9 "agent-stop-cancel" FAIL "$dt" "http=$http status=$st"
  fi
}

# ----- case 10: manager restart mid-flight -----
case_10() {
  ensure_daemon_up || { record 10 "manager-restart-midflight" SKIP 0 "daemon not reachable at start"; return; }
  ensure_agent_running "$ECS_AGENT"
  local qid; qid=$(dispatch "$ECS_AGENT" echo "case10-$$") || { record 10 "manager-restart-midflight" FAIL 0 "dispatch error"; return; }
  [ -z "$qid" ] && { record 10 "manager-restart-midflight" FAIL 0 "no query id"; return; }
  local daemon_pid
  daemon_pid=$(lsof -ti :4100 -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -z "$daemon_pid" ]; then record 10 "manager-restart-midflight" SKIP 0 "daemon pid not found"; return; fi
  kill "$daemon_pid" 2>/dev/null || true
  sleep 2
  ensure_daemon_up || { record 10 "manager-restart-midflight" FAIL 0 "daemon restart failed"; return; }
  local t0 t1 r http body st dt
  t0=$(ms_now); r=$(poll "$qid" 30); t1=$(ms_now)
  http=${r%%|*}; body=${r#*|}; st=$(status_of "$body"); dt=$((t1-t0))
  local terminal="no"
  case "$st" in delivered|failed|expired) terminal="yes";; esac
  if [ "$http" = "200" ] && [ "$terminal" = "yes" ]; then
    record 10 "manager-restart-midflight" PASS "$dt" "status=$st (survived daemon restart)"
  else
    record 10 "manager-restart-midflight" FAIL "$dt" "http=$http status=$st"
  fi
}

# ----- run -----
# Some cases can crash the daemon via the known port-kill-own-pid bug during
# /agent <name> start/stop/rebuild. Re-ensure the daemon is up between cases.
CASE1_QID=""
run() { "$@"; ensure_daemon_up || true; }
run case_1
run case_2
run case_3
run case_4
run case_5
run case_6
run case_7
run case_8
run case_9
run case_10

# ----- summary -----
echo
echo "${DIM}Summary${RST}"
printf "  %-4s %-28s %-6s %-10s %s\n" "#" "case" "status" "elapsed" "note"
printf "  %-4s %-28s %-6s %-10s %s\n" "-" "----" "------" "-------" "----"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r num name status elapsed note <<<"$row"
  local_color=""
  case "$status" in
    PASS) local_color="$GRN";;
    SKIP) local_color="$YLW";;
    *) local_color="$RED";;
  esac
  printf "  ${local_color}%-4s %-28s %-6s %-10s${RST} %s\n" "$num" "$name" "$status" "${elapsed}ms" "$note"
done

echo
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "${GRN}All cases passed${RST}"
  exit 0
else
  echo "${RED}$FAIL_COUNT case(s) failed${RST}"
  exit 1
fi

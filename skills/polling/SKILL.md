# Polling Skill — Async Agent Reply Monitoring

Poll for agent replies in the background after dispatching work. Uses timestamp filtering to avoid stale responses.

## Usage

After dispatching a task to one or more agents, use this pattern to poll for replies without blocking the user.

### Single Agent

```bash
# Record timestamp before dispatch
BEFORE=$(date +%s)000

# Dispatch
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}'

# Poll in background (checks every 10s for up to 2 minutes)
for i in $(seq 1 12); do
  reply=$(curl -s -X POST http://localhost:4100/remote \
    -H "Content-Type: application/json" \
    -d '{"command":"/news <agent>"}' | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('result',{}).get('items',[])
for item in reversed(items):
    if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
        print(item['data']['message'][:2000])
        break
" 2>/dev/null)
  if [ -n "$reply" ]; then echo "REPLY: $reply"; break; fi
  sleep 10
done
```

### Multiple Agents

Wait for a threshold of replies (e.g., 5 of 7 agents):

```bash
BEFORE=$(date +%s)000

# Dispatch to all agents
for agent in contracts web gateway indexer cli agents id-agents-app; do
  curl -s -X POST http://localhost:4100/remote \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}"
done

# Poll until threshold met (5 of 7, check every 10s, max 3 minutes)
for i in $(seq 1 18); do
  results=""
  for agent in contracts web gateway indexer cli agents id-agents-app; do
    reply=$(curl -s -X POST http://localhost:4100/remote \
      -H "Content-Type: application/json" \
      -d "{\"command\":\"/news ${agent}\"}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('result',{}).get('items',[])
    for item in reversed(items):
        if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
            msg = item['data']['message'][:200].replace(chr(10), ' ')
            print(msg)
            break
except: pass
" 2>/dev/null)
    if [ -n "$reply" ]; then results="${results}${agent}: ${reply}\n"; fi
  done
  count=$(echo -e "$results" | grep -c ":" 2>/dev/null || echo 0)
  if [ "$count" -ge 5 ]; then
    echo "GOT $count REPLIES:"
    echo -e "$results"
    break
  fi
  sleep 10
done
```

## Best Practices

- Always use `run_in_background: true` when calling from Claude Code so the user isn't blocked
- Record the timestamp BEFORE dispatching to filter out stale replies
- Use a threshold (e.g., 5 of 7) rather than waiting for all agents — some may be slow or stuck
- Max poll time of 3 minutes is usually enough; increase for complex tasks
- If an agent keeps returning stale replies, use `/clear <agent>` to reset its session

## Manager Port

Default: `4100` (configurable via `--port` flag or `MANAGER_PORT` env var)

# Pre-Release Smoke Test

Date: 2026-03-23

## Results

| Command | Status | Notes |
|---------|--------|-------|
| `/deploy` | PASS | Both local-agent and standard-agent paths pass `domain`, `tokenId`, `address` in payload (lines 3776-3778 and 3918-3920). Auto-register onchain works for both paths. |
| `/news -l <agent>` | PASS | Parses `-l` flag correctly at line 2618. Strips flag then passes remaining text as agent name to `showAgentNewsTop(name, true)`. Also handles `-l` at end of input. |
| `/delete <agent>` | PASS | Kills local process via `lsof -ti :port` before DELETE API call (lines 3163-3176), then deletes from DB (line 3179). Confirmation prompt requires typing "DELETE". |
| `/register <agent>` | PASS | Calls manager `/agents/:id/onchain/register` endpoint. Manager creates ENS subname via `createSubnameOnIdChain()` (manager line 689). CLI pushes identity back to running agent (lines 3377-3398). |
| `/agents` | PASS | Shows ENS names via `agent.name` (which is updated to ENS domain after registration). Shows alias separately when it differs from name (line 3455). Shows registry as ERC-7930 address (lines 3459-3473). |
| `/ask <agent> <msg>` | PASS | Parses agent + message, resolves agent, sends via `/talk` or manager proxy for remote teams. Tracks `pendingOutgoingQueries` for reply matching. |
| `/hey <agent> <msg>` | PASS | Identical flow to `/ask` -- both call `askAgent(name, msg, true)`. |
| `/ask * <msg>` | PASS | Broadcast check happens before `sanitizeAgentName()` (which would strip `*`). Calls `broadcastToAllAgents()` which filters to active agents and sends in parallel. |
| `/clear` | PASS | No-arg clears all sessions from `agentSessions` map. With agent name, clears single session. |
| `/status` | PASS | Fetches agent list, checks each agent's `/.well-known/restap.json` catalog with 3s timeout. Counts active vs orphaned queries. Supports `-l`/`--long` flag. |
| `/agent <name> rebuild` | PASS | Fetches agent data from manager, calls `startLocalAgentProcess()` which kills existing process on port via `lsof` (line 928-946), then spawns fresh `local-agent-server.js` process. |
| `/agents rebuild` | PASS | Iterates all claude-type agents, kills each process by port, then calls `startLocalAgentProcess()` for each. |
| `/help` | PASS | Prints HELP_ITEMS array, 14 commands listed. |
| `/quit` | PASS | Calls `process.exit(0)`. |

## Issues Found

None. All traced handlers work as expected. The recently-added features (`domain`/`tokenId`/`address` in deploy, `-l` flag parsing in `/news`, process kill before delete, ENS subname creation in `/register`, ENS display in `/agents`) are all correctly implemented.

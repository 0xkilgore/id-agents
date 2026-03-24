# ID Agents Functionality Audit

**Date:** 2026-03-23
**Auditor:** agents.agent-16.sep.xid.eth
**Scope:** All commands listed in the help menu, plus deploy config handling and dead-reference checks
**Method:** Static code analysis (read-only) of `src/interactive-agent-cli.ts`, `src/config-parser.ts`, `src/agent-manager-db.ts`, and `configs/idchain.yaml`

---

## 1. `/deploy <config> [params]`

**Files:** Lines 2521-2581 (handler), 4645-4947 (`deployFromConfig`), `src/config-parser.ts` (full file)

**What works:**
- Config shorthand resolution ("idchain" -> "configs/idchain.yaml") works correctly.
- Fallback to `configs/default.yaml` when config not found, with the original arg prepended as a positional parameter -- clever and correct.
- Parameter substitution with `${param}` and `${env:VAR}` syntax is solid; unresolved params are detected and reported.
- Config validation catches missing version, agents array, invalid names, invalid runtimes.
- Plugin path resolution, claudeMd file resolution, heartbeat file resolution all work correctly.
- Defaults merging into agent specs follows correct override semantics.
- Deploy summary with success/fail counts is clear.

**Issues found:**

### CRITICAL: `domain`, `tokenId`, and `address` fields from YAML configs are silently ignored during deploy

The `AgentSpec` interface defines `domain`, `tokenId`, and `address` fields (lines 52-54 of config-parser.ts), and `idchain.yaml` sets all three for each agent. However, the `deployFromConfig` function **never reads these fields** from the agent spec. Neither the local-agent payload (line 4705-4718) nor the standard-agent payload (line 4843-4860) includes `domain`, `tokenId`, or `address`.

This means deploying with `idchain.yaml` creates agents that have **no onchain identity** -- the ENS domain, token ID, and associated Ethereum address configured in the YAML are completely lost. Users would need to manually run `/meta setid` and `/meta set` for each agent after deploy.

### LOW: `dangerouslySkipPermissions` in idchain.yaml has no effect

`idchain.yaml` defaults section sets `dangerouslySkipPermissions: true`, but this field is not defined in the `AgentSpec` interface, not validated, and not passed through to the spawn payload. The YAML parser silently ignores it (js-yaml just includes it as a property on the parsed object, but no code reads it).

### LOW: `claudeMd` not passed for local agents

The local-agent deploy payload (line 4705-4718) does not include `claudeMd`, while the standard-agent payload (line 4851) does. This means CLAUDE.md content from configs is not written for local agents.

---

## 2. `/ask <agent> <msg>` and `/hey <agent> <msg>`

**Files:** Lines 2941-3006 (handlers), 4380-4479 (`askAgent`), 4949-5032 (`resolveAgent`)

**What works:**
- Both `/ask` and `/hey` are functionally identical (both call `askAgent` with `useSession: true`).
- Broadcast wildcard `*` is correctly checked BEFORE `sanitizeAgentName` (since `*` would be stripped).
- Missing agent name or message shows usage.
- Agent resolution is thorough: tries `/agents/resolve/` endpoint first, then falls back to listing all agents and matching by name, alias, id, displayId, or metadata.name.
- Ambiguous matches (multiple agents with same name) are detected and reported with suggestions.
- Session continuity via `agentSessions` map works: session_id from replies is stored and sent with subsequent messages.
- Connection errors (ECONNREFUSED) provide helpful suggestions to start the agent.
- Remote manager proxy routing is correctly handled (when agent URL is localhost but manager is remote).

**Issues found:**

### LOW: `/ask` and `/hey` are exact duplicates

The help menu describes `/hey` as "like /ask but maintains session continuity", but both commands call `askAgent(agentName, message, true)` with `useSession: true`. There is no functional difference. The comment on line 2974 says "like /ask but maintains session continuity" but `/ask` also maintains sessions. This is a documentation/comment inaccuracy, not a code bug.

---

## 3. `/agents`

**Files:** Lines 2584-2593 (handler), 4290-4378 (`listAgents`)

**What works:**
- Checks manager is running before listing.
- Fetches with `?all=true` to include automator agents.
- Deduplicates by name, keeping the most recent entry.
- Handles zero agents gracefully with a helpful "deploy an agent" message.
- Display includes: emoji, displayId, agent ID, alias, registry (ERC-7930 encoded), runtime, model, external URL, and internal URL.
- Correctly distinguishes automator, virtual, interactive, and claude agent types for display.

**Issues found:**

None found. The command is well-implemented.

---

## 4. `/agent <name> rebuild`

**Files:** Lines 2043-2163 (handler), 965-1056 (`startLocalAgentProcess`)

**What works:**
- Resolves agent by name via manager API.
- Determines agent type (local/virtual/interactive).
- For local agents: kills existing process on the port, waits 1 second, then starts a fresh process.
- For non-local agents: also calls `startLocalAgentProcess` (which kills existing process on port first).
- Handles "agent not found" correctly (throws error caught by outer try/catch).
- Log file is created with timestamp for each rebuild.
- Environment variables (model, tokenId, API key) are passed correctly.

**Issues found:**

### MEDIUM: Local agent rebuild does not stop the old process explicitly when agent has no port

In `startLocalAgentProcess` (line 990-1008), the old process is killed by finding PIDs listening on the agent's port via `lsof`. If `agentPort` is falsy (0, null, undefined), the kill step is silently skipped. Since the manager always allocates a port (line 1905), this is unlikely in practice, but there's no error or warning.

### LOW: Non-local agent rebuild falls through to same `startLocalAgentProcess` call

After the local-agent rebuild block (lines 2134-2148 with `return`), the non-local rebuild (lines 2151-2162) does the exact same thing -- calls `startLocalAgentProcess(agentData)`. Since `getAgentType` returns `'local'` for all `claude` type agents (line 1065: default return is `'local'`), the non-local path is unreachable dead code. Virtual and interactive agents are handled before the rebuild block (lines 2066-2090).

---

## 5. `/agents rebuild`

**Files:** Lines 1763-1945 (handler), 965-1056 (`startLocalAgentProcess`)

**What works:**
- Fetches all agents, filters to `type === 'claude'` only.
- Handles zero agents gracefully.
- For each local agent: kills existing process on port, waits 500ms, starts fresh process.
- Tracks success/failed/skipped counts with summary.
- Virtual and interactive agents are skipped with status message.
- Unknown agent types are skipped with warning.

**Issues found:**

### LOW: Inconsistent wait times between single and bulk rebuild

Single `/agent <name> rebuild` calls `startLocalAgentProcess` which waits 1000ms after killing the old process (line 1003). Bulk `/agents rebuild` kills the process and waits only 500ms (line 1915) before calling `startLocalAgentProcess`, which then tries to kill again and waits another 1000ms. This double-kill is harmless but wasteful.

---

## 6. `/news [-l] <agent>`

**Files:** Lines 3125-3205 (handler), 5840-5950 (`checkAgentNews`), 6003-6102 (`showAgentNewsTop`)

**What works:**
- `/news archive [days]` works correctly (POST to manager's archive endpoint).
- `/news top [-l] <agent>` correctly parses the `-l` flag in both positions (before or after agent name).
- `/news` (no arg) shows the CLI's own news feed via `showMyNews()`.
- `/news <agent>` resolves agent, fetches news from agent's `/news` endpoint, shows most recent item.
- `/news manager` is a special case that fetches from the manager's endpoint.
- Handles no news items gracefully.
- Session-aware filtering: if there's an active session with the agent, tries to show session-specific items first.

**Issues found:**

### MEDIUM: The `-l` flag does NOT work with `/news -l <agent>` despite being documented

The help menu says: `/news [-l] <agent>` -- "Check recent messages (-l for full content)". However, the `-l` flag is only parsed in the `/news top` subcommand (lines 3174-3179). When a user types `/news -l contracts`, the `rest` variable is `"-l contracts"`, which doesn't match "archive" or "top", so it falls through to `checkAgentNews("-l contracts")`. This tries to resolve an agent named "-l contracts", which will fail with "Agent not found". The `-l` flag only works with `/news top -l <agent>`.

### LOW: `checkAgentNews` only shows the single most recent news item

Unlike `/news top` which shows the last 10 items, `/news <agent>` fetches up to 50 items but only displays the most recent one (line 5929). Users may expect to see more.

---

## 7. `/register <agent>`

**Files:** Lines 2866-2885 (handler), 4213-4287 (`registerAgentOnchain`)

**What works:**
- Resolves agent by name/id.
- If agent already has a registration, warns and requires "REGISTER" confirmation.
- Calls manager's `/agents/{id}/onchain/register` endpoint.
- Displays domain, transaction hash, and chain ID on success.
- Pushes updated identity (tokenId, registry, registry7930, domain) to the running agent via PATCH `/identity`.
- Has a "manger" -> "manager" typo correction (line 2878).

**Issues found:**

### LOW: No validation that the agent has a wallet or registrar is configured

The handler delegates entirely to the manager endpoint. If the manager has no registrar configured, the error comes back as a generic HTTP error. The CLI could pre-check with `/registry/registrar` for a better UX.

---

## 8. `/delete <agent>`

**Files:** Lines 2737-2776 (handler), 3951-3977 (`deleteAgent`), manager lines 2294-2348

**What works:**
- Warns about permanent deletion with clear description of what will happen.
- Requires exact "DELETE" confirmation keyword.
- Gives the user a second chance if they don't type "DELETE" on first try.
- Uses `resolveAgent` so agents can be deleted by name, id, ENS domain, or tokenId.
- Manager-side: stops runtime server if in `runningServers`, deletes workspace directory (only if it matches the expected auto-generated path), and cascades deletion to related DB tables.

**Issues found:**

### MEDIUM: Local agent processes are NOT killed on delete

The CLI's `deleteAgent` function just calls the manager's DELETE endpoint. The manager's handler (line 2300-2308) only stops servers tracked in `this.runningServers`. But local agents spawned by the CLI are detached child processes NOT tracked in `runningServers`. After delete, the agent process continues running as an orphan on its allocated port. Users must manually kill the process.

### LOW: Working directory only deleted if it matches auto-generated path

The manager's delete handler (line 2314-2316) only deletes the working directory if `agent.working_directory === expectedDir` (where expectedDir is `{baseWorkDir}/agents/{agentId}`). For agents deployed from `idchain.yaml` with custom `workingDirectory` paths (like `/Users/nxt3d/projects/idx`), the cleanup is skipped. This is actually the correct behavior (you don't want to delete the user's project repo), but the CLI's warning message (line 2753) says "Working directory will be deleted" unconditionally, which is misleading.

---

## 9. `/clear [agent]`

**Files:** Lines 3009-3031 (handler)

**What works:**
- `/clear` (no args): Clears all sessions, reports count.
- `/clear <agent>`: Clears specific agent's session.
- Uses `sanitizeAgentName` for consistent lookup.
- If no session exists for the named agent, shows a warning "No active session".
- Messages after clearing correctly state "Next /hey ... will start a fresh conversation."

**Issues found:**

None found. Clean and correct implementation.

---

## 10. `/status`

**Files:** Lines 2633-2643 (handler), 3589-3949 (`checkAgentStatus`)

**What works:**
- Supports both compact (default) and long format (`-l` or `--long`).
- Deduplicates agents by name.
- Handles zero agents gracefully.
- For each agent, probes `/.well-known/restap.json` with 3-second timeout to check if responding.
- Fetches news to calculate: last activity, active queries (within 10 min), orphaned queries (older), messages received, replies sent.
- Visual recency bar with color coding (green for recent, yellow for older, gray for inactive).
- Uptime calculation from `createdAt` timestamp.
- Special handling for the interactive manager agent (always "responding").
- Compact format shows one-line summary; long format shows full details including token ID.
- Uses `Promise.allSettled` so one failing agent doesn't block the rest.

**Issues found:**

### LOW: Compact format name padding is fixed at 12 characters

Line 3902: `agent.name.padEnd(12)` -- agents with names longer than 12 characters (common with ENS domains like "contracts.agent-21.sep.xid.eth") will push the rest of the line rightward, breaking alignment. Not a functional bug, just a display issue.

---

## 11. `/quit`

**Files:** Lines 1410-1413

**What works:**
- Matches both `/quit` and `/exit`.
- Prints goodbye message.
- Calls `process.exit(0)` for clean exit.

**Issues found:**

### LOW: No cleanup before exit

`process.exit(0)` is called without stopping any local agent processes, closing the database connection, or performing other cleanup. Running agents continue as orphan processes. This may be intentional (agents should survive CLI restart), but it's worth noting there's no graceful shutdown option.

---

## Cross-cutting Issues

### CRITICAL: Deploy flow ignores `domain`, `tokenId`, and `address` from YAML configs

(Detailed under `/deploy` above.) The `idchain.yaml` config carefully defines domain/tokenId/address for each agent, but none of these fields are included in the spawn payload. This is the most significant issue found -- the primary identity fields are lost during deployment.

The fix would be to include these in the spawn payload and have the manager store them in the `registry` JSON column and `token_id` column of the agents table.

### No references to removed features found

The CLAUDE.md documentation mentions `/keys`, `/pay`, `/tasks`, `/task`, and `/phase` commands. Grep of the CLI source confirms these handlers have been completely removed from the code. The help menu (HELP_ITEMS array, lines 58-72) does NOT list any of these removed commands. The CLAUDE.md documentation is out of date, but the code itself is clean.

### Commands in CLAUDE.md not in help menu (but still functional)

The following commands exist in the code but are not in the help menu:
- `/chat <agent>` - Enter chat mode with an agent
- `/model <agent> <model>` - Change agent's model
- `/logs [N]` - Show manager activity logs
- `/agent <name> logs` - Show agent logs
- `/agent <name> start` - Start a single agent
- `/agent <name> stop` - Stop a single agent
- `/agents start` - Start all agents
- `/agents stop` - Stop all agents
- `/agents save` - Save news feeds
- `/agents reset` - Reset agents with fresh directories
- `/watch <agent>` - Watch agent activity in real-time
- `/cancel <agent>` - Cancel running query
- `/registry` - Show/set registry configuration
- `/registry push` / `/registry pull` - Sync with onchain registry
- `/meta <agent>` - Show/set agent metadata
- `/reply <num|id>` - Reply to incoming questions
- `/list` - Show pending questions
- `/fetch <agent>` - Fetch files from agent
- `/share <file>` - Share file to all agents
- `/upload <agent> <file>` - Upload file to agent
- `/team` - Team management
- `/configs` - List available configs

These are intentionally omitted from the simplified help menu (per commit d9ce2c2: "Simplify help menu for public release") but remain fully functional.

---

## Summary of Issues by Severity

| Severity | Count | Key Issues |
|----------|-------|------------|
| CRITICAL | 1     | Deploy ignores domain/tokenId/address from YAML configs |
| MEDIUM   | 3     | `/news -l` flag broken; local processes not killed on delete; no port = skip kill on rebuild |
| LOW      | 8     | Duplicate /ask and /hey; dead code in rebuild; inconsistent wait times; no -l for plain /news; fixed padding; no exit cleanup; misleading delete warning; dangerouslySkipPermissions ignored |

---

## Recommendations

1. **Fix deploy flow (CRITICAL):** Add `domain`, `tokenId`, and `address` from `AgentSpec` to the spawn payload, and have the manager store them in the `registry` JSON and `token_id` column. Alternatively, run `/meta setid` automatically after spawn for agents that have these fields.

2. **Fix `/news -l` flag:** Parse the `-l` flag in the main `/news` handler before calling `checkAgentNews`, or update the help text to document the actual syntax (`/news top -l <agent>`).

3. **Kill local processes on delete:** Before calling the manager's DELETE endpoint, the CLI should find and kill the process on the agent's port (like the rebuild handler does).

4. **Add `claudeMd` to local agent deploy payload:** Include `claudeMd` in the local-agent spawn payload so CLAUDE.md content is written for local agents too.

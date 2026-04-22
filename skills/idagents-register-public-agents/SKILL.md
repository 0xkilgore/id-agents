---
name: idagents-register-public-agents
description: Register a public-agent (Juno instance behind a customer domain) on Base — first on ID Chain to get an xid.eth name, then on ERC-8004 IdentityRegistry with an agentURI that advertises the MCP endpoint. Use when the agent is already running publicly (docs.*, help.*, etc.) and you need it discoverable as an ERC-8004 agent. For LOCAL agents spawned by the manager, use `/register <agent>` instead — do NOT use this skill.
---

# Register Public Agents (Base only)

This skill registers a **public-agent** (Juno) on two Base contracts so external
callers can discover it as an ERC-8004 agent with an MCP endpoint:

1. **ID Chain (`IDAgentRegistrar`)** — assigns an `<name>.agent-N.xid.eth` ENS name. Triggered via the manager.
2. **ERC-8004 (`IdentityRegistry`)** — mints an agent NFT whose `agentURI` is `data:application/json;base64,<json>` with `{name, services:[{ENS,…},{MCP,…}]}`. Run directly with `id-cli register-agent`.
3. **ENSIP-25 link** — ties the ERC-8004 `agentId` back to the ENS name so clients resolving the name can find the agent. `id-cli link-agent`.

## When to use this

- ✅ The agent was registered with the manager via `/public add <domain>` — i.e. runtime `public-agent-remote`, served behind a public domain with its own `/mcp` endpoint.
- ✅ You want it discoverable via `8004scan.io` and via ENS resolvers that follow ENSIP-25.
- ✅ Target is **Base mainnet** (chain id 8453). This skill does not cover Sepolia, other L2s, or XMTP-only surfaces.

## When NOT to use this

- ❌ **Local agents** (runtime `claude-code`, `codex`, etc., spawned inside the manager). Those use the `/register <agent>` flow which:
  - updates the in-process CLAUDE.md with an onchain identity,
  - stages identity artifacts in the agent's working directory,
  - does NOT need the ERC-8004 step because they don't serve a public MCP.

  Running this skill on a local agent will just mint an unreachable ERC-8004 record whose MCP endpoint doesn't exist.
- ❌ You don't have a wallet with Base ETH. Check first — `~0.0002 ETH` per agent covers all 3 txs.
- ❌ The public domain's `/mcp` doesn't return 200. If the endpoint is broken, you'll write a dead agentURI onchain.

## Prerequisites

- Manager daemon running on `127.0.0.1:4100` (public-team endpoints live there).
- `id-cli` installed (`which id-cli` returns a path).
- OWS wallet configured. The manager reads `OWS_REGISTRAR_WALLET` from its `.env` to pick the signer. For direct `id-cli` commands, pass `OWS_WALLET=<wallet-name>` via env or `--wallet <wallet-name>` flag.
- The public-agent is already registered with the manager. Verify:

```bash
curl -sS -H "X-Id-Team: public" -H "X-Id-Admin: 1" http://127.0.0.1:4100/agents \
  | python3 -c "import sys,json;[print(a['name'],a.get('customer_domain')) for a in json.load(sys.stdin)['agents']]"
```

## Flow

### 0. Verify the /mcp endpoint

Before writing anything onchain, confirm the endpoint in the agentURI will actually resolve.

```bash
DOMAIN=docs.idagents.ai
curl -sSI https://$DOMAIN/mcp | head -1
# Expect HTTP/2 200 (or 405 — POST-only is fine; 404 is not).
```

### 1. ID Chain registration (via manager)

The manager signs with the wallet named by `OWS_REGISTRAR_WALLET`. One Base tx; assigns `<name>.agent-N.xid.eth`.

Find the agent's manager id:

```bash
AGENT_NAME=docs-idagents
AID=$(curl -sS -H "X-Id-Team: public" -H "X-Id-Admin: 1" http://127.0.0.1:4100/agents \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d['agents']:
  if a['name']==\"$AGENT_NAME\": print(a['id']); break")
echo "id=$AID"
```

Register:

```bash
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: public" \
  -H "X-Id-Admin: 1" \
  "http://127.0.0.1:4100/agents/$AID/onchain/register" \
  -d '{}' | python3 -m json.tool
```

Capture `domain` (the assigned xid.eth name) and `tokenId` from the response. Example:

```json
{"ok":true,"txHash":"0x2678...","tokenId":"agent-26",
 "domain":"docs-idagents.agent-26.xid.eth","agent":{...}}
```

### 2. ERC-8004 register

The `--link` flag on `register-agent` tries to do register + ENSIP-25 link in one breath. **Don't use it** — it races on nonce and the link tx often fails. Do the two steps separately.

```bash
ENS_NAME=docs-idagents.agent-26.xid.eth
DOMAIN=docs.idagents.ai

OWS_WALLET=idchain-registrar id-cli register-agent "$ENS_NAME" \
  --mcp "https://$DOMAIN/mcp" \
  --output json
```

Capture `data.agentId` from the response. Example: `45228`.

**What gets written onchain**: `agentURI = "data:application/json;base64," + base64(JSON.stringify({name: ENS_NAME, services: [{name:"ENS",endpoint:ENS_NAME},{name:"MCP",endpoint:"https://DOMAIN/mcp"}]}))`.

Dry-run first if you want to preview the exact bytes:

```bash
OWS_WALLET=idchain-registrar id-cli register-agent "$ENS_NAME" \
  --mcp "https://$DOMAIN/mcp" --dry-run
```

### 3. ENSIP-25 link

```bash
OWS_WALLET=idchain-registrar id-cli link-agent "$ENS_NAME" <agentId> \
  --output json
```

This sets a text record `agent-registration[<erc7930-address>][<agentId>] = "1"` on the ENS name, so name-resolvers can discover the ERC-8004 record.

### 4. Verify

```bash
echo "https://www.8004scan.io/agents/base/<agentId>"
id-cli info "$ENS_NAME" --brief
```

## Full example (docs.idagents.ai)

```bash
# 0. check mcp
curl -sSI https://docs.idagents.ai/mcp | head -1

# 1. ID Chain
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-Id-Team: public" -H "X-Id-Admin: 1" \
  http://127.0.0.1:4100/agents/virtual_docs-idagents/onchain/register -d '{}'
# → domain: docs-idagents.agent-26.xid.eth

# 2. ERC-8004
OWS_WALLET=idchain-registrar id-cli register-agent \
  docs-idagents.agent-26.xid.eth \
  --mcp https://docs.idagents.ai/mcp --output json
# → agentId: 45228

# 3. Link
OWS_WALLET=idchain-registrar id-cli link-agent \
  docs-idagents.agent-26.xid.eth 45228 --output json
```

Total cost on Base: ~0.000002 ETH across 3 txs.

## Troubleshooting

- **`nonce too low: next nonce N, tx nonce N-1`** — you used `--link`, nonce raced. Skip `--link`; run `id-cli link-agent` separately.
- **`OWS_WALLET not found`** — check `ows wallet list`, make sure the name matches exactly. The manager's signer comes from its own `.env` (`OWS_REGISTRAR_WALLET`); direct `id-cli` calls need `OWS_WALLET` in env or `--wallet` flag.
- **`Agent already on-chain at ...`** — `/public register-onchain` is idempotent. Response includes `alreadyRegistered:true` and the existing domain. Skip to ERC-8004 step.
- **`insufficient funds`** — check Base balance via `cast balance <addr> --rpc-url https://mainnet.base.org` or a quick `eth_getBalance` JSON-RPC call. Each agent needs ~0.0002 ETH to be safe.
- **`agent ID not found`** in ERC-8004 register output — the Transfer event couldn't be decoded. Look at the tx on basescan manually, grab the tokenId from the ERC-721 mint, then run `id-cli link-agent <ens-name> <tokenId>` to finish.

## Contract addresses (Base mainnet)

- **ID Chain `IDAgentRegistrar`**: `0xa6D23f27D3b1780B12488482a008cB3c3787135f`
- **ID Chain registry** (name NFT): `0x92DF3A4CB6827Bf199FdAd429B36622f0C8167F0`
- **ERC-8004 `IdentityRegistry`**: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

Source: `id-agents/.env` (AGENT_REGISTRAR_ADDRESS, AGENT_REGISTRY_ADDRESS) and `id-cli/src/config.ts` (IDENTITY_REGISTRY_8004).

## Why two steps instead of one

The manager owns the ID Chain registrar wallet and the name-assignment sequence, so step 1 must go through it. ERC-8004 is an open registry — anyone holding the ENS name's owner key can register it, which is why step 2/3 run as direct `id-cli` commands. This split also means the manager stays authoritative for name state while ERC-8004 agentIds track independently in an external registry.

## Source references

- Manager endpoint: `id-agents/src/agent-manager-db.ts` (`POST /agents/:id/onchain/register`)
- Public-team helpers: `id-agents/src/cli/public-commands.ts` (`registerPublicOnchain`)
- Signing convention: `id-agents/src/onchain/idchain-register.ts` (`buildIdCliEnv`)
- ERC-8004 agentURI construction: `id-cli/src/commands/agent.ts` (`registerAgentCommand`, lines 58–69)

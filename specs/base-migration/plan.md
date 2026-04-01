# Base-Only Migration Plan

> Consolidate from 5 chains to Base only. Domain format changes from `agent-0.base.xid.eth` to `agent-0.xid.eth`. All alpha registrations abandoned.

## Summary

| Before | After |
|--------|-------|
| 5 chains (Base, ETH, OP, ARB, Sepolia) | Base only (8453) |
| `agent-0.base.xid.eth` | `agent-0.xid.eth` |
| PARENT_NODE: `base.xid.eth` | PARENT_NODE: `xid.eth` |
| `--chain` flag on every command | No chain flag |
| Chain selector in UI | No chain selector |
| Gateway resolves per-chain | Gateway resolves Base |
| Indexer indexes 5 chains | Indexer indexes Base |

## Execution Order

1. **idx (contracts)** — deploy fresh on Base under `xid.eth` parent
2. **id-cli** — remove `--chain`, hardcode Base, update PARENT_NODE
3. **idx-gateway** — point to Base registry only
4. **idx-indexer** — index Base only
5. **id-app** — remove chain selector, update contract addresses
6. **id-agents** — update configs, re-register agents as `*.xid.eth`

---

## 1. idx (contracts)

The contracts themselves don't change — IDRegistry, IDAgentRegistrar, resolvers are chain-agnostic. We just need a fresh deployment on Base with `xid.eth` as the parent node.

**Actions:**
- Deploy IDRegistry on Base mainnet
- Deploy IDAgentRegistrar on Base mainnet
- Set PARENT_NODE to namehash of `xid.eth` (not `base.xid.eth`)
- Record new contract addresses

**Files to update:**
- `script/Deploy.s.sol` — update default chain config
- `script/deploy-config.json` or equivalent — Base addresses only
- Remove Sepolia, ETH, OP, ARB deploy scripts/configs if separate

**Deletes:**
- Any chain-specific deploy configs for non-Base chains

---

## 2. id-cli

The biggest code change. Remove the chain abstraction entirely.

**Files to change:**

### `src/config.ts`
- Remove `CHAIN_CONFIGS` entries for chains 1, 10, 42161, 11155111
- Keep only chain 8453 (Base)
- Change the Base config suffix from `.base.xid.eth` to `.xid.eth`
- Update PARENT_NODE to namehash of `xid.eth`
- Update contract addresses to new Base deployment
- Remove `RPC_URL_ETH`, `RPC_URL_OP`, `RPC_URL_ARB`, `RPC_URL_SEPOLIA` env var support
- Remove `getChainConfig()` chain lookup — there's only one config
- Remove chain name aliases (`eth`, `ethereum`, `op`, `optimism`, `arb`, `arbitrum`, `sep`, `sepolia`)

### `src/utils.ts`
- Remove `resolveNameAsync()` chain detection from domain suffixes
- Simplify — all domains end in `.xid.eth`, no chain parsing needed
- Remove `chainNames` mapping

### `src/commands/*.ts` (all write commands)
- Remove `--chain` / `-c` option from every command
- Remove chain resolution logic
- Hardcode Base chain ID (8453)

### `src/index.ts`
- Remove `--chain` from global options if it's there

### `src/provider.ts`
- `getProvider()` and `getWallet()` no longer need chainId param — always Base

### `README.md`
- Remove "Supported Chains" table
- Remove `--chain` from all examples
- Update domain examples from `agent-0.base.xid.eth` to `agent-0.xid.eth`

**Deletes:**
- Chain name resolution code
- Per-chain RPC env var handling (keep just `RPC_URL` as optional override)

---

## 3. idx-gateway

**Files to change:**

### `index.ts` / `gateway.ts`
- Remove multi-chain RPC config — one RPC URL for Base
- Remove chain detection from request path (currently `/{chain}/{sender}`)
- Simplify URL format to `/{sender}` or keep `/{chain}/{sender}` but only accept `base`/`8453`
- Update registry contract address to new Base deployment
- Remove chain-specific REGISTRY_ABI imports if any

### `.env`
- One RPC URL for Base
- One registry address
- One registrar address

### `setup.sh`
- Update any chain-specific references

**Deletes:**
- Multi-chain RPC configuration
- Chain routing logic

---

## 4. idx-indexer

**Files to change:**

### `ponder.config.ts`
- Remove contract definitions for EthIDRegistry, OpIDRegistry, ArbIDRegistry, SepoliaIDRegistry
- Keep only BaseIDRegistry (rename to just IDRegistry)
- One RPC URL, one set of contract addresses
- Update startBlock to the new Base deployment block

### `src/index.ts`
- Remove duplicate event handler registrations for each chain
- One set of handlers: `ponder.on("IDRegistry:*", ...)`
- Remove `ponder.on("EthIDRegistry:*", ...)`, `ponder.on("OpIDRegistry:*", ...)`, etc.

### `src/schema.ts` (ponder schema)
- `chainId` field in domain composite IDs becomes unnecessary (always 8453)
- Consider simplifying composite IDs from `${chainId}-${node}` to just `${node}`
- Or keep chainId for future-proofing but always set to 8453

### `src/api/index.ts`
- Remove chain filtering from API endpoints
- Remove `?chain=` query parameter
- Simplify domain lookups (no chain prefix in IDs)

### `.env`
- One RPC URL
- Remove CHAINSTACK_*, ALCHEMY_* multi-chain keys

**Deletes:**
- 4 chain-specific contract configurations
- 4 sets of duplicate event handler registrations
- Chain filtering logic in API

---

## 5. id-app

**Files to change:**

### `src/config/contracts.ts`
- Remove `CHAIN_CONFIGS` entries for chains 1, 10, 42161, 11155111
- Keep only Base (8453)
- Update suffix to `.xid.eth`
- Update contract addresses to new Base deployment
- Remove per-chain RPC env vars

### `src/config/appkit.ts`
- Remove networks other than Base from Wagmi/AppKit config

### `src/app/register/page.tsx`
- Remove chain selector dropdown
- Hardcode Base

### `src/app/name/[label]/page.tsx`
- Remove chain-aware domain resolution
- All names are `*.xid.eth`
- Update COIN_NAMES if chain-specific entries change
- Simplify reverse registrar logic (Base only)

### `content/docs/user/*.mdx`
- Update all docs to remove chain references
- Update domain examples to `agent-0.xid.eth`
- Remove "Supported Chains" section from CLI docs
- Remove chain flag from all command examples

### `src/lib/indexer-server.ts`
- Remove chain parameter from indexer API calls

**Deletes:**
- Chain selector components
- Multi-chain Wagmi network config
- Chain-specific RPC env vars

---

## 6. id-agents

**Files to change:**

### `configs/idchain.yaml`
- Update `chainId: 8453` (already Base)
- Update registryAddress to new Base deployment
- Remove all domain/tokenId fields (alpha registrations abandoned)
- Agents will get new `*.xid.eth` domains on re-registration

### `src/onchain/idchain-register.ts`
- Remove chain name mapping (`chainNames` object)
- Hardcode `base` or remove chain param entirely
- Update id-cli calls to not pass `--chain`

### `src/agent-manager-db.ts`
- Remove `chainNames` mapping in registration flow
- Remove chain resolution in `/register` command handler
- Update any `*.sep.xid.eth` or `*.base.xid.eth` references

### `README.md`
- Update domain examples to `agent-0.xid.eth`
- Remove chain references

**Deletes:**
- Chain name mappings
- `--chain` pass-through to id-cli

---

## New Contract Addresses

After deploying on Base, record:

```
CHAIN_ID=8453
PARENT_NODE=<namehash of xid.eth>
ID_REGISTRY=<new address>
ID_AGENT_REGISTRAR=<new address>
```

These propagate to all repos.

---

## What Gets Simpler

- id-cli: every command loses `--chain` flag
- id-app: no chain selector, cleaner registration flow
- Gateway: one RPC, one registry, simpler request handling
- Indexer: one contract config, one set of event handlers (~60% less code)
- Domain names: `agent-0.xid.eth` instead of `agent-0.base.xid.eth`
- Config: one set of addresses, not five

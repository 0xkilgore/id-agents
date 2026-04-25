---
name: foundry-scripting-and-deploy
description: Use when writing forge Script files, deploying contracts, handling per-chain configuration, or running post-deploy verification. Covers Script base, vm.startBroadcast forms, env var handling, --rpc-url / --broadcast / --verify flags, CREATE2 deterministic deploys, multi-chain guards, and machine-readable JSON output.
license: MIT
version: 0.1.0
tags: [foundry, forge, deployment, scripting, multichain, create2]
---

# Foundry Scripting and Deployment

You are writing a `forge script` or running a deployment. A script that touches mainnet is a piece of production code; treat it like one. The script is read, reviewed, and re-run. Hardcoded addresses and "I'll fix it later" comments are bugs in waiting.

## The Iron Laws

1. **NEVER HARDCODE A PRIVATE KEY.** Not in the script, not in a config file, not in a comment. Read from `vm.envUint("PRIVATE_KEY")` or use an account / keystore flag. A leaked key takes seconds to drain.
2. **NEVER COMMIT A `.env` FILE.** `.env` belongs in `.gitignore`. Commit `.env.example` with placeholders instead. If you discover a committed `.env`, rotate every key in it immediately — git history is forever.
3. **NEVER RUN `forge script ... --broadcast` WITHOUT A DRY RUN FIRST.** Always run once without `--broadcast` to inspect the simulated traces. Production deploys that revert mid-way cost real gas and real time.
4. **NEVER DEPLOY WITHOUT A CHAIN-ID GUARD.** Every deploy script that encodes chain-specific addresses (oracles, bridges, tokens) asserts `block.chainid` at the top. Deploying the mainnet config to a testnet is embarrassing; deploying the testnet config to mainnet is a catastrophe.
5. **ALWAYS EMIT DEPLOYED ADDRESSES AS JSON.** Downstream tooling (bots, subgraphs, frontends) reads your deploys. Log `{"contract":"Vault","address":"0x...","tx":"0x..."}` so they can parse it, not a human-readable paragraph.
6. **NEVER SKIP VERIFICATION.** Pass `--verify` (or run `forge verify-contract` after) for every mainnet and testnet deploy. Unverified contracts are opaque; users cannot audit what they are signing into.

## Script file shape

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";

contract DeployVault is Script {
    function run() external returns (Vault vault) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address asset = vm.envAddress("VAULT_ASSET");

        vm.startBroadcast(deployerPk);
        vault = new Vault(asset);
        vm.stopBroadcast();

        console2.log("{\"contract\":\"Vault\",\"address\":\"%s\"}", address(vault));
    }
}
```

Conventions:

- One deploy per script file. `DeployVault.s.sol` deploys `Vault`. Don't chain five unrelated deploys in one script.
- Always `return` the deployed contract. Makes composition cleaner when one script calls another.
- Use `console2.log` not `console.log`. `console2` is the updated log API in newer forge-std and does not silently truncate.

## Broadcasting forms

`vm.startBroadcast` has three forms. Pick deliberately.

| Form | Sender | When |
|---|---|---|
| `vm.startBroadcast()` | Default sender inferred from `--sender`, `--private-key`, `--mnemonic`, or `--account` flags passed to `forge script`. | Local dev, flexible CI that provides creds via flags. |
| `vm.startBroadcast(uint256 pk)` | The address derived from `pk`. | Explicit env-var key (`vm.envUint`). |
| `vm.startBroadcast(address from)` | `from`. Requires forge to know the key for `from` (via account, keystore, etc.). | Deploy from a hardware wallet or a named keystore account. |

Prefer `vm.startBroadcast()` with CLI-level auth (`--account deployer` + Foundry keystore) over raw private keys in env. Keystore is encrypted at rest; `.env` is plaintext.

## Environment variable handling

All runtime config comes from env. Read in the script, never from a committed constant.

```solidity
uint256 deployerPk   = vm.envUint("DEPLOYER_PRIVATE_KEY");
address registry     = vm.envAddress("REGISTRY_ADDRESS");
string memory name   = vm.envString("TOKEN_NAME");
bytes32 salt         = vm.envBytes32("CREATE2_SALT");
uint256 chainId      = block.chainid; // read from context, not env
```

### Defaults for local anvil

When developers run the script against anvil, they shouldn't have to set every env var. Use `vm.envOr` for local defaults:

```solidity
// Anvil's default first key, safe because it's well-known and worthless.
uint256 deployerPk = vm.envOr(
    "DEPLOYER_PRIVATE_KEY",
    uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
);
```

**Rule**: fallback defaults are only for local anvil. Never fall back on a mainnet path. The dev private key above is public — do not fund it.

### .env.example

Commit this. Real values never.

```
# .env.example
DEPLOYER_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000
RPC_URL_MAINNET=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_SEPOLIA=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY
VAULT_ASSET=0x0000000000000000000000000000000000000000
```

## Chain-ID guards

Multi-chain scripts read config by chain ID.

```solidity
contract DeployVault is Script {
    struct ChainConfig {
        address asset;
        address oracle;
    }

    function _configForChain() internal view returns (ChainConfig memory c) {
        if (block.chainid == 1) {
            // Mainnet
            c.asset  = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // USDC
            c.oracle = 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6;
        } else if (block.chainid == 11155111) {
            // Sepolia
            c.asset  = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
            c.oracle = 0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E;
        } else if (block.chainid == 31337) {
            // Anvil — deploy mocks in setUp instead
            revert("configure anvil mocks in setUp");
        } else {
            revert(string.concat("unsupported chain: ", vm.toString(block.chainid)));
        }
    }

    function run() external {
        ChainConfig memory cfg = _configForChain();
        // ...
    }
}
```

**Rule**: the `else` branch reverts. Unknown chains are errors, not defaults.

## CREATE2 deterministic deploys

For contracts that must have the same address across chains (factories, singletons), use CREATE2. Two options:

### Option A: script-level `new MyContract{salt: SALT}(args)`

```solidity
bytes32 salt = vm.envBytes32("CREATE2_SALT");
Vault vault = new Vault{salt: salt}(asset);
```

The resulting address depends on the salt, the bytecode, the constructor args, and the **deployer address**. Changing any of these gives a different address. If you need cross-chain sameness, the deployer must also be the same across chains.

### Option B: CreateX / deterministic factory

The CreateX contract (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, deployed across dozens of chains at the same address) gives cross-chain CREATE2/CREATE3 without requiring the *deployer* to match. Use this when the deployer is different per chain.

```solidity
ICreateX createx = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
address vault = createx.deployCreate3(salt, abi.encodePacked(
    type(Vault).creationCode,
    abi.encode(asset)
));
```

### Predict the address before deploying

Always log the predicted address and the actual address. If they differ, something about the salt, bytecode, or args changed from the plan.

```solidity
address predicted = computeCreate2Address(salt, keccak256(abi.encodePacked(
    type(Vault).creationCode,
    abi.encode(asset)
)));
Vault vault = new Vault{salt: salt}(asset);
require(address(vault) == predicted, "create2 address drift");
```

## Running a script

### Dry run first

```bash
forge script script/DeployVault.s.sol:DeployVault \
    --rpc-url $RPC_URL_SEPOLIA \
    --sender 0xYourAddress
```

No `--broadcast`. No `--verify`. Reads traces, fails loudly if anything reverts, costs nothing.

### Broadcast when happy

```bash
forge script script/DeployVault.s.sol:DeployVault \
    --rpc-url $RPC_URL_SEPOLIA \
    --private-key $DEPLOYER_PRIVATE_KEY \
    --broadcast \
    --verify \
    --etherscan-api-key $ETHERSCAN_API_KEY
```

Or, safer, with a Foundry keystore account:

```bash
# One-time:
cast wallet import deployer --interactive

# Every deploy:
forge script script/DeployVault.s.sol:DeployVault \
    --rpc-url $RPC_URL_SEPOLIA \
    --account deployer \
    --sender 0xYourDeployerAddress \
    --broadcast \
    --verify
```

`--verifier-url` is needed for non-Etherscan block explorers (e.g. Blockscout, Routescan):

```bash
--verifier blockscout \
--verifier-url https://explorer.some-chain.io/api
```

(Source: https://getfoundry.sh/forge/deploying)

### Flags you will use

| Flag | Effect |
|---|---|
| `--rpc-url <url>` | Which chain to talk to. |
| `--broadcast` | Actually send transactions. Omit for dry run. |
| `--sender <addr>` | The address the script assumes as deployer. Required for dry runs that access `msg.sender`. |
| `--private-key <key>` | Provide the key inline. Prefer `--account`. |
| `--account <name>` | Use a key from the Foundry keystore (encrypted). |
| `--verify` | Submit to block explorer on success. |
| `--etherscan-api-key <key>` | Etherscan (and compatible) API key. |
| `--verifier <name>` | `etherscan`, `blockscout`, `sourcify`, `routescan`. |
| `--verifier-url <url>` | Override the verifier endpoint. |
| `--slow` | Wait for each tx receipt before sending the next. Useful on congested chains and debugging. |
| `--skip-simulation` | Skip the simulation step. Rare; almost always wrong. |
| `--resume` | Resume a partially-failed broadcast from `broadcast/*/dry-run.latest.json`. |

## Post-deploy verification

If `--verify` failed (API rate limit, wrong API key, whatever), run it standalone:

```bash
forge verify-contract \
    --chain sepolia \
    --watch \
    --constructor-args $(cast abi-encode "constructor(address)" $VAULT_ASSET) \
    0xDeployedAddress \
    src/Vault.sol:Vault
```

`--watch` polls until verification succeeds or fails definitively, so you don't have to.

## JSON output for tooling

Downstream consumers parse your deploy output. Emit one JSON blob per deployed contract:

```solidity
console2.log(
    string.concat(
        "{\"name\":\"Vault\",",
        "\"address\":\"", vm.toString(address(vault)), "\",",
        "\"chainId\":", vm.toString(block.chainid),
        "}"
    )
);
```

Or write a structured file:

```solidity
string memory json = "deployment";
vm.serializeAddress(json, "vault", address(vault));
vm.serializeAddress(json, "asset", asset);
string memory finalJson = vm.serializeUint(json, "chainId", block.chainid);
vm.writeJson(finalJson, string.concat("deployments/", vm.toString(block.chainid), ".json"));
```

Commit the `deployments/*.json` files. They are the source of truth for "what is live where".

## Script for ops (not just deploys)

`forge script` is also the right tool for one-off production operations: upgrading a proxy, transferring ownership, seeding a pool.

```solidity
contract TransferOwnership is Script {
    function run() external {
        uint256 pk = vm.envUint("ADMIN_PRIVATE_KEY");
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));
        address newOwner = vm.envAddress("NEW_OWNER");

        require(block.chainid == 1, "mainnet only");

        vm.startBroadcast(pk);
        vault.transferOwnership(newOwner);
        vm.stopBroadcast();
    }
}
```

Same rules: dry run first, chain guard, no hardcoded keys, log the outcome.

## Anvil for local iteration

```bash
anvil --fork-url $RPC_URL_MAINNET --fork-block-number 19500000
```

Forks mainnet state. Run deploy scripts against `http://localhost:8545` without spending real gas. Ideal for rehearsing a deploy before running it on the real network.

## Counter-examples to reject in review

```solidity
// Hardcoded key
uint256 pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

// No chain guard
if (block.chainid == 1) { /* mainnet path */ }
// else silently runs the mainnet path on any chain

// No verification
forge script Deploy.s.sol --broadcast  // no --verify

// Human-readable only
console2.log("Deployed Vault at", address(vault));
// script output: "Deployed Vault at 0xabc..." — not JSON-parseable

// .env in git
git add .env                           // never
```

## References

- Forge scripting — https://getfoundry.sh/forge/scripts
- Deploying — https://getfoundry.sh/forge/deploying
- Verification — https://getfoundry.sh/forge/deploying#verifying-a-pre-existing-contract
- Foundry keystore (`cast wallet import`) — https://getfoundry.sh/cast/reference/cast-wallet-import
- CreateX — https://github.com/pcaversaccio/createx
- Anvil — https://getfoundry.sh/anvil/overview

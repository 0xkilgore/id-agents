---
name: solidity-style-modern
description: Use when writing or reviewing Solidity source for compiler 0.8.20 and later. Encodes modern conventions: pinned pragma, SPDX headers, custom errors over require-strings, checks-effects-interactions, NatSpec on external surfaces, storage layout care, and naming discipline (I_ s_ i_ CONSTANT_CASE _underscoreCased). Day-to-day style, not security audit.
license: MIT
version: 0.1.0
tags: [solidity, style, conventions, naming, natspec]
---

# Modern Solidity Style (0.8.20+)

You are writing or reviewing a Solidity source file. Follow these conventions before any stylistic preference you learned elsewhere. Consistency across a codebase is worth more than any individual rule.

## The Iron Laws

1. **NO FLOATING PRAGMA.** `pragma solidity 0.8.26;` — exact, pinned. Not `^0.8.20`, not `>=0.8.20 <0.9.0`. The compiler version is a deployed artifact; pin it. (Source: https://docs.soliditylang.org/en/v0.8.26/layout-of-source-files.html)
2. **NO MISSING SPDX HEADER.** The first line of every `.sol` file is `// SPDX-License-Identifier: <id>`. Without it, solc emits a warning and you cannot tell licensed code from copied code.
3. **NO `require(cond, "string")` IN NEW CODE.** Use custom errors: `if (!cond) revert Unauthorized(msg.sender);`. Saves gas, saves bytecode, gives you typed failure data.
4. **NO STATE MUTATION AFTER AN EXTERNAL CALL.** Checks-Effects-Interactions. Validate, update state, *then* call out. This is not negotiable.
5. **NO MISSING NATSPEC ON EXTERNAL OR PUBLIC SURFACES.** Every `external` / `public` function, every custom error, every event gets at least `@notice`. Internal helpers can skip it; the surface cannot.
6. **NO INLINE ASSEMBLY WITHOUT A COMMENT EXPLAINING WHY.** Every `assembly { ... }` block starts with a comment stating the reason (gas, layout trick, missing Solidity feature) and what invariants it preserves. No comment, no assembly.
7. **NO `tx.origin` FOR AUTHORIZATION, EVER.** `msg.sender` for auth. `tx.origin` is a footgun with a known CVE-scale exploit pattern. This rule has no exceptions in application code.

## File layout order

Every `.sol` file follows this order exactly:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// 1. Imports (named, never glob)
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// 2. File-level custom errors (if shared across contracts in this file)
error ZeroAddress();

// 3. File-level events (rare; usually inside the contract)

// 4. Contracts, in definition order: interfaces, libraries, abstract, concrete
interface IVault { ... }
library VaultLib { ... }
contract Vault is IVault { ... }
```

## Contract element order

Inside a contract, members appear in this order:

1. `using ... for ...` directives
2. `type` declarations (structs, enums)
3. State variables (constants first, then immutables, then mutable storage)
4. Events
5. Custom errors
6. Modifiers
7. `constructor`
8. `receive()` if present
9. `fallback()` if present
10. External functions
11. Public functions
12. Internal functions
13. Private functions

Within each function visibility group: `view`/`pure` functions after state-mutating ones. This matches the Solidity style guide.

## Naming conventions

You MUST use these prefixes. A reviewer scanning the file should know what every identifier is without looking at its declaration.

| Kind | Convention | Example |
|---|---|---|
| Interface | `I` prefix, PascalCase | `IERC20`, `IVault` |
| Library | PascalCase, no prefix | `SafeERC20` |
| Contract | PascalCase, no prefix | `Vault`, `StakingPool` |
| Constant (file- or contract-level) | `UPPER_SNAKE_CASE` | `MAX_SUPPLY`, `BASIS_POINTS` |
| Immutable state var | `i_` prefix, camelCase | `i_owner`, `i_deployTimestamp` |
| Storage state var | `s_` prefix, camelCase | `s_totalSupply`, `s_balances` |
| Storage mapping | `s_` prefix | `s_balanceOf` |
| Function parameter | camelCase, no prefix | `recipient`, `amount` |
| Local variable | camelCase | `currentBalance` |
| External / public function | camelCase | `transfer`, `totalSupply` |
| Internal / private function | `_` prefix, camelCase | `_mint`, `_beforeTokenTransfer` |
| Event | PascalCase, verb-past-tense | `Transferred`, `OwnershipHandedOff` |
| Custom error | PascalCase, usually a noun phrase | `Unauthorized`, `InsufficientBalance` |
| Modifier | camelCase | `onlyOwner`, `whenNotPaused` |

The `s_` / `i_` convention is not in the official style guide but has become the community default since 2023 for codebases that want storage access to be visually obvious. Adopt it unless the existing codebase clearly does not.

## Custom errors

Custom errors replace `require(cond, "string")` in every new codebase.

DO:
```solidity
error InsufficientBalance(uint256 requested, uint256 available);
error Unauthorized(address caller);
error ZeroAmount();

function withdraw(uint256 amount) external {
    if (amount == 0) revert ZeroAmount();

    uint256 bal = s_balances[msg.sender];
    if (amount > bal) revert InsufficientBalance(amount, bal);

    s_balances[msg.sender] = bal - amount;
    _transfer(msg.sender, amount);
}
```

DON'T:
```solidity
function withdraw(uint256 amount) external {
    require(amount > 0, "ZERO_AMOUNT");
    require(amount <= s_balances[msg.sender], "INSUFFICIENT_BALANCE");
    // ...
}
```

**Why**: custom errors are ~50 bytes per call cheaper, serialize as typed data, and your tests can match them by selector (`MyContract.InsufficientBalance.selector`) rather than brittle string compares.

## Checks-Effects-Interactions

**Checks**: validate inputs and authorize the caller.
**Effects**: update your own storage.
**Interactions**: call other contracts.

```solidity
// DO
function withdraw(uint256 amount) external {
    // Checks
    if (amount == 0) revert ZeroAmount();
    uint256 bal = s_balances[msg.sender];
    if (amount > bal) revert InsufficientBalance(amount, bal);

    // Effects
    s_balances[msg.sender] = bal - amount;
    emit Withdrawn(msg.sender, amount);

    // Interactions
    (bool ok,) = msg.sender.call{value: amount}("");
    if (!ok) revert TransferFailed();
}

// DON'T
function withdrawBad(uint256 amount) external {
    uint256 bal = s_balances[msg.sender];
    if (amount > bal) revert InsufficientBalance(amount, bal);

    (bool ok,) = msg.sender.call{value: amount}(""); // INTERACTION FIRST
    if (!ok) revert TransferFailed();

    s_balances[msg.sender] = bal - amount; // EFFECT AFTER — classic reentrancy
}
```

This is the single most-exploited category of Solidity bug in history. It is also the easiest to avoid.

## NatSpec

Every `external` or `public` function gets NatSpec. Minimum: `@notice`. When parameters are non-obvious: `@param`. When the return needs explanation: `@return`.

```solidity
/// @notice Transfers `amount` tokens from the caller to `to`.
/// @param to The recipient. Must not be the zero address.
/// @param amount The amount to transfer, denominated in token units (decimals applied).
/// @return success True if the transfer succeeded.
/// @dev Reverts with `InsufficientBalance` if the caller has less than `amount`.
function transfer(address to, uint256 amount) external returns (bool success);
```

NatSpec tags you actually use:

- `@notice` — user-facing one-liner. Required.
- `@dev` — implementation notes for developers / auditors. Add when behavior is non-obvious.
- `@param name description` — one per argument when it helps.
- `@return name description` — one per return value.
- `@inheritdoc IFoo` — when implementing an interface, inherit the NatSpec instead of copying.

Skip `@author`, `@title`, and the horoscope. They rot.

## Visibility defaults

- Functions: pick the *least* permissive that works. Start with `private`, widen to `internal`, then `external`. Never use `public` when `external` will do (saves ~24 gas per call because arguments stay in calldata).
- State variables: default `private`. Expose with an explicit getter function or `public` when the autogenerated getter is exactly what you want. Avoid `public` state that ends up part of an informal ABI.

## Immutable and constant

- **`constant`** — value known at compile time, embedded in bytecode. Use for magic numbers (`uint256 internal constant BASIS_POINTS = 10_000;`).
- **`immutable`** — value set in the constructor and never again. Use for deploy-time configuration (`i_owner`, `i_deployBlock`). Cheaper than storage reads.
- Everything else is storage (`s_`).

If you find yourself writing a setter for a value that never changes after deployment, make it `immutable` instead.

## `unchecked` blocks

Solidity 0.8+ checks arithmetic for overflow by default. `unchecked` skips the check for a gas win. It is a footgun.

Rule: every `unchecked` block is preceded by a comment that:

1. Names the invariant that makes it safe.
2. Points at the check that establishes the invariant.

```solidity
// OK
// Safe: `amount` is bounded above by `bal` on the line above.
unchecked {
    s_balances[msg.sender] = bal - amount;
}

// NOT OK
unchecked {
    s_balances[msg.sender] -= amount; // no justification
}
```

Common safe use: loop counters on indices bounded by `array.length`:

```solidity
for (uint256 i; i < xs.length;) {
    // ...
    unchecked { ++i; }
}
```

Note: on solc 0.8.22+ the compiler auto-unchecks loop counters in many cases. Measure before adding `unchecked { ++i }` manually. See `gas-optimization-foundry`.

## Storage layout

Each storage slot is 32 bytes. The compiler packs adjacent variables that fit.

Pack deliberately:

```solidity
// Packs into two slots (32 + 32)
struct Position {
    uint128 collateral;   // slot 0, bytes 0-15
    uint128 debt;         // slot 0, bytes 16-31
    uint64  lastUpdate;   // slot 1, bytes 0-7
    uint64  maturity;     // slot 1, bytes 8-15
    address owner;        // slot 1, bytes 16-35 (address = 20 bytes)
}
```

Rules:

- Group small types together. A `uint128` followed by `uint256` wastes half a slot.
- Do not rearrange storage layout of a deployed contract without an upgrade plan. Storage slot numbers are part of the ABI for upgradeable contracts.

### Gap arrays for upgradeable contracts

When writing upgradeable contracts (e.g. UUPS, TransparentProxy), reserve storage at the end of each contract to allow future variables without shifting slots:

```solidity
contract MyLogicV1 is Initializable {
    uint256 public s_count;
    mapping(address => uint256) public s_balances;

    /// @dev Reserved storage for future upgrades. Do not modify.
    uint256[48] private __gap;
}
```

The `__gap` size is conventional; 48 or 50 are common. Shrink the gap when you add new variables above it — never rearrange.

## `receive()` and `fallback()` hygiene

Only define them if you actually need to accept plain-ETH transfers or handle unknown calldata.

- `receive() external payable` — plain ETH transfer with empty calldata. Keep it small; consumers often send with 2300 gas.
- `fallback() external [payable]` — any call that didn't match a function selector. Payable only if you need it; non-payable by default.

If your contract should not accept ETH, define neither. The compiler-default revert is correct.

## Assembly

You almost never need it. When you do, the block starts with a comment:

```solidity
// Read balance from slot(0) directly to save ~100 gas in the hot path.
// Safe because s_balance is declared first and occupies slot 0.
// If storage layout changes, this breaks — guarded by test_StorageLayoutInvariant.
assembly {
    bal := sload(0)
}
```

Without a comment explaining *why* and pointing at the *guard*, reject the assembly in review.

## Imports

Always named, never glob:

```solidity
// DO
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

// DON'T
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import * from "./Shared.sol";
```

Named imports prevent name collisions and make it obvious what each file depends on.

## Counter-examples to reject in review

```solidity
pragma solidity ^0.8.20;                         // floating pragma
require(amount > 0, "ZERO");                     // string-based revert
function admin() public { ... }                   // public where external fits
uint256 public totalSupply;                       // no s_ prefix, public state leaks ABI
function doStuff() external { ... }               // no NatSpec on external
assembly { sstore(0, 1) }                         // no comment
msg.value > 0 || tx.origin == owner               // tx.origin auth
```

## References

- Solidity style guide — https://docs.soliditylang.org/en/latest/style-guide.html
- NatSpec format — https://docs.soliditylang.org/en/latest/natspec-format.html
- Layout in storage — https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html
- Custom errors (0.8.4+) — https://soliditylang.org/blog/2021/04/21/custom-errors/

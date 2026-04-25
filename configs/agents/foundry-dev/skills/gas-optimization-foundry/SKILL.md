---
name: gas-optimization-foundry
description: Use when measuring or reducing gas in a Foundry project. Enforces a measurement-first workflow with forge snapshot / forge snapshot --diff / forge test --gas-report / call traces at -vvvv, and lists the real wins (struct packing, calldata, custom errors, immutable, caching storage) vs the anti-patterns (++i micro-opts on 0.8.22+, unmeasured yul, readability-destroying tricks).
license: MIT
version: 0.1.0
tags: [foundry, forge, gas, optimization, performance]
---

# Gas Optimization with Foundry

You are reducing gas on a Solidity contract. Gas is a real cost paid by real users; it is worth spending time to bring it down. But every "optimization" in Solidity folklore either:

- Works, measurably, and is worth the code complexity cost.
- Worked on solc 0.6 but the modern optimizer already does it.
- Never worked and is cargo cult.

This skill makes you prove which category you are in before you change any code.

## The Iron Laws

1. **NO OPTIMIZATION WITHOUT A BEFORE-AND-AFTER SNAPSHOT.** Every gas change lands with a `forge snapshot --diff` in the PR. A commit message that says "optimize loop" without a number is rejected. Exact format: quote the before, the after, and the delta.
2. **NO OPTIMIZATION THAT HURTS READABILITY WITHOUT A HOT-PATH JUSTIFICATION.** A cryptic trick saving 50 gas in a function called once per deploy is negative value. A cryptic trick saving 5,000 gas in a function called per swap is the job. Name the hot path in the comment.
3. **NO INLINE YUL FOR PERFORMANCE UNTIL THE SOLIDITY VERSION HAS BEEN MEASURED.** The optimizer is smarter than it used to be. Write the Solidity version first, `forge snapshot`, *then* decide if yul is worth the maintenance burden.
4. **NO MICRO-OPTIMIZATION BEFORE CORRECTNESS.** `forge test` must pass at every commit in the gas-optimization branch. If you are chasing gas numbers with red tests, stop.
5. **ALWAYS RE-RUN THE WHOLE SUITE, NOT JUST THE TARGETED TEST.** Gas changes in one function ripple through shared code paths. `forge snapshot` runs everything and catches regressions elsewhere.

## The measurement-first workflow

```text
1. Baseline       → forge snapshot  (saves .gas-snapshot)
2. Change         → edit code, forge test passes
3. Measure        → forge snapshot --diff
4. Keep or revert → paste diff in PR or revert
```

Every optimization follows this loop. No loop, no optimization.

### `forge snapshot`

```bash
forge snapshot
```

Writes `.gas-snapshot` with one line per test: `testName() (gas: 123456)`. Commit this file. It is your baseline.

### `forge snapshot --diff`

```bash
forge snapshot --diff
```

Shows the delta against the committed `.gas-snapshot`. Positive numbers (red) are regressions. Negative numbers (green) are wins.

### `forge snapshot --check`

```bash
forge snapshot --check
```

Exits non-zero if any test's gas increased beyond the tolerance. Use in CI to block silent regressions.

### `forge test --gas-report`

```bash
forge test --gas-report
```

Per-function gas table (min / avg / median / max) across all tests. Use when you want to know *which function* is expensive, not just which test is expensive. (Source: https://getfoundry.sh/forge/gas-reports)

### Verbosity levels for traces

| Flag | Shows |
|---|---|
| `-v` | Test pass/fail lines. Default. |
| `-vv` | Logs from `console2.log`. |
| `-vvv` | Stack traces for failing tests. |
| `-vvvv` | Full call traces, including gas used per call. |
| `-vvvvv` | Setup call traces too. |

Read `-vvvv` traces when you want to see which call in a sequence is the expensive one. Don't guess.

## Real optimizations

The list below is roughly ordered by effect size. Measure before and after.

### 1. Struct packing

Before (three slots):

```solidity
struct Position {
    uint256 collateral;
    uint128 lastUpdate;
    address owner;
}
```

After (two slots):

```solidity
struct Position {
    uint128 collateral;       // uint128 is plenty for ETH-scale amounts
    uint128 lastUpdate;       // seconds since epoch, fits in uint64 but uint128 pads to slot
    address owner;            // 20 bytes, slot 1 alongside a uint64 if we had one
}
```

Saves one `SSTORE` per mutation (~20,000 gas on first write, ~2,900 on update).

Rule: adjacent storage variables that together fit in 32 bytes go in the same slot. Put them *next to each other* in the declaration — the compiler does not reorder.

### 2. `calldata` over `memory` for external function array and bytes parameters

```solidity
// External function, caller passes an array. Mark calldata.
function batchTransfer(address[] calldata recipients, uint256[] calldata amounts)
    external
{ ... }
```

`memory` forces a copy from calldata to memory. `calldata` reads directly from calldata. Saves roughly `3 * length` gas plus a chunk of static overhead.

Only use `memory` when you need to mutate the array inside the function.

### 3. Custom errors over require-strings

Custom errors encode as a 4-byte selector; require-strings encode as a length-prefixed string. The selector path saves bytecode (cheaper deploy) and runtime gas when the revert fires (less data to return).

See `solidity-style-modern` for the rule; the gas win is the reason.

### 4. `immutable` over storage reads in hot paths

Immutables are embedded into the bytecode at deploy time. Reading one is a `PUSH`, not an `SLOAD` (2100 gas cold, 100 warm).

```solidity
// DO
address public immutable i_owner;

constructor(address owner_) {
    i_owner = owner_;
}

function adminOnly() external {
    if (msg.sender != i_owner) revert Unauthorized();
    // ...
}

// DON'T
address public s_owner; // storage read every call
```

Saves 2000+ gas per read for anything set once at deploy.

### 5. Cache storage in memory inside a function

If you read the same storage slot more than once in a function, cache it.

```solidity
// DO
function rebalance(uint256 amount) external {
    uint256 bal = s_balance;      // SLOAD once
    if (amount > bal) revert InsufficientBalance();
    uint256 newBal = bal - amount;
    s_balance = newBal;           // SSTORE once
    emit Rebalanced(bal, newBal);
}

// DON'T
function rebalance(uint256 amount) external {
    if (amount > s_balance) revert InsufficientBalance();  // SLOAD 1
    s_balance = s_balance - amount;                        // SLOAD 2, SSTORE 1
    emit Rebalanced(s_balance + amount, s_balance);        // SLOAD 3, SLOAD 4
}
```

The optimizer catches *some* of these, but not across function boundaries or through mappings. Measure.

### 6. Short-circuit ordering

Put the cheap check first.

```solidity
// DO — msg.sender is free, storage read is expensive
if (msg.sender == i_owner && s_balances[tokenId] > 0) { ... }

// DON'T
if (s_balances[tokenId] > 0 && msg.sender == i_owner) { ... } // storage read even when not owner
```

Small win per call; matters on hot paths.

### 7. Avoid `SLOAD` inside loops

```solidity
// DO
uint256 len = s_items.length; // cache once
for (uint256 i; i < len; ++i) { ... }

// DON'T
for (uint256 i; i < s_items.length; ++i) { ... } // SLOAD per iteration
```

Especially painful if `s_items.length` is itself a storage slot (dynamic arrays). Cache.

### 8. Fixed-size arrays when the size is known

`uint256[3]` is cheaper than `uint256[]` for both storage and memory — no length word, no dynamic layout.

## Anti-patterns to reject

### `++i` vs `i++` on solc 0.8.22+

Old cargo cult: rewrite every `for (uint256 i = 0; i < n; i++)` to `++i`. On solc 0.8.22 and later, the compiler already picks the cheaper one. Measure: usually zero difference. Don't make PR noise for zero.

### `unchecked { ++i }` in loops on solc 0.8.22+

Same reasoning. The 0.8.22 compiler auto-unchecks obvious loop counters. Measure before adding the `unchecked` wrapping. If your compiler is older, the pattern still wins — but then upgrade the compiler, that's a bigger win.

### `x * 2` vs `x << 1`

The optimizer does this. Writing `<<` instead of `*` just makes the code harder to read for no measurable gain.

### `x / 2` vs `x >> 1`

Same as above. Do not write bit shifts as a "gas optimization" for multiplication or division by powers of two. Measure — then you'll stop.

### Unmeasured yul

```solidity
// Claimed gas saver; author never ran forge snapshot
assembly {
    let bal := sload(0x0)
    // ...
}
```

Reject until a snapshot diff is shown. Yul locks future maintainers out of the compiler's optimizer improvements. Only worth it when the Solidity version was measured and found wanting.

### "Gas golf" that breaks tests

If an optimization required you to change a test to match new behavior, it is not an optimization — it is a refactor that also changed semantics. Split the PR.

## When gas doesn't matter

Some contracts are deployed once, called by a single bot, or live on L2s where gas costs fractions of a cent. Spending engineer-hours to save 500 gas on a daily-run admin function is negative EV. Know your context:

- L1 mainnet, user-called hot path: optimize.
- L1 mainnet, admin function called monthly: leave it readable.
- L2 (Base, Arbitrum, Optimism): calldata costs matter more than computation. Focus on `calldata` vs `memory` and data size, not `SLOAD` counts (state access on L2 is cheaper relative to L1 calldata).

## The PR template for any gas change

```markdown
### Change
Packed `Position.collateral` and `Position.lastUpdate` into one slot.

### Measurement
Baseline (pre-change .gas-snapshot):
    testOpenPosition() (gas: 142_334)

After change:
    testOpenPosition() (gas: 123_112)

Delta: **-19_222 gas** (-13.5%)

### Risk
None. Storage layout change is additive (same contract, same functions,
new slot assignment). Not upgradeable, so no layout compatibility issue.
Full test suite passes (forge test).
```

Every gas PR has this structure. No exceptions.

## Using `forge test --gas-report` to find hot paths

```bash
forge test --gas-report > gas-report.txt
```

Scan the report for:

- Functions with `max` gas > `avg` gas by 2x — indicates input-dependent branching worth investigating.
- Functions called by many tests with high `avg` — optimization there benefits everyone.
- Functions with one-shot high `min` — look at the constructor and setup paths.

Do not try to optimize every function. Pick the top 3 by *real-world call frequency* (not test frequency).

## Things to do first, before any optimization

If you are chasing gas, these are usually higher-leverage than individual micro-optimizations:

1. **Batch entry points.** Turn one-call-per-item into one-call-for-many when the caller is a keeper or router. Saves per-call overhead (21,000 base gas per tx).
2. **Use events instead of storage for audit-only data.** If the data is read by indexers and not by on-chain logic, emit an event and free the storage slot.
3. **Move rarely-read config to `immutable`** if set at deploy, or to a singleton registry contract if shared across many instances.
4. **Merge small proxies.** Every `delegatecall` hop costs ~700 gas plus the dispatch logic.

## Counter-examples to reject in review

- A PR titled "gas optimization" with no `.gas-snapshot` diff attached.
- A PR that rewrites `i++` to `++i` across 200 lines with no measurement.
- A PR that introduces yul with no comment explaining the measured savings vs the Solidity version.
- A PR that disables a test as "part of the optimization".
- A PR that ships `.gas-snapshot` regressions in unrelated functions without comment.

## References

- Forge gas reports — https://getfoundry.sh/forge/gas-reports
- Forge snapshot — https://getfoundry.sh/forge/gas-snapshots
- Solidity optimizer — https://docs.soliditylang.org/en/latest/internals/optimizer.html
- Layout in storage (packing rules) — https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html

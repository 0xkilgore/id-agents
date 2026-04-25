---
name: writing-foundry-tests
description: Use when writing, modifying, or reviewing Foundry tests. Covers forge-std Test base, setUp, vm cheatcodes (prank, expectRevert by selector, expectEmit, warp/roll, mockCall, recordLogs), fuzz bounds with vm.assume and bound, invariant testing with StdInvariant and handler contracts, and the assertion patterns that make failures debuggable.
license: MIT
version: 0.1.0
tags: [foundry, forge, testing, fuzzing, invariants, solidity]
---

# Writing Foundry Tests

You are writing a Foundry test. Tests are the only thing that stands between your Solidity and a real user's money. Treat every test as a contract that must be read, maintained, and trusted for years.

## The Iron Laws

1. **NO `vm.expectRevert()` BARE.** Always pass the custom-error selector or the encoded error, e.g. `vm.expectRevert(IERC20Errors.ERC20InsufficientBalance.selector)`. A bare `expectRevert()` matches *any* revert, including ones you introduced by accident. That is not a test, it is a placeholder.
2. **NO STRING-BASED REVERT MATCHING.** `vm.expectRevert("Insufficient balance")` is banned for new code. Use custom errors + selector matching. Strings cost gas, break on typos, and silently pass when the revert reason changes.
3. **NO UNBOUNDED FUZZ INPUTS.** Every fuzz parameter gets `bound(x, min, max)` or `vm.assume(condition)`. Unbounded `uint256` inputs waste runs on `type(uint256).max` overflows that prove nothing about your business logic.
4. **NO ASSERT WITHOUT A MESSAGE.** Use `assertEq(a, b, "balance after transfer")`, not `assertEq(a, b)`. When the assert fires in CI six months from now, the message is the only context the failing engineer has.
5. **NO TEST WITHOUT A `test_` OR `testFuzz_` OR `invariant_` PREFIX.** Foundry discovers tests by prefix. A helper named `transferTokens` silently stops being a test. Use `_helperTransferTokens` for helpers — underscore-prefixed private functions.
6. **NO SHARED MUTABLE STATE ACROSS TESTS.** `setUp()` runs before every test. If you rely on state from another test, you have a test bug. Write each test as if it is the only one in the file.

## Test file shape

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MyToken} from "../src/MyToken.sol";

contract MyTokenTest is Test {
    MyToken internal token;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MyToken("Test", "TEST");
        deal(address(token), alice, 100 ether);
    }

    function test_Transfer_MovesBalance() public {
        vm.prank(alice);
        token.transfer(bob, 10 ether);

        assertEq(token.balanceOf(alice), 90 ether, "alice balance after transfer");
        assertEq(token.balanceOf(bob),   10 ether, "bob balance after transfer");
    }
}
```

Conventions:

- One contract per test file, named `<ContractUnderTest>Test`.
- `makeAddr("alice")` over raw hex addresses — the label shows in traces.
- `deal(token, to, amount)` over manual mint calls when you want to set up balances without exercising the mint path.
- `internal` visibility on test helpers (compiler hint) and test state (so subclassed test contracts can reach them).

## The cheatcodes you actually use

### Identity and balance

| Cheatcode | Effect |
|---|---|
| `vm.prank(addr)` | Next call's `msg.sender` is `addr`. One call. |
| `vm.startPrank(addr)` / `vm.stopPrank()` | All calls until stop are from `addr`. |
| `vm.prank(caller, origin)` | Sets both `msg.sender` and `tx.origin`. |
| `makeAddr("label")` | Deterministic address with a human label in traces. |
| `deal(token, to, amount)` | Sets ERC20 balance directly (forge-std helper). |
| `vm.deal(addr, ether)` | Sets native ETH balance. |

### Time and block

| Cheatcode | Effect |
|---|---|
| `vm.warp(ts)` | Sets `block.timestamp`. |
| `vm.roll(blockNum)` | Sets `block.number`. |
| `skip(seconds)` | `vm.warp(block.timestamp + seconds)` (forge-std). |
| `rewind(seconds)` | Mirror of skip. |

### Reverts

Always by selector for custom errors:

```solidity
// Custom error in the contract:
error Unauthorized(address caller);

// In the test:
vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, alice));
vm.prank(alice);
token.adminOnly();
```

For errors with no args, use `SelectorName.selector` directly:

```solidity
vm.expectRevert(MyContract.AlreadyInitialized.selector);
target.initialize();
```

### Events

```solidity
// Declare the event in the test file or import from the contract.
event Transfer(address indexed from, address indexed to, uint256 value);

function test_Transfer_EmitsEvent() public {
    vm.expectEmit(true, true, false, true, address(token));
    emit Transfer(alice, bob, 10 ether);

    vm.prank(alice);
    token.transfer(bob, 10 ether);
}
```

The four bool args are `checkTopic1, checkTopic2, checkTopic3, checkData`. Be explicit. The fifth arg (the emitter) prevents false positives from events emitted by *other* contracts in the same call.

### Mocking external calls

```solidity
vm.mockCall(
    address(oracle),
    abi.encodeWithSelector(IOracle.price.selector),
    abi.encode(uint256(2000e8))
);
```

`vm.mockCallRevert` for the unhappy path. Use mocks sparingly — prefer deploying a real minimal stub. Mocks hide integration drift.

### Recording logs

```solidity
vm.recordLogs();
target.doSomething();
Vm.Log[] memory entries = vm.getRecordedLogs();
assertEq(entries.length, 3, "expected three events");
```

Use when you need to assert about the *count* or *ordering* of events, not just that one fired.

## Fuzz testing

Every public function that takes arguments deserves at least one fuzz test.

```solidity
function testFuzz_Transfer_PreservesTotalSupply(uint256 amount) public {
    amount = bound(amount, 0, token.balanceOf(alice));

    uint256 supplyBefore = token.totalSupply();
    vm.prank(alice);
    token.transfer(bob, amount);

    assertEq(token.totalSupply(), supplyBefore, "supply invariant broken");
}
```

### bound vs vm.assume

**`bound(x, min, max)`** — preferred. Maps the fuzz input into range. Every run is productive.

**`vm.assume(condition)`** — filters the input. Rejected runs count against the reject cap (default 65536). Use only when `bound` cannot express the constraint, e.g. "any address that is not the zero address":

```solidity
vm.assume(user != address(0));
vm.assume(user != address(token));
```

If more than a small fraction of your runs are rejected, rewrite the test with `bound`.

### Fuzz config in foundry.toml

```toml
[fuzz]
runs = 1000
max_test_rejects = 65536
seed = "0x1234"
```

Pin `seed` when you need reproducible CI. Leave it unset (or rotate) during development to explore more inputs. (Source: https://getfoundry.sh/forge/fuzz-testing)

## Invariant testing

Invariants are properties that must hold across *any* sequence of calls. Use them when you care about global state (total supply, conservation of funds, monotonicity).

```solidity
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {MyToken} from "../src/MyToken.sol";
import {TokenHandler} from "./handlers/TokenHandler.sol";

contract MyTokenInvariants is StdInvariant, Test {
    MyToken internal token;
    TokenHandler internal handler;

    function setUp() public {
        token = new MyToken("Test", "TEST");
        handler = new TokenHandler(token);

        targetContract(address(handler));
    }

    function invariant_TotalSupplyEqualsSumOfBalances() public view {
        assertEq(
            token.totalSupply(),
            handler.ghostSumOfBalances(),
            "total supply diverged from sum of balances"
        );
    }
}
```

### The handler pattern

A handler contract restricts the fuzzer to *sensible* actions. Without a handler, the fuzzer generates calls that always revert (e.g. transferring from a zero-balance address), wasting runs.

```solidity
contract TokenHandler is Test {
    MyToken public token;
    address[] public actors;
    uint256 public ghostSumOfBalances;

    constructor(MyToken _token) {
        token = _token;
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
    }

    function transfer(uint256 actorSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[actorSeed % actors.length];
        address to   = actors[toSeed   % actors.length];
        amount = bound(amount, 0, token.balanceOf(from));

        vm.prank(from);
        token.transfer(to, amount);
        // ghost state does not change — transfer is conservative
    }

    function mint(uint256 actorSeed, uint256 amount) external {
        address to = actors[actorSeed % actors.length];
        amount = bound(amount, 0, 1_000_000 ether);

        token.mint(to, amount);
        ghostSumOfBalances += amount;
    }
}
```

Rules for handlers:

- Always `bound` amounts and indices. Unbounded handler calls waste runs on reverts.
- Track "ghost" state separately to compare against on-chain state in the invariant.
- Register with `targetContract(address(handler))` in the test `setUp()`. Otherwise the fuzzer calls the token directly and blows through the reject cap.

### Invariant config

```toml
[invariant]
runs = 256
depth = 15
fail_on_revert = false
```

`fail_on_revert = true` is stricter and usually right once handlers are tight. `depth` controls how many handler calls per run.

## Snapshot and restore

When you want to exercise several branches from the same starting state without re-running `setUp()`:

```solidity
function test_MultipleBranches() public {
    uint256 snap = vm.snapshotState();

    vm.prank(alice);
    token.transfer(bob, 10 ether);
    assertEq(token.balanceOf(bob), 10 ether);

    vm.revertToState(snap);
    assertEq(token.balanceOf(bob), 0, "state reverted");
}
```

(Older codebases use `vm.snapshot()` / `vm.revertTo()` — same semantics, deprecated names.)

## Assertion vocabulary

| Assert | When |
|---|---|
| `assertEq(a, b, "msg")` | Values must be exactly equal. |
| `assertApproxEqAbs(a, b, maxDelta, "msg")` | Within absolute tolerance. Use for math that accumulates rounding. |
| `assertApproxEqRel(a, b, maxPercentDelta, "msg")` | Within relative tolerance (1e18 = 100%). |
| `assertGt/Lt/Ge/Le(a, b, "msg")` | Ordering. |
| `assertTrue(cond, "msg")` | Boolean. |
| `fail("msg")` | Force fail. Useful inside `try/catch`. |

**Rule**: every assert has a message. No exceptions.

## What to test

For any new external/public function, write at least:

1. **The happy path.** Named `test_FnName_DoesThing`.
2. **The auth failure.** `test_FnName_RevertsWhenNotOwner` using `expectRevert(selector)`.
3. **The input validation failure.** `test_FnName_RevertsOnZeroAmount`.
4. **The edge case.** Boundary value (0, max, the transition between two branches).
5. **At least one fuzz test.** `testFuzz_FnName_*` with bounded inputs.
6. **State invariants** if the function touches global accounting. Add to the invariant suite.

If you finish implementation before writing (1)-(5), go back. Untested branches are future bugs.

## Counter-examples (things to reject in review)

```solidity
// WRONG: bare expectRevert
vm.expectRevert();
target.foo();

// WRONG: string match
vm.expectRevert("INSUFFICIENT");
target.transfer(bob, 1000);

// WRONG: fuzz with no bound
function testFuzz_Transfer(uint256 amount) public {
    token.transfer(bob, amount); // reverts on amount > balance, test passes by accident
}

// WRONG: assert without message
assertEq(token.balanceOf(alice), 90 ether);

// WRONG: setUp depending on test order
function test_A_CreatesAccount() public { state.create(alice); }
function test_B_UsesAccount() public { state.use(alice); } // fails in isolation
```

## References

- Forge testing — https://getfoundry.sh/forge/writing-tests
- Fuzz testing — https://getfoundry.sh/forge/fuzz-testing
- Cheatcodes reference — https://getfoundry.sh/forge/cheatcodes
- forge-std — https://github.com/foundry-rs/forge-std

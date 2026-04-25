---
name: using-foundry
description: Use when starting, configuring, or doing day-to-day work in a Foundry project. Covers forge init, build, test, fmt, project layout, remappings, foundry.toml, and dependency management with forge install / soldeer / git submodules. Load before any other Foundry skill when the project is unfamiliar.
license: MIT
version: 0.1.0
tags: [foundry, forge, solidity, project-setup, tooling]
---

# Using Foundry

You are working on a Foundry project. Foundry is the toolchain (`forge`, `cast`, `anvil`, `chisel`) that compiles, tests, and deploys Solidity. This skill encodes the project-hygiene defaults you must follow on every session.

## The Iron Laws

1. **NO COMMIT WITHOUT `forge fmt --check` AND `forge build` CLEAN.** If either fails, fix before committing. Do not commit "just the tests" or "just the config" to work around a formatter or compiler error.
2. **NO `forge test` WITHOUT `-vvv` ON FAILURE.** If a test fails at default verbosity, re-run the *same* test with `-vvv` (or `-vvvv` for opcode traces) before you start guessing. The trace is the diagnosis.
3. **NO NEW DEPENDENCY WITHOUT PINNING.** `forge install` a dependency, then record the exact tag or commit in the install command (`forge install OpenZeppelin/openzeppelin-contracts@v5.0.2`). Never install from `master`/`main` for production work.
4. **NO EDITING `remappings.txt` OR `foundry.toml` WITHOUT A REASON STATED IN THE COMMIT MESSAGE.** These files control the entire toolchain. A silent change here breaks every contributor.
5. **NEVER DELETE `lib/` OR `out/` TO "FIX" A BUILD.** If `forge build` fails, read the error. `forge clean` is the escape hatch, not `rm -rf lib`.

## Project layout

Standard Foundry layout, produced by `forge init <name>`:

```
my-project/
├── foundry.toml          # toolchain config
├── remappings.txt        # optional, overrides auto-remappings
├── .gitignore            # must include out/, cache/, broadcast/
├── src/                  # production contracts
├── test/                 # *.t.sol test files
├── script/               # *.s.sol deploy + ops scripts
└── lib/                  # forge-std and other git-submodule deps
```

Do not rename these directories. `foundry.toml` can redirect them, but every Foundry-literate engineer expects `src/` / `test/` / `script/` / `lib/`. Surprising layouts cost onboarding time.

## First-contact workflow

When you open a Foundry project you have never seen before, run in this order:

1. `cat foundry.toml` — read the profile, Solidity version, EVM version, remappings, fuzz runs.
2. `cat remappings.txt` (if it exists) — understand how imports resolve.
3. `ls lib/` — see which dependencies are vendored.
4. `forge build` — confirm the project compiles as-is before you touch anything.
5. `forge test --fail-fast` — confirm tests pass as-is.

If step 4 or 5 fails on a clean checkout, **stop and report to the user**. Do not try to "fix" a broken baseline. You cannot tell which failures are new versus pre-existing.

## foundry.toml essentials

Pin three things at minimum:

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
via_ir = false

[fmt]
line_length = 120
tab_width = 4
bracket_spacing = true
int_types = "long"

[fuzz]
runs = 256

[invariant]
runs = 256
depth = 15
```

**Rule**: `solc_version` is pinned, not floating. `solc = "^0.8.20"` is wrong for a `foundry.toml`. Use an exact version so every contributor and CI run compiles with the same compiler. (Source: https://book.getfoundry.sh/config/)

## Remappings

Foundry auto-derives remappings from `lib/`. You only need `remappings.txt` when you want to override them — usually to flatten OpenZeppelin's deep path or to alias a fork.

DO:
```
@openzeppelin/=lib/openzeppelin-contracts/
forge-std/=lib/forge-std/src/
solady/=lib/solady/src/
```

DON'T:
```
# Rely on implicit remappings and then wonder why an import fails
# in one tool (forge) but works in another (hardhat).
```

If you edit `remappings.txt`, also run `forge remappings > remappings.txt` once to see what Foundry derives today, and then decide which to override.

## Dependency management

Three options. In order of preference for a new project:

### Option A: `forge install` + git submodules (default)

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2
forge install transmissions11/solmate@v7
```

- Installs as a git submodule under `lib/`.
- Pros: canonical, zero extra tooling, the Foundry Book assumes this.
- Cons: git submodules are clunky. Collaborators must run `git submodule update --init --recursive`.

### Option B: Soldeer (`forge soldeer`)

```bash
forge soldeer install @openzeppelin-contracts~5.0.2
```

- Installs into `dependencies/` with a lockfile in `soldeer.lock`.
- Pros: real package manager, reproducible, no submodule headaches.
- Cons: younger ecosystem, some libraries still publish only to GitHub.

### Option C: npm / pnpm

Only if the project also ships a JS SDK in the same monorepo. Otherwise don't mix.

**Rule**: pick one per project. Do not mix `lib/` submodules and `dependencies/` soldeer in the same repo without a comment in the README explaining why.

## The forge CLI commands you use every day

| Command | When | Key flags |
|---|---|---|
| `forge init` | Once per project | `--no-commit` if you'll init git yourself |
| `forge build` | Every code change | `--force` to bypass cache when suspicious |
| `forge test` | Every change | `-vvv` on failure, `--match-test`, `--match-contract`, `--fail-fast` during iteration |
| `forge fmt` | Before commit | `--check` in CI, no flag locally |
| `forge snapshot` | Gas work | See `gas-optimization-foundry` |
| `forge coverage` | Coverage gates | `--ir-minimum` to avoid "stack too deep" |
| `forge clean` | Cache-smell only | nuclear option, rarely needed |
| `forge remappings` | Debugging imports | Prints the resolved map |
| `forge install` | Adding a dep | Pin a tag: `@v5.0.2` |
| `forge update` | Upgrading a dep | Review the diff in `lib/` before committing |

## Test iteration loop

The fastest inner loop:

```bash
forge test --match-contract MyContractTest --match-test test_transfers -vvv --fail-fast
```

- `--match-contract` scopes by test file class name.
- `--match-test` scopes by test function.
- `-vvv` shows reverts and event traces.
- `--fail-fast` stops at the first failure so you are not scrolling through a thousand unrelated failures.

Once the one test passes, re-run the full suite without `--fail-fast` to catch regressions.

## Formatting

`forge fmt` is the one true formatter. Configure in `foundry.toml` once and never hand-format again.

DO:
```bash
forge fmt              # local, applies
forge fmt --check      # CI, non-zero exit on diff
```

DON'T:
- Run `prettier-plugin-solidity` in the same repo unless you want fighting formatters.
- Disable `forge fmt` per-file with comments just to keep "your style". The team style is the style.

## Commit hygiene

Before every commit:

1. `forge fmt --check` — non-zero exit means unformatted files. Fix with `forge fmt`, then re-check.
2. `forge build` — non-zero exit means you broke the build. Fix first.
3. `forge test` — non-zero exit means you broke a test. Fix first.

If you are tempted to skip any of these: you are wrong. The CI will catch it in three minutes and you will waste fifteen.

## What NOT to commit

Your `.gitignore` MUST include:

```
out/
cache/
broadcast/
.env
.DS_Store
```

- `out/` and `cache/` are build artifacts. Huge, regenerated every build.
- `broadcast/` contains deploy logs with tx hashes — useful locally, noise in git. Commit *selected* `broadcast/*/run-latest.json` only if you are deliberately archiving a deploy record. Never commit all of `broadcast/`.
- `.env` contains private keys. **Never.** See `foundry-scripting-and-deploy`.

## Common failure modes

**"Stack too deep"** during build. Enable `via_ir = true` in `foundry.toml`, or refactor the function to use fewer local variables.

**"Compiler version mismatch"** when you added a dep. Read the dep's own pragma. Either bump your `solc_version` or pin the dep to an older tag.

**"Remapping not found"** for a dep you installed. Run `forge remappings` to see what Foundry resolves; then compare to your import paths. Fix the import or add the remapping.

**Tests pass locally, fail in CI.** Check `foundry.toml` for a fuzz `seed`. Without a pinned seed, fuzz tests draw fresh inputs every run and can reveal bugs CI catches that you don't. That is a feature, not a flake — write a regression test for the failing input.

**Suddenly every test reverts.** You likely added `setUp()` state that one test mutated. `setUp()` runs once per test; state does not carry. If your test depends on state from another test, you have a test design bug, not a Foundry bug.

## When to break these rules

Only three cases:

1. **Experimental branch clearly marked `wip/*`.** You can skip fmt and tests while spiking. You may not merge to `main` without green.
2. **One-off scripts in `script/`** that talk to a real RPC. You still `forge build` them, but they may legitimately be unfinished during a session.
3. **A failing test you are *investigating* under `systematic-debugging`.** The rule is "don't commit with red tests", not "don't ever have red tests locally".

In every other case, the rules hold. If you find yourself about to violate one, state out loud why and get explicit user approval.

## References

- Foundry Book — https://book.getfoundry.sh/
- Forge reference — https://getfoundry.sh/forge/overview
- foundry.toml config — https://getfoundry.sh/config/
- Soldeer — https://soldeer.xyz/

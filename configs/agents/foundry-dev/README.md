# foundry-dev

Opinionated Foundry / Solidity developer agent for day-to-day contract work. Claude-native shape (`CLAUDE.md` inside this folder).

## Shape

Claude-native. The `CLAUDE.md` in this directory is the persona and loads as the agent's primary memory on deploy.

## Bundled content

The agent ships the full Foundry skill pack inline under `skills/`:

- `using-foundry`
- `writing-foundry-tests`
- `solidity-style-modern`
- `foundry-scripting-and-deploy`
- `gas-optimization-foundry`

A team config referencing `agent: foundry-dev` picks these up automatically during Step A of sync, no `skills:` overlay needed.

## Non-scope

- Smart-contract auditing. Use the Trail of Bits security pack.
- Non-Foundry frameworks (Hardhat, Truffle). Not supported; don't mix.

## License

MIT. See repository root `LICENSE` once added.

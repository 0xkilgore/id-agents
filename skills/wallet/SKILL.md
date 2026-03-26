---
name: wallet
description: Show your OWS wallet addresses across all chains. Use when asked about your wallet, address, or funds.
allowed-tools: Bash
---

# Wallet

You have an OWS (Open Wallet Standard) wallet. Your wallet name is in the `OWS_WALLET` environment variable.

## View your addresses

```bash
ows wallet list 2>/dev/null | awk "/Name:.*$OWS_WALLET/{found=1} found && /Name:/ && !/Name:.*$OWS_WALLET/{exit} found"
```

## Chains supported

| Chain | Format |
|-------|--------|
| Ethereum/EVM | 0x... (works on Base, Optimism, Arbitrum, etc.) |
| Bitcoin | bc1... |
| Cosmos | cosmos1... |
| Tron | T... |
| TON | UQ... |
| Filecoin | f1... |
| Sui | 0x... (64 bytes) |

When asked for your wallet address, run the command above and report the relevant chain address.

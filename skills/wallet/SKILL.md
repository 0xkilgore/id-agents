---
name: wallet
description: "OWS wallet — view addresses, sign transactions/messages, check balances, manage agent access. Use when asked about your wallet, address, funds, signing, or any onchain operation."
allowed-tools: Bash
---

# Wallet

You have an OWS (Open Wallet Standard) wallet. Your wallet name is in the `OWS_WALLET` environment variable. The private key is encrypted in the vault at `~/.ows/` — you never see or handle raw keys.

## View your addresses

```bash
ows wallet list 2>/dev/null | awk "/Name:.*$OWS_WALLET/{found=1} found && /Name:/ && !/Name:.*$OWS_WALLET/{exit} found"
```

## Supported chains

| Chain | CAIP-2 | Format |
|-------|--------|--------|
| Ethereum/EVM | eip155:1 | 0x... (works on Base, Optimism, Arbitrum, etc.) |
| Bitcoin | bip122:... | bc1... |
| Cosmos | cosmos:cosmoshub-4 | cosmos1... |
| Tron | tron:mainnet | T... |
| TON | ton:mainnet | UQ... |
| Filecoin | fil:mainnet | f1... |
| Sui | sui:mainnet | 0x... (64 bytes) |
| Solana | solana:... | base58 |

Your EVM address works across all EVM chains (Ethereum, Base, Optimism, Arbitrum, etc.).

## Sign a message

```bash
ows sign message --wallet $OWS_WALLET --chain eip155:1 --message "hello world"
```

## Sign a transaction

```bash
# Sign only (returns signed tx hex)
ows sign tx --wallet $OWS_WALLET --chain eip155:11155111 --tx 0x02f8...

# Sign and broadcast (returns tx hash)
ows sign send-tx --wallet $OWS_WALLET --chain eip155:11155111 --tx 0x02f8...
```

## Sign EIP-712 typed data (permits, gasless approvals)

```bash
ows sign message --wallet $OWS_WALLET --chain eip155:1 --message dummy \
  --typed-data '{"types":{...},"primaryType":"Permit","domain":{...},"message":{...}}' --json
```

## Check balance

```bash
ows fund balance --wallet $OWS_WALLET --chain base
```

## Security rules

1. **Never log or print private keys or mnemonics.** OWS handles encryption.
2. **Use `$OWS_WALLET` for all signing operations** — never hardcode wallet names.
3. **Check balance before transacting** — verify funds exist on the target chain.
4. **Audit log** exists at `~/.ows/logs/audit.jsonl` — every signing operation is recorded.

When asked for your wallet address, run the list command and report the relevant chain address.

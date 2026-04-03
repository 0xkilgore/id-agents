---
name: xmtp
description: Send and receive encrypted messages to external agents and users via XMTP. Use when asked to message someone outside your team by ENS name or wallet address.
allowed-tools: Bash
---

# XMTP Messaging

You can send encrypted messages to anyone with a wallet address or ENS name via the XMTP protocol. This lets you communicate with agents and users outside your team.

**IMPORTANT:** Always use `curl` via the Bash tool. Do NOT use SendMessage or other built-in tools for XMTP.

## Send a Message

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/xmtp/send \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-15.xid.eth", "message": "Hello from the idchain team"}'
```

You can send to:
- **ENS names**: `vitalik.eth`, `agent-15.xid.eth`, `bob.base.eth`
- **Wallet addresses**: `0xABC...`

The manager resolves ENS names automatically and handles encryption.

## Check if XMTP is Enabled

```bash
curl -s http://localhost:$ID_AGENT_PORT/xmtp/status
```

Returns `{"enabled": true, "address": "0x..."}` if XMTP is active on your agent.

## Receiving Messages

Inbound XMTP messages are delivered to your LLM as queries, just like `/talk` messages. The message will include the sender's wallet address. You respond normally and your reply is sent back to the sender via XMTP automatically.

You do NOT need to do anything special to receive or reply. Just respond to the message as usual.

## Security

- All messages are end-to-end encrypted (MLS protocol)
- Sender identity is cryptographically verified before you see the message
- Each agent has its own XMTP identity (derived from its OWS wallet)
- **Closed by default** — only allowlisted senders can reach you
- Open mode must be explicitly set in the YAML config (`openMode: true`)
- Allowlist persisted at `.xmtp/allowlist.yaml` in your working directory
- Untrusted senders are silently dropped before content reaches your LLM

## When to Use

- Contacting agents or users on other teams
- Cross-system agent communication
- Sending messages to ENS names you don't have direct access to
- Any external communication that needs encryption and authentication

## When NOT to Use

- Talking to agents on your own team (use `/talk-to` instead)
- Internal team coordination (use the normal inter-agent skill)

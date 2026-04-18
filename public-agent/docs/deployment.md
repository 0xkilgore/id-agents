# public-agent Deployment

## Overview

public-agent runs on a VPS behind TLS. The `/talk` endpoint is public — any
caller can reach it subject to IP rate limiting and daily token budget. Operator
endpoints (`/inbox`, `/news`, `/mcp`) bind to `127.0.0.1` and are accessed only
via SSH tunnel; they are not exposed through the reverse proxy. Authentication is
enforced by `PUBLIC_AGENT_AUTH_KEY`; without it, operator endpoints reject every
request unless `ALLOW_PUBLIC_UNAUTHENTICATED=true` is set (dev only).

## Prerequisites

- Node 22 or later on the VPS.
- A domain with DNS A / AAAA records pointing to the VPS.
- An OpenRouter API key (`platform.openrouter.ai`).
- (Optional) A bearer key for operator endpoint auth — generate with
  `openssl rand -hex 32`.

## Environment file

Place a file at `/etc/public-agent.env`. The `systemd` unit reads it via
`EnvironmentFile=`. File format: one `KEY=value` per line, no quoting needed.

### Required

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter bearer key. Required. |
| `OPENROUTER_MODEL` | Model identifier, e.g. `openai/gpt-4o-mini`. Required. |

### Operator security

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_AGENT_AUTH_KEY` | (none) | Bearer token for `/inbox`, `/news`, `/mcp`. If unset, those endpoints return 401 unless the dev flag below is set. |
| `ALLOW_PUBLIC_UNAUTHENTICATED` | `false` | Set `true` only in local development to open operator endpoints without a key. Never set in production. |

### Budgets and deadlines

| Variable | Default | Purpose |
|---|---|---|
| `MAX_TOKENS_PER_DAY` | `0` (unlimited) | Hard daily token ceiling across all calls. |
| `MAX_REPLY_TOKENS` | `1024` | Maximum completion tokens per main-LLM call. |
| `UPSTREAM_DEADLINE_MS` | `45000` | Per-attempt AbortController deadline for OpenRouter fetches. |
| `MAX_RETRY_AFTER_MS` | `10000` | Maximum ms honoured from a provider `Retry-After` header. |
| `REQUEST_DEADLINE_MS` | `60000` | Total wall-clock deadline per `/talk` request. Exceeded requests return 503. |

### Limits

| Variable | Default | Purpose |
|---|---|---|
| `MAX_MESSAGE_CHARS` | `8000` | Maximum characters in a single user message. |
| `TALK_RATE_LIMIT_PER_MIN` | `10` | Token-bucket rate per IP per minute on `/talk`. |
| `MAX_SESSIONS` | `100` | Maximum concurrent in-memory sessions. |
| `SESSION_IDLE_MINUTES` | `60` | Evict sessions idle for this many minutes. |
| `MAX_TURNS_PER_SESSION` | `50` | Maximum user turns per session before forcing a new one. |

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_AGENT_DATA_DIR` | `/app/data` | Directory for inbox entries, budget state, session artifacts. |
| `PUBLIC_AGENT_KNOWLEDGE_DIR` | `/app/knowledge` | Directory for Markdown knowledge files served to the model. |

### Sample `/etc/public-agent.env`

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
PUBLIC_AGENT_AUTH_KEY=change-this-to-a-random-value

MAX_TOKENS_PER_DAY=500000
MAX_REPLY_TOKENS=1024
UPSTREAM_DEADLINE_MS=45000
MAX_RETRY_AFTER_MS=10000
REQUEST_DEADLINE_MS=60000

TALK_RATE_LIMIT_PER_MIN=10
MAX_SESSIONS=100
SESSION_IDLE_MINUTES=60
MAX_TURNS_PER_SESSION=50
MAX_MESSAGE_CHARS=8000

PUBLIC_AGENT_DATA_DIR=/opt/public-agent/data
PUBLIC_AGENT_KNOWLEDGE_DIR=/opt/public-agent/knowledge
```

## systemd unit

Save as `/etc/systemd/system/public-agent.service`, then `systemctl daemon-reload`
and `systemctl enable --now public-agent`.

```ini
[Unit]
Description=public-agent — DMZ AI assistant
After=network-online.target
Wants=network-online.target

[Service]
# Read secrets from the env file; never inline them in this unit.
EnvironmentFile=/etc/public-agent.env

WorkingDirectory=/opt/public-agent
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5

# Security hardening directives
# Run as an ephemeral user with no home dir or persistent UID.
DynamicUser=yes
# Mount /usr, /boot, /etc read-only; prevent writing outside allowed paths.
ProtectSystem=strict
# Allow only the two data directories the service actually writes to.
ReadWritePaths=/opt/public-agent/data /opt/public-agent/knowledge
# Prevent the process from gaining new privileges via setuid/setgid.
NoNewPrivileges=true
# Restrict outbound sockets to IPv4/IPv6 only; no Unix sockets or raw packets.
RestrictAddressFamilies=AF_INET AF_INET6
# Block kernel calls not needed by a Node.js HTTP service.
SystemCallFilter=@system-service
# Prevent access to physical device files.
PrivateDevices=yes
# Separate /tmp namespace so the process cannot read other services' temp files.
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Hardening notes:

- `DynamicUser=yes` — systemd allocates a throw-away UID per invocation; no
  home directory, no /etc/passwd entry. Files written under `ReadWritePaths` are
  owned by the dynamic UID and survive restarts.
- `ProtectSystem=strict` — the entire filesystem tree is read-only except paths
  in `ReadWritePaths`. Prevents accidental writes outside designated dirs.
- `ReadWritePaths` — limits writable scope to the data and knowledge directories.
  Add additional paths only when a new feature genuinely requires them.
- `NoNewPrivileges=true` — blocks execve-based privilege escalation.
- `RestrictAddressFamilies` — blocks Unix socket and raw-packet egress; Node
  only needs TCP/UDP for HTTP and DNS.
- `SystemCallFilter=@system-service` — whitelists the syscall set appropriate for
  a daemon; blocks ptrace, module loading, clock setting, etc.
- `PrivateDevices=yes` — hides `/dev/sd*`, `/dev/mem`, etc. from the process.
- `PrivateTmp=yes` — gives the process an isolated `/tmp` namespace.

## Reverse proxy

The reverse proxy terminates TLS and forwards only the public surface. Operator
endpoints (`/inbox`, `/news`, `/mcp`) are NOT proxied — operators reach them via
SSH tunnel to `127.0.0.1:4200`.

### Caddy

```
your.domain {
    # TLS is automatic via Let's Encrypt.

    # Public surface — forward to public-agent.
    reverse_proxy /talk 127.0.0.1:4200
    reverse_proxy /healthz 127.0.0.1:4200
    reverse_proxy /.well-known/* 127.0.0.1:4200

    # Operator endpoints are NOT exposed here. Access them via SSH tunnel:
    #   ssh -L 4200:127.0.0.1:4200 user@vps
    # Then curl http://localhost:4200/inbox
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    # Pass real client IP so the rate limiter can use it.
    set_real_ip_from  127.0.0.1;
    real_ip_header    X-Forwarded-For;
    real_ip_recursive on;

    # Public surface.
    location /talk {
        proxy_pass http://127.0.0.1:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:4200;
    }

    location /.well-known/ {
        proxy_pass http://127.0.0.1:4200;
    }

    # Operator endpoints (/inbox, /news, /mcp) are not proxied.
    # Access via SSH tunnel only:
    #   ssh -L 4200:127.0.0.1:4200 user@vps
}

server {
    listen 80;
    server_name your.domain;
    return 301 https://$host$request_uri;
}
```

Set `TRUSTED_PROXY=true` in the env file when using either proxy so the agent
reads the real client IP from `X-Forwarded-For` for rate limiting.

## Key rotation

### PUBLIC_AGENT_AUTH_KEY

1. Generate a new value: `openssl rand -hex 32`.
2. Update `/etc/public-agent.env`.
3. `systemctl restart public-agent`.
4. Distribute the new key to any tools or scripts that use the operator endpoints.

Rotate quarterly or immediately on suspected compromise.

### OPENROUTER_API_KEY

1. Generate a new key in the OpenRouter dashboard.
2. Update `/etc/public-agent.env`.
3. `systemctl restart public-agent`.
4. Revoke the old key in the OpenRouter dashboard.

### Registrar / on-chain key

The registrar key used for Phase 4 on-chain identity is a separate concern.
See the main id-agents documentation — it is not managed by this service.

## Incident disable runbook

**Immediate — stop the service:**

```bash
systemctl stop public-agent
```

Takes effect within seconds. All in-flight requests are dropped.

**Deregister from the manager:**

In the id-agents CLI on your local machine:

```
/public remove your.domain
```

This removes the manager registry entry. The on-chain record is preserved per
Phase 4 Q4 provenance policy — do not attempt to burn the token.

**If the service must stay up but abuse is ongoing:**

1. Rotate `PUBLIC_AGENT_AUTH_KEY` (see above) to invalidate any operator sessions.
2. Clear active user sessions: stop the service, remove
   `$PUBLIC_AGENT_DATA_DIR/sessions.json` if it exists, restart.
3. Tighten rate limiting: set `TALK_RATE_LIMIT_PER_MIN=1` in the env file.
4. `systemctl restart public-agent`.

## Logs and rotation

Logs go to the systemd journal by default:

```bash
journalctl -u public-agent -f          # tail live
journalctl -u public-agent --since today
```

**File-based logging** — add to the `[Service]` section of the unit file:

```ini
StandardOutput=append:/var/log/public-agent/agent.log
StandardError=append:/var/log/public-agent/agent.log
```

Create the directory first and set ownership:

```bash
mkdir -p /var/log/public-agent
# DynamicUser means the UID is ephemeral; use group-based access or
# pre-create with world-writable for simplicity in dev setups.
chmod 755 /var/log/public-agent
```

**logrotate** — save as `/etc/logrotate.d/public-agent`:

```
/var/log/public-agent/agent.log {
    size 100M
    rotate 7
    compress
    missingok
    copytruncate
    notifempty
}
```

`copytruncate` truncates the live file rather than moving it, so the running
process keeps writing without needing a signal or restart.

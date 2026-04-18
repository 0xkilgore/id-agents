# Public Team Bootstrap

This guide walks through deploying a public-agent on a VPS and registering it with your local manager.

## 1. Deploy the public-agent on a VPS

Clone the repo and build the public-agent service (see `docs/deployment/` for server-specific instructions). Install a systemd unit so it restarts automatically:

```ini
[Unit]
Description=Public Agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/public-agent
EnvironmentFile=/etc/public-agent.env
ExecStart=/usr/bin/node bin/public-agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The service must publish a `.well-known/restap.json` at the public domain root (e.g., `https://docs.customer.com/.well-known/restap.json`) and bind operator endpoints to `127.0.0.1:<internal-port>`.

## 2. Open an SSH tunnel to the operator endpoints

Operator endpoints (`/stats`, `/inbox`, `/news`) listen on `127.0.0.1:<internal-port>` on the VPS. Expose them locally:

```bash
ssh -L <internal-port>:127.0.0.1:<internal-port> user@vps
```

Keep this session open while you work with the operator endpoints.

## 3. Register the agent

Inside the interactive CLI (`npm run id-agents`):

```
/public add docs.customer.com --ssh-target=user@vps --internal-port=3100
```

The CLI fetches `https://docs.customer.com/.well-known/restap.json`, validates it, and registers the agent in the `public` team. On success you will see:

```
Registered docs.customer.com as public-agent/docs-customer-com
```

## 4. List registered public agents

```
/public list
```

```
  #   name                        domain                         status        public_url
  1   docs-customer-com           docs.customer.com              registered    https://docs.customer.com
```

## 5. Chat with the agent

```
/public 1 Hello, what can you help me with?
```

Or by domain:

```
/public docs.customer.com What are the latest docs?
```

The CLI resolves the `endpoints.talk` URL from the well-known document and POSTs a single message.

## 6. Deregister the agent

```
/public remove docs.customer.com
```

Type `yes` to confirm. This removes the manager registry entry only — the on-chain identity and the VPS service are unaffected.

To remove all public agents at once:

```
/public clear
```

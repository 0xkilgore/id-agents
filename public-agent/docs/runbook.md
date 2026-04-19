# Public Agent — Operator Runbook

Day-to-day operations reference for the `public-agent` service running on the VPS.

---

## Suspend a Customer

Remove the customer's registered agent from the manager, then stop the service if needed.

```bash
# From the CLI on the manager host (or via SSH tunnel — see Operator Endpoints below)
/public remove <customer_domain>

# To take the entire service offline (affects all customers on this instance):
ssh root@<vps-ip>
systemctl stop public-agent
```

The on-chain registration record stays intact. The agent can be re-registered later
with `/public register-onchain <name>`.

---

## Rotate `PUBLIC_AGENT_AUTH_KEY`

The auth key protects operator-plane endpoints (`/inbox`, `/news`, `/mcp`).
End-user `/talk` is public unless the customer adds their own layer.

```bash
ssh root@<vps-ip>
# Edit the service environment file
nano /etc/public-agent/env          # or wherever your env file lives

# Change PUBLIC_AGENT_AUTH_KEY to a new random value, e.g.:
PUBLIC_AGENT_AUTH_KEY=$(openssl rand -hex 32)

# Restart to pick up the new key
systemctl restart public-agent
```

---

## Rotate `OPENROUTER_API_KEY`

```bash
ssh root@<vps-ip>
nano /etc/public-agent/env

# Update OPENROUTER_API_KEY
systemctl restart public-agent
```

---

## Rebuild the KB

The knowledge base is loaded from `PUBLIC_AGENT_KNOWLEDGE_DIR` at boot.
To deploy updated KB files:

```bash
# Sync new KB files from your local machine
rsync -av ./knowledge/ root@<vps-ip>:/app/knowledge/

# Restart the service so it re-loads the manifest
ssh root@<vps-ip> systemctl restart public-agent
```

---

## Re-register On-chain Metadata

Use the `--force` flag to re-sign and re-deliver `identity.json` even if the
agent is already registered on-chain.

```bash
# From the manager CLI
/public register-onchain <agent_name> --force
```

This re-signs the identity payload with the OWS wallet and re-scps it to the
agent's `ssh_target` path. Useful after rotating keys or changing metadata.

---

## Incident Disable (Fast Path)

For an immediate service pause without removing the registration:

```bash
ssh root@<vps-ip>
# Set MAINTENANCE=true in the env file
echo 'MAINTENANCE=true' >> /etc/public-agent/env
systemctl restart public-agent
```

With `MAINTENANCE=true`:
- `POST /talk` returns `503 {error: "maintenance", message: "..."}` immediately
- `GET /healthz` and `GET /.well-known/restap.json` continue to respond normally
  (probes and service-discovery remain operational during maintenance)

To re-enable:

```bash
# Remove or set MAINTENANCE=false, then restart
sed -i '/^MAINTENANCE=/d' /etc/public-agent/env
systemctl restart public-agent
```

---

## Log Locations

| Source | Path |
|--------|------|
| systemd journal | `journalctl -u public-agent -f` |
| Tool output artifacts | `/app/data/artifacts/` |
| Inbox escalations | `/app/data/inbox/` |

Artifacts are auto-purged on boot (files older than 30 days are removed).
Inbox entries persist until archived via `POST /inbox/:id/archive`.

---

## Operator Endpoints

Operator endpoints (`/inbox`, `/news`, `/mcp`) are bound only to `127.0.0.1`
inside the container and are NOT exposed through the public reverse proxy.

Reach them via an SSH tunnel:

```bash
# Open tunnel: local port 4200 → agent port 4200 on VPS
ssh -L 4200:127.0.0.1:4200 root@<vps-ip> -N &

# Now call operator endpoints locally
curl -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" \
     http://127.0.0.1:4200/inbox

# Archive a reviewed entry
curl -X POST \
     -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" \
     http://127.0.0.1:4200/inbox/<inbox_id>/archive
```

The SSH tunnel approach means operator access requires SSH key authentication
at all times — no bearer token alone can reach these endpoints from the internet.

#!/bin/sh
# Entrypoint for public-agent container.
#
# Runs as root (required to install iptables rules), locks egress down to
# loopback + established/related + DNS + HTTPS to resolved openrouter.ai
# IPs, then drops to the `node` user before exec'ing the real command.
#
# Required container capabilities:  cap_add: [NET_ADMIN]
# Required security options:        security_opt: [no-new-privileges:true]
#
# Env knobs:
#   OPENROUTER_HOST    hostname to allow TCP/443 egress to (default openrouter.ai)
#   SKIP_EGRESS_LOCK   set to "1" to bypass iptables (local dev in a sandbox)

set -eu

OPENROUTER_HOST="${OPENROUTER_HOST:-openrouter.ai}"

lock_egress() {
  # If NET_ADMIN isn't granted, iptables commands will fail — refuse to boot
  # rather than run wide-open. Operators can set SKIP_EGRESS_LOCK=1 for dev.
  if ! iptables -L OUTPUT -n >/dev/null 2>&1; then
    echo "[entrypoint] iptables unavailable. Refusing to start without egress lockdown." >&2
    echo "[entrypoint] Ensure cap_add: [NET_ADMIN] is set, or pass SKIP_EGRESS_LOCK=1 for local dev." >&2
    exit 1
  fi

  echo "[entrypoint] Resolving ${OPENROUTER_HOST} for egress allow-list..."
  # dig returns one IP per line. Keep only IPv4 for v1; IPv6 can come later.
  IPS="$(dig +short "${OPENROUTER_HOST}" A | awk '/^[0-9.]+$/{print}' || true)"
  if [ -z "${IPS}" ]; then
    echo "[entrypoint] Failed to resolve ${OPENROUTER_HOST}. Refusing to start." >&2
    exit 1
  fi
  echo "[entrypoint] ${OPENROUTER_HOST} -> ${IPS}"

  # Flush any existing OUTPUT rules so re-running the entrypoint is idempotent.
  iptables -F OUTPUT
  iptables -P OUTPUT DROP

  # Loopback (internal HTTP between MCP handler and /talk route, Node IPC).
  iptables -A OUTPUT -o lo -j ACCEPT
  # Return traffic on existing connections.
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # DNS. Docker's embedded resolver lives at 127.0.0.11:53 (already covered by lo),
  # but allow outbound 53 to any resolver so non-docker daemons (Podman, etc.) work.
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

  # TCP 443 only to resolved openrouter.ai IPs.
  for ip in ${IPS}; do
    iptables -A OUTPUT -p tcp -d "${ip}" --dport 443 -j ACCEPT
  done

  echo "[entrypoint] Egress rules installed:"
  iptables -L OUTPUT -n --line-numbers
}

if [ "${SKIP_EGRESS_LOCK:-0}" = "1" ]; then
  echo "[entrypoint] SKIP_EGRESS_LOCK=1 — skipping iptables setup. Do NOT use in production." >&2
else
  lock_egress
fi

# Drop privileges and exec the real command.
exec su-exec node:node "$@"

#!/bin/bash
# Detect which AI coding CLIs are installed and authenticated on this host
# and tell the caller what to do with configs/default.yaml before deploying.
#
# Output: one action word on the first line of stdout, then optional details.
#
#   append-researcher   claude + codex both ready.
#                       Append the yaml block that follows to the agents: list
#                       in configs/default.yaml. Final team: coder + researcher.
#   as-is               claude ready, codex not ready.
#                       No file edit. Deploy configs/default.yaml unchanged.
#   switch-to-codex     codex ready, claude not ready.
#                       Change `runtime: claude-code-cli` to `runtime: codex`
#                       under `defaults:` in configs/default.yaml.
#   abort               neither ready.
#                       Install + login to at least one CLI before deploying.
#
# Exit code: 0 when ready to deploy after applying the action, 1 for abort.

set -u

check_claude() {
  command -v claude >/dev/null 2>&1 || return 1
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -f "$HOME/.claude/.credentials.json" ] && return 0
  if [ "$(uname)" = "Darwin" ]; then
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  fi
  return 1
}

check_codex() {
  command -v codex >/dev/null 2>&1 || return 1
  [ -n "${OPENAI_API_KEY:-}" ] && return 0
  [ -f "$HOME/.codex/auth.json" ] && return 0
  return 1
}

claude_ready=false
codex_ready=false
check_claude && claude_ready=true
check_codex && codex_ready=true

if $claude_ready && $codex_ready; then
  cat <<'EOF'
append-researcher
  - name: researcher
    description: "Research, analysis, and documentation"
    runtime: codex
EOF
  exit 0
fi

if $claude_ready; then
  echo "as-is"
  exit 0
fi

if $codex_ready; then
  echo "switch-to-codex"
  exit 0
fi

echo "abort"
echo "Install and log in to at least one of Claude Code (claude login) or Codex (codex login) before deploying."
exit 1

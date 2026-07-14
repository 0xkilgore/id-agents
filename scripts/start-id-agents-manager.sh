#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${ID_AGENTS_REPO_DIR:-"${SCRIPT_DIR}/.."}" && pwd)"
cd "$REPO_DIR"

export NODE_ENV=production
export AGENT_MANAGER_PORT="${AGENT_MANAGER_PORT:-4100}"
export ID_TEAM="${ID_TEAM:-default}"
export ID_AGENTS_HOME="${ID_AGENTS_HOME:-"${HOME}/.id-agents"}"
export AGENT_MANAGER_WORKDIR="${AGENT_MANAGER_WORKDIR:-"${ID_AGENTS_HOME}/workspace"}"
export SUPERVISOR_WATCH_ENABLED="${SUPERVISOR_WATCH_ENABLED:-false}"
export SUPERVISOR_OPTIONAL="${SUPERVISOR_OPTIONAL:-true}"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

manager_alert_warn() {
  local msg="$1"
  if [ -n "${MANAGER_ALERT_ENV_WARNINGS:-}" ]; then
    export MANAGER_ALERT_ENV_WARNINGS="${MANAGER_ALERT_ENV_WARNINGS}||${msg}"
  else
    export MANAGER_ALERT_ENV_WARNINGS="${msg}"
  fi
  printf 'WARN manager alert env: %s\n' "$msg" >&2
}

append_loaded_alert_env_file() {
  local path="$1"
  if [ -n "${MANAGER_ALERT_ENV_LOADED_FILES:-}" ]; then
    export MANAGER_ALERT_ENV_LOADED_FILES="${MANAGER_ALERT_ENV_LOADED_FILES}:${path}"
  else
    export MANAGER_ALERT_ENV_LOADED_FILES="${path}"
  fi
  export MANAGER_ALERT_ENV_SOURCE="env_file"
}

alert_env_file_is_private() {
  local path="$1"
  local owner mode group_digit other_digit
  owner="$(stat -f '%Su' "$path" 2>/dev/null || true)"
  mode="$(stat -f '%Lp' "$path" 2>/dev/null || true)"
  if [ -z "$owner" ] || [ -z "$mode" ]; then
    manager_alert_warn "could not stat $path; skipped"
    return 1
  fi
  if [ "$owner" != "$(id -un)" ]; then
    manager_alert_warn "owner for $path is $owner, expected $(id -un); skipped"
    return 1
  fi
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1:1}"
  if [ "$group_digit" != "0" ] || [ "$other_digit" != "0" ]; then
    manager_alert_warn "permissions for $path are $mode, expected no group/other access; skipped"
    return 1
  fi
  return 0
}

load_manager_alert_env_file() {
  local path="$1"
  [ -f "$path" ] || return 0
  alert_env_file_is_private "$path" || return 0

  local raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw#"${raw%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac
    case "$line" in export\ *) line="${line#export }" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$key" in
      TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|CANE_TELEGRAM_BOT_TOKEN|CANE_TELEGRAM_CHAT_ID)
        ;;
      *)
        continue
        ;;
    esac
    if [ -n "${!key+x}" ]; then
      continue
    fi
    if { [ "${value#\"}" != "$value" ] && [ "${value%\"}" != "$value" ]; } || \
       { [ "${value#\'}" != "$value" ] && [ "${value%\'}" != "$value" ]; }; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$path"

  append_loaded_alert_env_file "$path"
}

load_manager_alert_env() {
  local env_files file
  env_files="${MANAGER_ALERT_ENV_FILES:-"${HOME}/Dropbox/Code/cane/taskview/.env.cane"}"
  while [ -n "$env_files" ]; do
    file="${env_files%%:*}"
    if [ "$file" = "$env_files" ]; then
      env_files=""
    else
      env_files="${env_files#*:}"
    fi
    [ -n "$file" ] || continue
    load_manager_alert_env_file "$file"
  done

  if [ -z "${TELEGRAM_BOT_TOKEN+x}" ] && [ -n "${CANE_TELEGRAM_BOT_TOKEN:-}" ]; then
    export TELEGRAM_BOT_TOKEN="$CANE_TELEGRAM_BOT_TOKEN"
  fi
  if [ -z "${TELEGRAM_CHAT_ID+x}" ] && [ -n "${CANE_TELEGRAM_CHAT_ID:-}" ]; then
    export TELEGRAM_CHAT_ID="$CANE_TELEGRAM_CHAT_ID"
  fi
  if [ -z "${MANAGER_ALERT_ENV_SOURCE:-}" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    export MANAGER_ALERT_ENV_SOURCE="process_env"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  load_manager_alert_env
  exec "${NODE_BIN:-node}" dist/start-agent-manager.js
fi

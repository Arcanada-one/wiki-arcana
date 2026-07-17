#!/usr/bin/env bash
set -euo pipefail

env_file="${WIKI_DEPLOY_ENV_FILE:-/srv/apps/wiki-arcana/.env}"
fallback="${OPSBOT_API_KEY_FALLBACK:-}"
# Ops Bot alerting is optional in Phase 1. Until the Vault AppRole deploy-env is
# bootstrapped (/srv/apps/wiki-arcana/.env with VAULT_ADDR/ROLE_ID/SECRET_ID),
# degrade gracefully: use the fallback if provided, else emit an empty key so the
# deploy proceeds without Ops Bot notifications (downstream steps are guarded on a
# non-empty key). Re-enable full Vault resolution by provisioning the .env file.
if [[ ! -r "$env_file" ]]; then
  printf '%s' "$fallback"
  exit 0
fi

set -a
# The deploy environment is provisioned out-of-band from Vault and mode 0640.
# shellcheck source=/dev/null
. "$env_file"
set +a
: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_ROLE_ID:?VAULT_ROLE_ID is required}"
: "${VAULT_SECRET_ID:?VAULT_SECRET_ID is required}"

is_network_failure() {
  [[ "$1" -eq 6 || "$1" -eq 7 || "$1" -eq 28 || "$1" -eq 35 ]]
}

vault_request() {
  local method="$1" url="$2" body="${3:-}" header_value="${4:-}"
  local args=(--silent --show-error --fail --max-time 5 --request "$method")
  if [[ -n "$header_value" ]]; then
    args+=(--config <(printf 'header = "X-Vault-Token: %s"\n' "$header_value"))
  fi
  if [[ -n "$body" ]]; then
    printf '%s' "$body" | curl "${args[@]}" --header 'Content-Type: application/json' --data-binary @- "$url"
  else
    curl "${args[@]}" "$url"
  fi
}

login_payload="$(jq -cn --arg role "$VAULT_ROLE_ID" --arg secret "$VAULT_SECRET_ID" '{role_id:$role,secret_id:$secret}')"
set +e
login_response="$(vault_request POST "$VAULT_ADDR/v1/auth/approle/login" "$login_payload")"
login_rc=$?
set -e
if [[ "$login_rc" -ne 0 ]]; then
  if is_network_failure "$login_rc" && [[ -n "$fallback" ]]; then printf '%s' "$fallback"; exit 0; fi
  echo 'Vault AppRole login failed without an eligible fallback condition' >&2
  exit 1
fi
vault_token="$(jq -er '.auth.client_token' <<< "$login_response")"

set +e
secret_response="$(vault_request GET "$VAULT_ADDR/v1/arcanada/data/prod/wiki-arcana/opsbot" '' "$vault_token")"
secret_rc=$?
set -e
if [[ "$secret_rc" -ne 0 ]]; then
  if is_network_failure "$secret_rc" && [[ -n "$fallback" ]]; then printf '%s' "$fallback"; exit 0; fi
  echo 'Vault secret read failed without an eligible fallback condition' >&2
  exit 1
fi
jq -er '.data.data.api_key' <<< "$secret_response"

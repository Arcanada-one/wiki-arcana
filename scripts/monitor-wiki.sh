#!/usr/bin/env bash
set -euo pipefail

state_dir="${WIKI_MONITOR_STATE_DIR:-/var/lib/wiki-arcana-monitor}"
state_file="$state_dir/state.json"
lock_file="$state_dir/monitor.lock"
timeout_seconds="${WIKI_MONITOR_TIMEOUT_SECONDS:-5}"
test_sink="${WIKI_MONITOR_TEST_SINK:-0}"
ops_url='https://ops.arcanada.ai/events'

[[ "$timeout_seconds" =~ ^[1-9][0-9]?$ ]] && (( timeout_seconds <= 30 )) || {
  echo 'invalid monitor timeout' >&2
  exit 2
}

site_url="${WIKI_SITE_URL:-https://arcanada.wiki/}"
health_url="${WIKI_API_HEALTH_URL:-https://api.arcanada.wiki/health}"
version_url="${WIKI_API_VERSION_URL:-https://api.arcanada.wiki/version}"
mcp_url="${WIKI_MCP_URL:-https://api.arcanada.wiki/mcp}"

allow_url() {
  local url="$1"
  if [[ "$url" == https://* ]]; then return 0; fi
  if [[ "$test_sink" == 1 && "$url" == http://127.0.0.1:* ]]; then return 0; fi
  echo "refusing unsafe URL" >&2
  return 1
}

for url in "$site_url" "$health_url" "$version_url" "$mcp_url"; do
  allow_url "$url" || exit 2
done

if [[ "$test_sink" == 1 ]]; then
  ops_url="${WIKI_MONITOR_TEST_SINK_URL:?test sink URL is required}"
  allow_url "$ops_url" || exit 2
fi

mkdir -p "$state_dir"
chmod 700 "$state_dir"
exec 9>"$lock_file"
flock -w 20 9 || { echo 'monitor lock timeout' >&2; exit 1; }

if [[ ! -f "$state_file" ]]; then
  printf '%s\n' '{"schema_version":1,"probes":{"site":{"failures":0,"alerted":false},"health":{"failures":0,"alerted":false},"version":{"failures":0,"alerted":false},"mcp":{"failures":0,"alerted":false}}}' > "$state_file"
  chmod 600 "$state_file"
fi
jq -e '.schema_version == 1 and (.probes | length) == 4' "$state_file" >/dev/null

probe_code() {
  local url="$1"
  local method="${2:-GET}"
  local code
  if [[ "$method" == POST ]]; then
    if code="$(curl --silent --show-error --max-time "$timeout_seconds" --output /dev/null --write-out '%{http_code}' \
      --request POST --header 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wiki-monitor","version":"1.0.0"}}}' "$url")"; then
      printf '%s' "$code"
    else
      printf '000'
    fi
  elif code="$(curl --silent --show-error --max-time "$timeout_seconds" --output /dev/null --write-out '%{http_code}' "$url")"; then
    printf '%s' "$code"
  else
    printf '000'
  fi
}

resolve_ops_key() {
  local role_id_file="${VAULT_ROLE_ID_FILE:-${CREDENTIALS_DIRECTORY:-/run/credentials/wiki-arcana-monitor}/vault-role-id}"
  local secret_id_file="${VAULT_SECRET_ID_FILE:-${CREDENTIALS_DIRECTORY:-/run/credentials/wiki-arcana-monitor}/vault-secret-id}"
  local vault_addr="${VAULT_ADDR:?VAULT_ADDR is required}"
  local vault_path="${OPSBOT_VAULT_PATH:-arcanada/data/prod/wiki-arcana/opsbot}"
  local role_id secret_id login_payload vault_token
  read -r role_id < "$role_id_file"
  read -r secret_id < "$secret_id_file"
  login_payload="$(jq -cn --arg role "$role_id" --arg secret "$secret_id" '{role_id:$role,secret_id:$secret}')"
  vault_token="$(curl --silent --show-error --fail --max-time "$timeout_seconds" \
    --request POST --header 'Content-Type: application/json' --data-binary @- \
    "$vault_addr/v1/auth/approle/login" <<< "$login_payload" | jq -er '.auth.client_token')"
  curl --silent --show-error --fail --max-time "$timeout_seconds" \
    --config <(printf 'header = "X-Vault-Token: %s"\n' "$vault_token") \
    "$vault_addr/v1/$vault_path" | jq -er '.data.data.api_key'
}

post_event() {
  local payload="$1"
  local code
  if [[ "$test_sink" == 1 ]]; then
    code="$(printf '%s' "$payload" | curl --silent --show-error --max-time "$timeout_seconds" \
      --output /dev/null --write-out '%{http_code}' --request POST \
      --header 'Content-Type: application/json' --data-binary @- "$ops_url")"
  else
    local ops_key
    ops_key="$(resolve_ops_key)"
    code="$(printf '%s' "$payload" | curl --silent --show-error --max-time "$timeout_seconds" \
      --output /dev/null --write-out '%{http_code}' --request POST --header 'Content-Type: application/json' \
      --config <(printf 'header = "Authorization: Bearer %s"\n' "$ops_key") \
      --data-binary @- "$ops_url")"
  fi
  [[ "$code" == 2* ]] || { echo "Ops event rejected with HTTP $code" >&2; return 1; }
}

save_probe_state() {
  local probe="$1" failures="$2" alerted="$3"
  local next="$state_dir/state.json.next.$$"
  jq --arg probe "$probe" --argjson failures "$failures" --argjson alerted "$alerted" \
    '.probes[$probe] = {failures:$failures, alerted:$alerted}' "$state_file" > "$next"
  chmod 600 "$next"
  mv -f "$next" "$state_file"
}

emit_event() {
  local probe="$1" category="$2" title="$3"
  local payload
  payload="$(jq -cn --arg category "$category" --arg title "$title" --arg probe "$probe" '{
    category:$category,
    agent:"wiki-arcana-monitor",
    title:$title,
    body:("Probe " + $probe + " changed state"),
    dedup_key:("wiki-arcana-monitor-" + $probe)
  }')"
  post_event "$payload"
}

run_probe() {
  local probe="$1" expected="$2" url="$3" method="${4:-GET}"
  local code failures alerted
  code="$(probe_code "$url" "$method")"
  failures="$(jq -r --arg probe "$probe" '.probes[$probe].failures' "$state_file")"
  alerted="$(jq -r --arg probe "$probe" '.probes[$probe].alerted' "$state_file")"
  if [[ "$code" == "$expected" ]]; then
    if [[ "$alerted" == true ]]; then emit_event "$probe" info 'Wiki Arcana probe recovered'; fi
    save_probe_state "$probe" 0 false
    return 0
  fi
  failures=$((failures + 1))
  if (( failures >= 3 )) && [[ "$alerted" == false ]]; then
    emit_event "$probe" fatal 'Wiki Arcana probe failed'
    alerted=true
  fi
  save_probe_state "$probe" "$failures" "$alerted"
  echo "probe $probe failed with HTTP $code" >&2
  return 1
}

failed=0
run_probe site 200 "$site_url" || failed=1
run_probe health 200 "$health_url" || failed=1
run_probe version 200 "$version_url" || failed=1
run_probe mcp 401 "$mcp_url" POST || failed=1
exit "$failed"

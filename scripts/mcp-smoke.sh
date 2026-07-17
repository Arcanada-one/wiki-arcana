#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 (--authorized|--assert-unauthorized) <mcp-url>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
mode="$1"
endpoint="$2"
[[ "$mode" == "--authorized" || "$mode" == "--assert-unauthorized" ]] || usage
[[ "$endpoint" == http://127.0.0.1:*/* || "$endpoint" == https://* ]] || {
  echo "refusing non-HTTPS, non-loopback MCP endpoint" >&2
  exit 2
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
protocol='2025-06-18'
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wiki-smoke","version":"1.0.0"}}}'

request() {
  local body="$1"
  local output="$2"
  shift 2
  curl --silent --show-error --max-time 10 --output "$output" --write-out '%{http_code}' \
    --request POST "$endpoint" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --header "MCP-Protocol-Version: $protocol" \
    "$@" \
    --data "$body"
}

if [[ "$mode" == "--assert-unauthorized" ]]; then
  code="$(request "$initialize" "$tmp_dir/unauthorized.json")"
  [[ "$code" == '401' ]] || {
    echo "expected 401 without bearer, received $code" >&2
    exit 1
  }
  echo 'MCP unauthorized smoke: 401'
  exit 0
fi

: "${WIKI_TOKEN:?WIKI_TOKEN is required for authorized MCP smoke}"
code="$(request "$initialize" "$tmp_dir/initialize.json" --header "Authorization: Bearer $WIKI_TOKEN")"
[[ "$code" == '200' ]] || { echo "initialize returned $code" >&2; exit 1; }
jq -e --arg protocol "$protocol" '.result.protocolVersion == $protocol' "$tmp_dir/initialize.json" >/dev/null

tools='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
code="$(request "$tools" "$tmp_dir/tools.json" --header "Authorization: Bearer $WIKI_TOKEN")"
[[ "$code" == '200' ]] || { echo "tools/list returned $code" >&2; exit 1; }
jq -e '[.result.tools[].name] == ["wiki_ping", "wiki_spaces_list"]' "$tmp_dir/tools.json" >/dev/null
echo 'MCP authorized smoke: initialize + tools/list passed'

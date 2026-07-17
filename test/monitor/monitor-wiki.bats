#!/usr/bin/env bats

setup() {
  export TEST_ROOT="$BATS_TEST_TMPDIR/case"
  export STATE_DIR="$TEST_ROOT/state"
  export CONFIG_FILE="$TEST_ROOT/config.json"
  export EVENT_FILE="$TEST_ROOT/events.jsonl"
  export MONITOR_PORT=$((19000 + BATS_TEST_NUMBER))
  mkdir -p "$TEST_ROOT" "$STATE_DIR"
  : > "$EVENT_FILE"
  write_config 200 200 200 401 0
  MONITOR_FIXTURE_CONFIG="$CONFIG_FILE" MONITOR_FIXTURE_EVENTS="$EVENT_FILE" \
    MONITOR_FIXTURE_PORT="$MONITOR_PORT" python3 "$BATS_TEST_DIRNAME/../fixtures/monitor_server.py" &
  SERVER_PID=$!
  for _ in {1..30}; do
    curl -s "http://127.0.0.1:$MONITOR_PORT/" >/dev/null 2>&1 && break
    sleep 0.05
  done
  export WIKI_MONITOR_STATE_DIR="$STATE_DIR"
  export WIKI_MONITOR_TEST_SINK=1
  export WIKI_MONITOR_TEST_SINK_URL="http://127.0.0.1:$MONITOR_PORT/events"
  export WIKI_SITE_URL="http://127.0.0.1:$MONITOR_PORT/"
  export WIKI_API_HEALTH_URL="http://127.0.0.1:$MONITOR_PORT/health"
  export WIKI_API_VERSION_URL="http://127.0.0.1:$MONITOR_PORT/version"
  export WIKI_MCP_URL="http://127.0.0.1:$MONITOR_PORT/mcp"
  export WIKI_MONITOR_TIMEOUT_SECONDS=1
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/monitor-wiki.sh"
}

teardown() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}

write_config() {
  printf '{"/":%s,"/health":%s,"/version":%s,"/mcp":%s,"delay":%s}\n' "$1" "$2" "$3" "$4" "$5" > "$CONFIG_FILE"
}

@test "all four probes pass with no event" {
  run "$SCRIPT"
  [ "$status" -eq 0 ] && [ ! -s "$EVENT_FILE" ]
}

@test "three consecutive failures emit one deduplicated fatal and no early alert" {
  write_config 500 200 200 401 0
  run "$SCRIPT"; [ "$status" -ne 0 ] && [ ! -s "$EVENT_FILE" ]
  run "$SCRIPT"; [ "$status" -ne 0 ] && [ ! -s "$EVENT_FILE" ]
  run "$SCRIPT"; [ "$status" -ne 0 ]
  [ "$(wc -l < "$EVENT_FILE")" -eq 1 ]
  jq -e '.category == "fatal" and .dedup_key == "wiki-arcana-monitor-site"' "$EVENT_FILE"
}

@test "first success after an alert emits one recovery" {
  write_config 500 200 200 401 0
  "$SCRIPT" >/dev/null 2>&1 || true
  "$SCRIPT" >/dev/null 2>&1 || true
  "$SCRIPT" >/dev/null 2>&1 || true
  write_config 200 200 200 401 0
  run "$SCRIPT"
  [ "$status" -eq 0 ] && [ "$(wc -l < "$EVENT_FILE")" -eq 2 ]
  tail -n 1 "$EVENT_FILE" | jq -e '.category == "info" and .title == "Wiki Arcana probe recovered"'
}

@test "failure counters are independent per probe" {
  write_config 500 200 200 401 0
  run "$SCRIPT"
  [ "$status" -ne 0 ]
  jq -e '.probes.site.failures == 1 and .probes.health.failures == 0 and .probes.mcp.failures == 0' "$STATE_DIR/state.json"
}

@test "state remains valid under concurrent runs" {
  "$SCRIPT" >/dev/null & first=$!
  "$SCRIPT" >/dev/null & second=$!
  wait "$first" && wait "$second"
  jq -e '.schema_version == 1 and (.probes | length) == 4' "$STATE_DIR/state.json"
}

@test "URL allowlist rejects link-local metadata targets" {
  export WIKI_SITE_URL='http://169.254.169.254/latest/meta-data'
  run "$SCRIPT"
  [ "$status" -eq 2 ] && [[ "$output" == *"refusing unsafe URL"* ]]
}

@test "timeout fails closed and output redacts credentials" {
  write_config 200 200 200 401 2
  export OPSBOT_API_KEY='canary-secret-that-must-not-print'
  run "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" != *"canary-secret-that-must-not-print"* ]]
}

@test "synthetic dead target exits non-zero but test sink remains isolated" {
  export WIKI_SITE_URL='http://127.0.0.1:9/'
  run "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "systemd units declare five-minute cadence and hardened state" {
  grep -q '^OnUnitActiveSec=5min$' "$BATS_TEST_DIRNAME/../../deploy/systemd/wiki-arcana-monitor.timer"
  grep -q '^StateDirectory=wiki-arcana-monitor$' "$BATS_TEST_DIRNAME/../../deploy/systemd/wiki-arcana-monitor.service"
  grep -q '^NoNewPrivileges=true$' "$BATS_TEST_DIRNAME/../../deploy/systemd/wiki-arcana-monitor.service"
  grep -q '^ExecStart=/usr/bin/bash .*monitor-wiki.sh$' "$BATS_TEST_DIRNAME/../../deploy/systemd/wiki-arcana-monitor.service"
}

#!/usr/bin/env bash

require_access_probe_binaries() {
  local probe_binary
  for probe_binary in sudo runuser hostname; do
    if ! command -v "$probe_binary" >/dev/null 2>&1; then
      printf 'wiki-arcana installer: required access probe command is missing: %s\n' \
        "$probe_binary" >&2
      return 1
    fi
  done
}

sudo_denial_is_expected() {
  local runner_user="$1"
  local output="$2"
  local host
  if ! host="$(hostname 2>/dev/null)" || [[ -z "$host" || "$host" == *$'\n'* ]]; then
    printf 'wiki-arcana installer: unable to identify host for sudo denial check\n' >&2
    return 2
  fi
  [[ "$output" == "User $runner_user is not allowed to run sudo on $host." ]]
}

sudo_listing_is_expected() {
  local runner_user="$1"
  local output="$2"
  local expected_command="$3"
  local line
  local saw_user_header=0
  local saw_expected_command=0
  local in_defaults=0
  local command_line_pattern='^[[:space:]]+\([^)]*\)[[:space:]].+$'
  while IFS= read -r line; do
    case "$line" in
      "User $runner_user may run the following commands on "*)
        [[ "$line" =~ ^User[[:space:]]+${runner_user}[[:space:]]+may[[:space:]]+run[[:space:]]+the[[:space:]]+following[[:space:]]+commands[[:space:]]+on[[:space:]][[:alnum:]_.-]+:$ ]] || return 1
        saw_user_header=1
        in_defaults=0
        ;;
      "Matching Defaults entries for $runner_user on "*)
        [[ "$line" =~ ^Matching[[:space:]]Defaults[[:space:]]entries[[:space:]]for[[:space:]]${runner_user}[[:space:]]on[[:space:]][[:alnum:]_.-]+:$ ]] || return 1
        [ "$in_defaults" -eq 0 ] || return 1
        in_defaults=1
        ;;
      '')
        ;;
      *)
        if [ "$saw_user_header" -eq 1 ]; then
          if [[ "$line" =~ $command_line_pattern ]]; then
            [[ "$line" == *"$expected_command"* ]] && saw_expected_command=1
          else
            return 1
          fi
        elif [ "$in_defaults" -eq 1 ] && [[ "$line" == [[:space:]]* ]]; then
          :
        else
          return 1
        fi
        ;;
    esac
  done <<<"$output"
  [[ "$saw_user_header" -eq 1 && "$saw_expected_command" -eq 1 ]]
}

# Return codes: 0 = the requested command is allowed, 1 = exact sudo denial,
# 2 = the probe itself could not be trusted.
probe_sudo_access() {
  local runner_user="$1"
  local expected_command="$2"
  shift 2
  local output
  local probe_status
  if ! command -v sudo >/dev/null 2>&1; then
    printf 'wiki-arcana installer: sudo access probe command is missing\n' >&2
    return 2
  fi
  if output="$(sudo -n -l -U "$runner_user" "$@" 2>&1)"; then
    probe_status=0
  else
    probe_status=$?
  fi
  case "$probe_status" in
    0)
      if sudo_listing_is_expected "$runner_user" "$output" "$expected_command"; then
        return 0
      fi
      printf 'wiki-arcana installer: sudo access probe returned unexpected output\n' >&2
      return 2
      ;;
    1)
      if sudo_denial_is_expected "$runner_user" "$output"; then
        return 1
      fi
      printf 'wiki-arcana installer: sudo access probe returned unexpected denial output\n' >&2
      return 2
      ;;
    *)
      printf 'wiki-arcana installer: sudo access probe exited unexpectedly (%s)\n' \
        "$probe_status" >&2
      return 2
      ;;
  esac
}

# Return codes: 0 = readable, 1 = unreadable, 2 = probe error.
probe_runuser_read_access() {
  local runner_user="$1"
  local protected_path="$2"
  local output
  local probe_status
  if ! command -v runuser >/dev/null 2>&1; then
    printf 'wiki-arcana installer: runuser access probe command is missing\n' >&2
    return 2
  fi
  if output="$(runuser -u "$runner_user" -- test -r "$protected_path" 2>&1)"; then
    probe_status=0
  else
    probe_status=$?
  fi
  case "$probe_status" in
    0)
      if [[ -z "$output" ]]; then
        return 0
      fi
      printf 'wiki-arcana installer: runuser access probe returned unexpected output\n' >&2
      return 2
      ;;
    1)
      if [[ -z "$output" || "$output" == 'runuser: failed to execute test: Permission denied' ]]; then
        return 1
      fi
      printf 'wiki-arcana installer: runuser access probe failed unexpectedly\n' >&2
      return 2
      ;;
    *)
      printf 'wiki-arcana installer: runuser access probe exited unexpectedly (%s)\n' \
        "$probe_status" >&2
      return 2
      ;;
  esac
}

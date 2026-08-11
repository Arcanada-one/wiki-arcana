#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly bind_host='100.97.136.74'
readonly bind_port='5433'
readonly minimum_free_disk_bytes='8589934592'

usage() {
  echo "usage: $0 [--fixture <sanitized-fixture>]" >&2
  exit 2
}

require_value() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || { echo "missing probe value: $name" >&2; exit 2; }
}

validate_values() {
  [[ "$pg_version" =~ ^18\.[0-9]+([.][0-9]+)?([[:space:]][[:print:]]+)?$ ]] \
    || { echo 'invalid PostgreSQL version evidence' >&2; exit 2; }
  [[ "$vector_available" =~ ^(true|false)$ ]] \
    || { echo 'invalid vector availability evidence' >&2; exit 2; }
  [[ -z "$vector_default_version" || "$vector_default_version" =~ ^[0-9]+([.][0-9]+){1,3}([A-Za-z0-9._+-]*)?$ ]] \
    || { echo 'invalid vector default-version evidence' >&2; exit 2; }
  [[ -z "$vector_installed_version" || "$vector_installed_version" =~ ^[0-9]+([.][0-9]+){1,3}([A-Za-z0-9._+-]*)?$ ]] \
    || { echo 'invalid vector version evidence' >&2; exit 2; }
  [[ "$age_available" =~ ^(true|false)$ ]] \
    || { echo 'invalid AGE availability evidence' >&2; exit 2; }
  [[ -z "$age_default_version" || "$age_default_version" =~ ^[0-9]+([.][0-9]+){1,3}([A-Za-z0-9._+-]*)?$ ]] \
    || { echo 'invalid AGE default-version evidence' >&2; exit 2; }
  [[ -z "$age_installed_version" || "$age_installed_version" =~ ^[0-9]+([.][0-9]+){1,3}([A-Za-z0-9._+-]*)?$ ]] \
    || { echo 'invalid AGE version evidence' >&2; exit 2; }
  [[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || { echo 'invalid image digest evidence' >&2; exit 2; }
  [[ "$free_disk_bytes" =~ ^[0-9]+$ ]] \
    || { echo 'invalid free disk evidence' >&2; exit 2; }
  [[ "$bind_available" =~ ^(true|false)$ ]] \
    || { echo 'invalid bind availability evidence' >&2; exit 2; }
  [[ "$backup_coverage" =~ ^(verified|missing|unknown)$ ]] \
    || { echo 'invalid backup coverage evidence' >&2; exit 2; }
}

load_fixture() {
  local fixture="$1"
  local key=''
  local value=''
  local seen_pg_version='false'
  local seen_vector_available='false'
  local seen_vector_default_version='false'
  local seen_vector_installed_version='false'
  local seen_age_available='false'
  local seen_age_default_version='false'
  local seen_age_installed_version='false'
  local seen_image_digest='false'
  local seen_free_disk_bytes='false'
  local seen_bind_available='false'
  local seen_backup_coverage='false'

  [[ -f "$fixture" && -r "$fixture" ]] || { echo 'fixture is not a readable file' >&2; exit 2; }

  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || { echo 'invalid fixture record' >&2; exit 2; }
    case "$key" in
      pg_version)
        [[ "$seen_pg_version" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        pg_version="$value"; seen_pg_version='true'
        ;;
      vector_available)
        [[ "$seen_vector_available" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        vector_available="$value"; seen_vector_available='true'
        ;;
      vector_default_version)
        [[ "$seen_vector_default_version" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        vector_default_version="$value"; seen_vector_default_version='true'
        ;;
      vector_installed_version)
        [[ "$seen_vector_installed_version" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        vector_installed_version="$value"; seen_vector_installed_version='true'
        ;;
      age_available)
        [[ "$seen_age_available" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        age_available="$value"; seen_age_available='true'
        ;;
      age_default_version)
        [[ "$seen_age_default_version" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        age_default_version="$value"; seen_age_default_version='true'
        ;;
      age_installed_version)
        [[ "$seen_age_installed_version" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        age_installed_version="$value"; seen_age_installed_version='true'
        ;;
      image_digest)
        [[ "$seen_image_digest" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        image_digest="$value"; seen_image_digest='true'
        ;;
      free_disk_bytes)
        [[ "$seen_free_disk_bytes" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        free_disk_bytes="$value"; seen_free_disk_bytes='true'
        ;;
      bind_available)
        [[ "$seen_bind_available" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        bind_available="$value"; seen_bind_available='true'
        ;;
      backup_coverage)
        [[ "$seen_backup_coverage" == 'false' ]] || { echo 'duplicate fixture key' >&2; exit 2; }
        backup_coverage="$value"; seen_backup_coverage='true'
        ;;
      *)
        echo 'unknown fixture key' >&2
        exit 2
        ;;
    esac
  done < "$fixture"

  for required in \
    "$seen_pg_version" \
    "$seen_vector_available" \
    "$seen_vector_default_version" \
    "$seen_vector_installed_version" \
    "$seen_age_available" \
    "$seen_age_default_version" \
    "$seen_age_installed_version" \
    "$seen_image_digest" \
    "$seen_free_disk_bytes" \
    "$seen_bind_available" \
    "$seen_backup_coverage"; do
    [[ "$required" == 'true' ]] || { echo 'fixture is missing a required key' >&2; exit 2; }
  done
}

load_live_evidence() {
  local extension_row=''
  local available_kb=''
  local image_ref="${WIKI_STORAGE_IMAGE:-wiki-arcana-storage:local}"
  local data_path="${WIKI_STORAGE_DATA_PATH:-.}"

  command -v psql >/dev/null 2>&1 || { echo 'psql is required for the live probe' >&2; exit 2; }
  command -v docker >/dev/null 2>&1 || { echo 'docker is required for the live probe' >&2; exit 2; }
  command -v df >/dev/null 2>&1 || { echo 'df is required for the live probe' >&2; exit 2; }
  command -v ip >/dev/null 2>&1 || { echo 'ip is required for the live probe' >&2; exit 2; }
  command -v ss >/dev/null 2>&1 || { echo 'ss is required for the live probe' >&2; exit 2; }

  : "${PGHOST:?PGHOST is required for the live probe}"
  : "${PGDATABASE:?PGDATABASE is required for the live probe}"
  : "${PGUSER:?PGUSER is required for the live probe}"
  [[ "${PGPORT:-5432}" =~ ^[0-9]{1,5}$ ]] || { echo 'invalid PGPORT' >&2; exit 2; }
  [[ "$image_ref" =~ ^[A-Za-z0-9._/@:-]+$ ]] || { echo 'invalid storage image reference' >&2; exit 2; }
  [[ -d "$data_path" ]] || { echo 'storage data path is not a directory' >&2; exit 2; }

  if ! extension_row="$(psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -c \
    "SELECT current_setting('server_version'),
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector')::text,
            COALESCE((SELECT default_version FROM pg_available_extensions WHERE name = 'vector'), ''),
            COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'vector'), ''),
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age')::text,
            COALESCE((SELECT default_version FROM pg_available_extensions WHERE name = 'age'), ''),
            COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'age'), '');" \
    2>/dev/null)"; then
    echo 'could not query storage compatibility evidence' >&2
    exit 1
  fi
  IFS='|' read -r pg_version vector_available vector_default_version vector_installed_version \
    age_available age_default_version age_installed_version <<< "$extension_row"

  if ! image_digest="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null)"; then
    echo 'could not inspect storage image evidence' >&2
    exit 1
  fi

  available_kb="$(df -Pk "$data_path" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || { echo 'could not read free disk evidence' >&2; exit 1; }
  free_disk_bytes="$((available_kb * 1024))"

  if ip -o address show | grep -qF " $bind_host/" \
    && [[ -z "$(ss -H -ltn "sport = :$bind_port" 2>/dev/null)" ]]; then
    bind_available='true'
  else
    bind_available='false'
  fi

  backup_coverage="${WIKI_STORAGE_BACKUP_COVERAGE:-missing}"
}

emit_json() {
  PROBE_PG_VERSION="$pg_version" \
  PROBE_VECTOR_AVAILABLE="$vector_available" \
  PROBE_VECTOR_INSTALLED_VERSION="$vector_installed_version" \
  PROBE_AGE_AVAILABLE="$age_available" \
  PROBE_AGE_INSTALLED_VERSION="$age_installed_version" \
  PROBE_IMAGE_DIGEST="$image_digest" \
  PROBE_FREE_DISK_BYTES="$free_disk_bytes" \
  PROBE_BIND_AVAILABLE="$bind_available" \
  PROBE_BACKUP_COVERAGE="$backup_coverage" \
  PROBE_VERDICT="$verdict" \
  node --input-type=module -e '
    const optionalVersion = (value) => value === "" ? null : value;
    const output = {
      pg_version: process.env.PROBE_PG_VERSION,
      vector_available: process.env.PROBE_VECTOR_AVAILABLE === "true",
      vector_installed_version: optionalVersion(process.env.PROBE_VECTOR_INSTALLED_VERSION),
      age_available: process.env.PROBE_AGE_AVAILABLE === "true",
      age_installed_version: optionalVersion(process.env.PROBE_AGE_INSTALLED_VERSION),
      image_digest: process.env.PROBE_IMAGE_DIGEST,
      free_disk_bytes: Number(process.env.PROBE_FREE_DISK_BYTES),
      bind_available: process.env.PROBE_BIND_AVAILABLE === "true",
      backup_coverage: process.env.PROBE_BACKUP_COVERAGE,
      verdict: process.env.PROBE_VERDICT,
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
  '
}

pg_version=''
vector_available=''
vector_default_version=''
vector_installed_version=''
age_available=''
age_default_version=''
age_installed_version=''
image_digest=''
free_disk_bytes=''
bind_available=''
backup_coverage=''
verdict='incompatible'

case "$#" in
  0)
    load_live_evidence
    ;;
  2)
    [[ "$1" == '--fixture' ]] || usage
    load_fixture "$2"
    ;;
  *)
    usage
    ;;
esac

require_value 'pg_version' "$pg_version"
require_value 'vector_available' "$vector_available"
require_value 'age_available' "$age_available"
require_value 'image_digest' "$image_digest"
require_value 'free_disk_bytes' "$free_disk_bytes"
require_value 'bind_available' "$bind_available"
require_value 'backup_coverage' "$backup_coverage"
validate_values

version_at_least() {
  local candidate="$1"
  local minimum_major="$2"
  local minimum_minor="$3"
  local major=''
  local minor=''

  [[ "$candidate" =~ ^([0-9]+)[.]([0-9]+) ]] || return 1
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  (( 10#$major > minimum_major || (10#$major == minimum_major && 10#$minor >= minimum_minor) ))
}

if [[ "$vector_available" == 'true' \
  && "$age_available" == 'true' \
  && -n "$vector_default_version" \
  && -n "$vector_installed_version" \
  && -n "$age_default_version" \
  && -n "$age_installed_version" \
  && "$age_default_version" == '1.7.0' \
  && "$age_installed_version" == '1.7.0' \
  && "$free_disk_bytes" -ge "$minimum_free_disk_bytes" \
  && "$bind_available" == 'true' \
  && "$backup_coverage" == 'verified' ]] \
  && version_at_least "$vector_default_version" 0 8 \
  && version_at_least "$vector_installed_version" 0 8; then
  verdict='compatible'
fi

emit_json
[[ "$verdict" == 'compatible' ]]

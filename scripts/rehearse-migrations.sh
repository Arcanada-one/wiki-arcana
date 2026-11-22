#!/usr/bin/env bash
set -euo pipefail

: "${PG_IMAGE:?PG_IMAGE must name the CI-built PostgreSQL 16 test image}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$root/test/fixtures/migrations/202607170001_registry_v0.sql"
manifest="$root/test/fixtures/migrations/202607170001_registry_v0.json"
source_commit='395214a0447902ea9d5309e982c88cd69f9035e1'
admin_user='wiki_arcana_admin'
runtime_user='wiki_arcana_runtime'
database_name="wiki_arcana_wiki0002_test_$(date -u +%Y%m%d_%H%M%S)"
container_id=''
container_name="wiki-arcana-migration-${GITHUB_RUN_ID:-local}-$$"

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

expected_fixture_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$manifest")"
fixture_sha="$(sha256sum "$fixture" | cut -d' ' -f1)"
test "$fixture_sha" = "$expected_fixture_sha"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_commit"])' "$manifest")" = "$source_commit"

container_id="$(docker run --detach --rm \
  --name "$container_name" \
  --env "POSTGRES_USER=$admin_user" \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env "POSTGRES_DB=$database_name" \
  --publish 127.0.0.1::5432 \
  "$PG_IMAGE")"
host_port="$(docker port "$container_id" 5432/tcp)"
host_port="${host_port##*:}"

ready=0
for ((attempt=1; attempt<=30; attempt++)); do
  if docker exec "$container_id" pg_isready --username "$admin_user" --dbname "$database_name" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1

server_version_num="$(docker exec "$container_id" psql --username "$admin_user" --dbname "$database_name" --no-align --tuples-only --command 'SHOW server_version_num')"
[[ "$server_version_num" == 18* ]]
printf 'postgres_server_version_num=%s\n' "$server_version_num"

docker exec --interactive "$container_id" psql \
  --username "$admin_user" --dbname "$database_name" --set ON_ERROR_STOP=1 < "$fixture"
docker exec "$container_id" psql \
  --username "$admin_user" --dbname "$database_name" --set ON_ERROR_STOP=1 \
  --command "CREATE ROLE $runtime_user LOGIN"

admin_url="postgresql://${admin_user}:fixture@127.0.0.1:${host_port}/${database_name}"
runtime_url="postgresql://${runtime_user}:fixture@127.0.0.1:${host_port}/${database_name}"

STORAGE_ADMIN_DATABASE_URL="$admin_url" corepack pnpm exec prisma migrate resolve \
  --applied 202607170001_registry_v0 \
  --config prisma.migrate.config.ts \
  --schema prisma/schema.prisma

baseline_counts_match="$(docker exec "$container_id" psql \
  --username "$admin_user" --dbname "$database_name" --no-align --tuples-only \
  --command "SELECT (SELECT count(*) = 1 FROM public._prisma_migrations) AND (SELECT count(*) = 1 FROM public.knowledge_spaces) AND (SELECT count(*) = 4 FROM public.access_levels) AND (SELECT count(*) = 1 FROM public.space_closure) AND (SELECT count(*) = 0 FROM public.space_grants) AND (SELECT count(*) = 0 FROM public.effective_permissions)")"
test "$baseline_counts_match" = t
printf 'baseline_seed_counts_match=true\n'

STORAGE_DATABASE_URL="$runtime_url" \
STORAGE_ADMIN_DATABASE_URL="$admin_url" \
  "$root/scripts/migrate.sh"

age_version="$(docker exec "$container_id" psql \
  --username "$admin_user" --dbname "$database_name" --no-align --tuples-only \
  --command "SELECT extversion FROM pg_extension WHERE extname = 'age'")"
vector_version="$(docker exec "$container_id" psql \
  --username "$admin_user" --dbname "$database_name" --no-align --tuples-only \
  --command "SELECT extversion FROM pg_extension WHERE extname = 'vector'")"
test "$age_version" = '1.7.0'
[[ "$vector_version" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]]
vector_major="${BASH_REMATCH[1]}"
vector_minor="${BASH_REMATCH[2]}"
(( 10#$vector_major > 0 || (10#$vector_major == 0 && 10#$vector_minor >= 8) ))
printf 'age=%s vector=%s\n' "$age_version" "$vector_version"

TEST_REGISTRY_DATABASE_URL="$admin_url" \
TEST_STORAGE_DATABASE_URL="$runtime_url" \
TEST_STORAGE_ADMIN_DATABASE_URL="$admin_url" \
  corepack pnpm test

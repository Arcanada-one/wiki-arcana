#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

database_name="${DATABASE_URL%%\?*}"
database_name="${database_name##*/}"

if [[ "$database_name" == "wiki_arcana" ]]; then
  : "${WIKI_VERIFIED_BACKUP_EVIDENCE:?production migration requires verified backup evidence}"
fi

if [[ "$database_name" != "wiki_arcana" && ! "$database_name" =~ ^wiki_arcana_wiki0001_test_[0-9]{8}_[0-9]{6}$ ]]; then
  echo "Refusing unexpected database target" >&2
  exit 2
fi

exec pnpm prisma migrate deploy --schema prisma/schema.prisma


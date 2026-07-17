#!/usr/bin/env bash
set -euo pipefail

sha="${1:?commit SHA is required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid commit SHA' >&2; exit 2; }
deploy_root='/srv/apps/wiki-arcana'
release="$deploy_root/releases/$sha"
[[ "$release" == /srv/apps/wiki-arcana/releases/* ]] || exit 2

install -d -m 0755 "$deploy_root/releases" "$release"
rsync -a --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'coverage/' --exclude '.env*' \
  ./ "$release/"
cd "$release"
corepack enable
pnpm install --frozen-lockfile
pnpm build
ln -sfn "$release" "$deploy_root/current.next"
mv -Tf "$deploy_root/current.next" "$deploy_root/current"
# The systemd unit is a one-time root bootstrap: the ci-runner has no sudo rights
# to write /etc/systemd/system (only daemon-reload/restart). Warn loudly if the
# committed unit drifts from the installed one so an operator re-bootstrap fires.
if ! diff -q deploy/systemd/wiki-arcana.service /etc/systemd/system/wiki-arcana.service >/dev/null 2>&1; then
  echo "::warning::wiki-arcana.service differs from the installed unit — operator must re-install /etc/systemd/system/wiki-arcana.service as root before this deploy takes effect" >&2
fi
sudo systemctl daemon-reload
sudo systemctl restart wiki-arcana.service
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4110/health >/dev/null
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4110/version >/dev/null

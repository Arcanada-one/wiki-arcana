#!/usr/bin/env bash
set -euo pipefail

readonly BROKER_PATH='/usr/local/sbin/wiki-arcana-deploy'
readonly SUDOERS_PATH='/etc/sudoers.d/wiki-arcana-deploy'
readonly BUILD_USER='wiki-arcana-build'

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
command -v visudo >/dev/null || { echo 'visudo is required' >&2; exit 1; }
id ci-runner-deploy >/dev/null 2>&1 || { echo 'ci-runner-deploy account is required' >&2; exit 1; }

if ! getent group "$BUILD_USER" >/dev/null; then
  groupadd --system "$BUILD_USER"
fi
if ! id "$BUILD_USER" >/dev/null 2>&1; then
  useradd --system --gid "$BUILD_USER" --home-dir "/var/lib/$BUILD_USER" --create-home \
    --shell /usr/sbin/nologin "$BUILD_USER"
fi
[[ "$(id -gn "$BUILD_USER")" == "$BUILD_USER" ]] || {
  echo 'build account must use its private primary group' >&2
  exit 1
}
if id -nG "$BUILD_USER" | tr ' ' '\n' | grep -Fxq wiki-arcana; then
  echo 'build account must not belong to the wiki-arcana service group' >&2
  exit 1
fi

install -d -o root -g root -m 0755 /var/lib/wiki-arcana-deploy
install -d -o root -g root -m 0755 /var/lib/wiki-arcana-deploy/build
install -d -o root -g wiki-arcana -m 0755 /srv/apps/wiki-arcana
install -d -o root -g wiki-arcana -m 0755 /srv/apps/wiki-arcana/releases
install -o root -g root -m 0755 "$(dirname -- "${BASH_SOURCE[0]}")/wiki-arcana-deploy" "$BROKER_PATH"

sudoers_tmp="$(mktemp /etc/sudoers.d/.wiki-arcana-deploy.XXXXXX)"
trap 'rm -f -- "$sudoers_tmp"' EXIT
cat >"$sudoers_tmp" <<'SUDOERS'
Cmnd_Alias WIKI_ARCANA_DEPLOY = /usr/local/sbin/wiki-arcana-deploy deploy *, /usr/local/sbin/wiki-arcana-deploy health, /usr/local/sbin/wiki-arcana-deploy rollback *, /usr/local/sbin/wiki-arcana-deploy status
ci-runner-deploy ALL=(root) NOPASSWD:NOSETENV: WIKI_ARCANA_DEPLOY
SUDOERS
chown root:root "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp"
install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_PATH"
visudo -cf "$SUDOERS_PATH"
echo 'wiki-arcana deploy broker installed; systemd unit was not changed'

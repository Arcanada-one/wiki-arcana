#!/usr/bin/env bash
set -euo pipefail
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

source "$(dirname -- "${BASH_SOURCE[0]}")/access-probes.sh"

readonly BROKER_PATH='/usr/local/sbin/wiki-arcana-deploy'
readonly SUDOERS_PATH='/etc/sudoers.d/wiki-arcana-deploy'
readonly BUILD_USER='wiki-arcana-build'
readonly RUNNER_USER='ci-runner-deploy'
readonly ENVIRONMENT_FILE='/etc/wiki-arcana/environment'

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
require_access_probe_binaries || exit 1
command -v visudo >/dev/null || { echo 'visudo is required' >&2; exit 1; }
id "$RUNNER_USER" >/dev/null 2>&1 || { echo 'ci-runner-deploy account is required' >&2; exit 1; }
[[ -f "$ENVIRONMENT_FILE" ]] || { echo 'wiki-arcana environment file is required for access verification' >&2; exit 1; }

if probe_sudo_access "$RUNNER_USER" '/usr/bin/systemctl restart wiki-arcana.service' \
  /usr/bin/systemctl restart wiki-arcana.service; then
  echo 'ci-runner-deploy can already restart wiki-arcana directly through sudo' >&2
  exit 1
else
  probe_status=$?
  [[ "$probe_status" -eq 1 ]] || exit 1
fi

if ! getent group "$BUILD_USER" >/dev/null; then
  groupadd --system "$BUILD_USER"
fi
if ! id "$BUILD_USER" >/dev/null 2>&1; then
  useradd --system --gid "$BUILD_USER" --home-dir "/var/lib/$BUILD_USER" --create-home \
    --shell /usr/sbin/nologin "$BUILD_USER"
fi
[[ "$(id -nG "$BUILD_USER")" == "$BUILD_USER" ]] || {
  echo 'build account must belong only to its private group' >&2
  exit 1
}
[[ "$(getent passwd "$BUILD_USER" | cut -d: -f7)" == '/usr/sbin/nologin' ]] || {
  echo 'build account must use /usr/sbin/nologin' >&2
  exit 1
}
if probe_runuser_read_access "$BUILD_USER" "$ENVIRONMENT_FILE"; then
  echo 'build account can read the wiki-arcana environment file' >&2
  exit 1
else
  probe_status=$?
  [[ "$probe_status" -eq 1 ]] || exit 1
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

for broker_verb in deploy health rollback status; do
  case "$broker_verb" in
    deploy|rollback)
      probe_args=("$BROKER_PATH" "$broker_verb" 0000000000000000000000000000000000000000)
      ;;
    health|status)
      probe_args=("$BROKER_PATH" "$broker_verb")
      ;;
  esac
  if ! probe_sudo_access "$RUNNER_USER" "$BROKER_PATH $broker_verb" "${probe_args[@]}"; then
    echo "ci-runner-deploy broker sudo policy did not allow $broker_verb" >&2
    exit 1
  fi
done
if probe_sudo_access "$RUNNER_USER" '/usr/bin/systemctl restart wiki-arcana.service' \
  /usr/bin/systemctl restart wiki-arcana.service; then
  echo 'ci-runner-deploy can restart wiki-arcana directly through sudo' >&2
  exit 1
else
  probe_status=$?
  [[ "$probe_status" -eq 1 ]] || exit 1
fi
echo 'wiki-arcana deploy broker installed; systemd unit was not changed'

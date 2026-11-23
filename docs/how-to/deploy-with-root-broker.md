# Deploy with the root broker

The production deploy workflow keeps its host preflight and asks the root-owned
`wiki-arcana-deploy` broker to deploy the workflow commit. The broker fetches a
commit reachable from `main`, builds it as the isolated `wiki-arcana-build`
account, installs a root-owned release, switches `current` atomically, restarts
the service, and probes `/health` and `/version`. A failed activation restores
the previous release and restarts it.

The `ci-runner-deploy` account can invoke only these broker verbs through
passwordless sudo:

```sh
sudo -n /usr/local/sbin/wiki-arcana-deploy deploy <40-hex-sha>
sudo -n /usr/local/sbin/wiki-arcana-deploy health
sudo -n /usr/local/sbin/wiki-arcana-deploy rollback <40-hex-sha>
sudo -n /usr/local/sbin/wiki-arcana-deploy status
```

Root installs the broker once after reviewing and merging the change by running
`deploy/broker/install.sh` from the repository checkout. The installer is
idempotent and validates the sudoers policy with `visudo`. It prepares the
dedicated build account and release directories; it does not change the systemd
unit. The broker never reads or prints `/etc/wiki-arcana/environment`.

For an incident, inspect the active release with `status`, check the service
with `health`, and roll back to a known release SHA with `rollback <sha>`. The
workflow also performs its post-deploy health probes and preserves its existing
pre-deploy Vault, Tailscale, time-skew, Docker, memory, load and health checks.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(root, 'deploy/broker/access-probes.sh');
const sandboxes: string[] = [];

function createProbePath(stubs: Record<string, string>): string {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'wiki-arcana-installer-probes-'));
  sandboxes.push(sandbox);
  for (const [name, content] of Object.entries(stubs)) {
    const path = resolve(sandbox, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  return sandbox;
}

function outputStub(): string {
  return `#!/bin/sh\nprintf '%s' "$MOCK_OUTPUT"\nexit "$MOCK_STATUS"\n`;
}

function runProbe(
  functionName: string,
  args: string[],
  path: string,
  output = '',
  status = 0,
) {
  return spawnSync(
    '/bin/bash',
    ['-c', `source "$1"; shift; ${functionName} "$@"`, 'installer-test', helper, ...args],
    {
      encoding: 'utf8',
      env: { PATH: path, MOCK_OUTPUT: output, MOCK_STATUS: String(status) },
    },
  );
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe('wiki-arcana installer access probes', () => {
  const runner = 'ci-runner-deploy';
  const denied = `User ${runner} is not allowed to run sudo on arcana-prd.`;
  const allowed = [
    `Matching Defaults entries for ${runner} on arcana-prd:`,
    '    env_reset, mail_badpass',
    `User ${runner} may run the following commands on arcana-prd:`,
    '    (root) NOPASSWD: NOSETENV: /usr/local/sbin/wiki-arcana-deploy health',
  ].join('\n');
  let standardPath: string;

  beforeEach(() => {
    standardPath = createProbePath({
      sudo: outputStub(),
      runuser: outputStub(),
      hostname: '#!/bin/sh\nprintf arcana-prd\n',
    });
  });

  it('treats only the exact sudo denial as denied and validates allowed listings', () => {
    const exactDenialPath = createProbePath({
      sudo: outputStub(),
      hostname: '#!/bin/sh\nprintf arcana-prd\n',
    });
    expect(runProbe('probe_sudo_access', [runner, '/usr/bin/systemctl restart wiki-arcana.service', '/usr/bin/systemctl', 'restart', 'wiki-arcana.service'], exactDenialPath, denied, 1).status).toBe(1);
    expect(runProbe('probe_sudo_access', [runner, '/usr/bin/systemctl restart wiki-arcana.service', '/usr/bin/systemctl', 'restart', 'wiki-arcana.service'], exactDenialPath, `${denied}\nextra`, 1).status).toBe(2);
    expect(runProbe('probe_sudo_access', [runner, '/usr/bin/systemctl restart wiki-arcana.service', '/usr/bin/systemctl', 'restart', 'wiki-arcana.service'], exactDenialPath, 'sudo: unknown user', 1).status).toBe(2);

    expect(runProbe('probe_sudo_access', [runner, '/usr/local/sbin/wiki-arcana-deploy health', '/usr/local/sbin/wiki-arcana-deploy', 'health'], standardPath, allowed, 0).status).toBe(0);
    expect(runProbe('probe_sudo_access', [runner, '/usr/local/sbin/wiki-arcana-deploy health', '/usr/local/sbin/wiki-arcana-deploy', 'health'], standardPath, 'unrecognized report', 0).status).toBe(2);
    expect(runProbe('probe_sudo_access', [runner, '/usr/local/sbin/wiki-arcana-deploy health', '/usr/local/sbin/wiki-arcana-deploy', 'health'], standardPath, denied, 2).status).toBe(2);
  });

  it('treats expected runuser permission denial as unreadable and aborts on probe errors', () => {
    const exactPermissionPath = createProbePath({
      runuser: outputStub(),
    });
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], standardPath, '', 0).status).toBe(0);
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], exactPermissionPath, '', 1).status).toBe(1);
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], exactPermissionPath, 'runuser: failed to execute test: Permission denied', 1).status).toBe(1);
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], exactPermissionPath, 'runuser: account lookup failed', 1).status).toBe(2);
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], standardPath, '', 2).status).toBe(2);
    expect(runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], standardPath, 'unexpected output', 0).status).toBe(2);
  });

  it('fails clearly when sudo, runuser, or hostname is unavailable', () => {
    const emptyPath = createProbePath({});
    const missingSudo = runProbe('probe_sudo_access', [runner, '/usr/local/sbin/wiki-arcana-deploy health', '/usr/local/sbin/wiki-arcana-deploy', 'health'], emptyPath);
    expect(missingSudo.status).toBe(2);
    expect(missingSudo.stderr).toContain('sudo access probe command is missing');

    const missingRunuser = runProbe('probe_runuser_read_access', ['wiki-arcana-build', '/etc/wiki-arcana/environment'], emptyPath);
    expect(missingRunuser.status).toBe(2);
    expect(missingRunuser.stderr).toContain('runuser access probe command is missing');

    const missingHostname = createProbePath({ sudo: outputStub() });
    const hostnameFailure = runProbe('probe_sudo_access', [runner, '/usr/bin/systemctl restart wiki-arcana.service', '/usr/bin/systemctl', 'restart', 'wiki-arcana.service'], missingHostname, denied, 1);
    expect(hostnameFailure.status).toBe(2);
    expect(hostnameFailure.stderr).toContain('unexpected denial output');

    const requirements = runProbe('require_access_probe_binaries', [], emptyPath);
    expect(requirements.status).toBe(1);
    expect(requirements.stderr).toContain('required access probe command is missing: sudo');
  });

  it('wires fail-closed checks before and after the sudoers write', async () => {
    const { readFileSync } = await import('node:fs');
    const installer = readFileSync(resolve(root, 'deploy/broker/install.sh'), 'utf8');
    expect(installer).toContain('require_access_probe_binaries || exit 1');
    expect(installer).toContain('probe_runuser_read_access "$BUILD_USER" "$ENVIRONMENT_FILE"');
    expect(installer).toContain("/usr/bin/systemctl restart wiki-arcana.service");
    expect(installer).toContain('probe_sudo_access "$RUNNER_USER" "$BROKER_PATH $broker_verb"');
  });
});

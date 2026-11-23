import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const broker = resolve(root, 'deploy/broker/wiki-arcana-deploy');

function runBrokerShell(script: string, testRoot?: string) {
  return spawnSync('bash', ['-c', script, 'broker-test', broker], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...(testRoot ? { WIKI_ARCANA_BROKER_TEST_ROOT: testRoot } : {}),
    },
  });
}

function validateArguments(...args: string[]) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; validate_arguments "$@"', 'broker-test', broker, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

describe('wiki-arcana deployment broker', () => {
  it('accepts only a 40-hex SHA and normalizes uppercase hex', () => {
    const normalized = spawnSync('bash', ['-c', 'source "$1"; normalise_sha "$2"', 'broker-test', broker, 'A'.repeat(40)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    const invalid = spawnSync('bash', ['-c', 'source "$1"; normalise_sha "$2"', 'broker-test', broker, 'abc123'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });

    expect(normalized.status).toBe(0);
    expect(normalized.stdout.trim()).toBe('a'.repeat(40));
    expect(invalid.status).toBe(2);
    expect(validateArguments('deploy', 'a'.repeat(40)).status).toBe(0);
    expect(validateArguments('rollback', 'b'.repeat(40)).status).toBe(0);
    expect(validateArguments('health').status).toBe(0);
    expect(validateArguments('status').status).toBe(0);
    expect(validateArguments('health', 'extra').status).toBe(1);
    expect(validateArguments('deploy').status).toBe(1);
    expect(validateArguments('arbitrary').status).toBe(2);
  });

  it('restores the previous symlink when the new release fails its health probe', () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'wiki-arcana-broker-'));
    const deployRoot = resolve(sandbox, 'apps/wiki-arcana');
    const releases = resolve(deployRoot, 'releases');
    const previous = resolve(releases, 'previous');
    const candidate = resolve(releases, 'candidate');
    mkdirSync(previous, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    symlinkSync(previous, resolve(deployRoot, 'current'));

    const script = [
      'source "$1"',
      'systemctl() { return 0; }',
      'sleep() { :; }',
      'curl() { if [[ "$(readlink -f "$CURRENT_LINK")" == *candidate ]]; then return 22; fi; return 0; }',
      'if activate_release "$WIKI_ARCANA_BROKER_TEST_ROOT/apps/wiki-arcana/releases/candidate"; then exit 1; fi',
      '[[ "$(readlink -f "$CURRENT_LINK")" == "$WIKI_ARCANA_BROKER_TEST_ROOT/apps/wiki-arcana/releases/previous" ]]',
    ].join('\n');

    try {
      const result = runBrokerShell(script, sandbox);
      expect(result.status).toBe(0);
      expect(readlinkSync(resolve(deployRoot, 'current'))).toBe(previous);
      expect(result.stderr).toContain('restoring previous release');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

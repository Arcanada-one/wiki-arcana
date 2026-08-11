import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const dockerfilePath = resolve(root, 'deploy/storage/Dockerfile');
const composePath = resolve(root, 'deploy/storage/compose.yml');
const probePath = resolve(root, 'scripts/storage-compatibility-probe.sh');
const fixturePath = resolve(root, 'test/fixtures/storage-compatibility-probe.txt');
const unavailableFixturePath = resolve(root, 'test/fixtures/storage-compatibility-uninstalled.txt');
const unsupportedFixturePath = resolve(root, 'test/fixtures/storage-compatibility-unsupported-vector.txt');

const baseImage = 'pgvector/pgvector:pg18@sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d';
const ageCommit = '806fa2ebdb300b3e76ef30cdba61803babbf2683';
const debianSnapshot = '20260505T000000Z';
const postgresServerDevVersion = '18.4-1.pgdg12+1';

describe('storage image packaging contract', () => {
  it('pins and verifies AGE while keeping the runtime on the exact pgvector digest', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toContain(`FROM ${baseImage} AS age-builder`);
    expect(dockerfile).toContain(`FROM ${baseImage} AS runtime`);
    expect(dockerfile).toContain(`age_commit='${ageCommit}'`);
    expect(dockerfile).toMatch(/test "\$\(git rev-parse HEAD\)" = "\$age_commit"/);
    expect(dockerfile).toContain(`pg_dev_version='${postgresServerDevVersion}'`);
    expect(dockerfile).toContain('PG_CONFIG=/usr/bin/pg_config');
    expect(dockerfile).not.toContain('PG_CONFIG=/usr/local/bin/pg_config');
    expect(dockerfile).toContain(
      'COPY --from=age-builder /age-install/usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/age.so',
    );
    expect(dockerfile).toContain(
      'COPY --from=age-builder /age-install/usr/share/postgresql/18/extension/age.control /usr/share/postgresql/18/extension/age.control',
    );
    expect(dockerfile).not.toContain('/age-install/usr/local/');
    expect(dockerfile).toContain(
      'bb45f27f6072e8109b9a67e390ff0139ab493f681ec05d1cfed139b101187c00',
    );
    expect(dockerfile).toContain(
      'f9172951259bc897a10ecefc046074ba3beb3acfda7131d34b29627574c45c40',
    );
    expect(dockerfile).not.toContain('ARG AGE_COMMIT');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf(`FROM ${baseImage} AS runtime`));
    expect(runtimeStage).not.toContain('USER postgres');
    expect(dockerfile).toContain(`org.apache.age.revision="${ageCommit}"`);
    expect(dockerfile).toContain(
      `org.opencontainers.image.build.postgresql-server-dev.version="${postgresServerDevVersion}"`,
    );
    expect(dockerfile).not.toMatch(/WIKI-\d{4}/);
  });

  it('installs build dependencies only from the immutable base-declared Debian snapshots', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const debianSnapshotUri = `http://snapshot.debian.org/archive/debian/${debianSnapshot}`;
    const securitySnapshotUri = `http://snapshot.debian.org/archive/debian-security/${debianSnapshot}`;

    expect(dockerfile).toContain(debianSnapshotUri);
    expect(dockerfile).toContain(securitySnapshotUri);
    expect(dockerfile).not.toContain('https://snapshot.debian.org/');
    expect(dockerfile).toContain('Check-Valid-Until: no');
    expect(dockerfile).not.toContain('pgdg.list.disabled');
    expect(dockerfile).not.toMatch(/^\s*&& apt-get update/m);
    expect(dockerfile).toContain(`org.opencontainers.image.build.snapshot.debian="${debianSnapshotUri}"`);
    expect(dockerfile).toContain(
      `org.opencontainers.image.build.snapshot.debian-security="${securitySnapshotUri}"`,
    );
  });
});

describe('storage compose contract', () => {
  it('publishes Postgres only on the allocated Tailscale address with a healthcheck and named volume', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('100.97.136.74:5433:5432');
    expect(compose).not.toMatch(/(?:0\.0\.0\.0|\[?::\]?):5433:5432/);
    expect(compose).toContain('pg_isready');
    expect(compose).toMatch(/storage_data:\s*$/m);
    expect(compose).toContain('storage_db_password');
    expect(compose).not.toMatch(/^\s*privileged:/m);
    expect(compose).not.toContain('/var/run/docker.sock');
  });

  it('allows the upstream root entrypoint to read a root-only secret and then drop to postgres', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(compose).toMatch(
      /cap_add:\s*\n\s*- CHOWN\s*\n\s*- DAC_OVERRIDE\s*\n\s*- FOWNER\s*\n\s*- SETGID\s*\n\s*- SETUID/,
    );
  });

  it('provides an isolated benchmark profile with an enforced 8 GiB ceiling', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toMatch(/storage-benchmark:[\s\S]*profiles:\s*\["benchmark"\]/);
    expect(compose).toMatch(/storage-benchmark:[\s\S]*mem_limit:\s*8g/);
    expect(compose).toMatch(/storage-benchmark:[\s\S]*127\.0\.0\.1:55433:5432/);
    expect(compose).toMatch(/storage_benchmark_data:\s*$/m);
  });
});

describe('storage operational command contracts', () => {
  it('keeps future TypeScript scripts inside lint and typecheck', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const tsconfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8')) as {
      include: string[];
    };

    expect(packageJson.scripts.lint).toMatch(/\bscripts\b/);
    expect(tsconfig.include).toContain('scripts/**/*.ts');
  });

  it.each([
    ['storage:seed', 'benchmark-storage.ts --mode SEED'],
    ['storage:benchmark', 'benchmark-storage.ts --mode AUTHORITATIVE'],
    ['storage:verdict', 'verify-storage-benchmark.ts'],
  ])('%s invokes its Phase-4 implementation', (script, implementation) => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts[script]).toContain(implementation);
  });

  it('refuses a deferred storage command whose implementation is absent', () => {
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/tsx'),
      [resolve(root, 'scripts/run-deferred-storage-command.ts'), 'scripts/storage-seed.ts', 'storage:seed'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('storage:seed is unavailable until its implementation phase');
  });
});

describe('read-only storage compatibility probe', () => {
  it('emits the stable sanitized JSON contract from a recorded fixture', () => {
    const output = execFileSync(probePath, ['--fixture', fixturePath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      'pg_version',
      'vector_available',
      'vector_installed_version',
      'age_available',
      'age_installed_version',
      'image_digest',
      'free_disk_bytes',
      'bind_available',
      'backup_coverage',
      'verdict',
    ]);
    expect(parsed).toEqual({
      pg_version: '18.1',
      vector_available: true,
      vector_installed_version: '0.8.1',
      age_available: true,
      age_installed_version: '1.7.0',
      image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      free_disk_bytes: 17_179_869_184,
      bind_available: true,
      backup_coverage: 'verified',
      verdict: 'compatible',
    });
  });

  it.each([
    ['available but uninstalled extensions', unavailableFixturePath],
    ['an unsupported pgvector version', unsupportedFixturePath],
  ])('fails closed for %s', (_case, fixture) => {
    const result = spawnSync(probePath, ['--fixture', fixture], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'incompatible' });
  });
});

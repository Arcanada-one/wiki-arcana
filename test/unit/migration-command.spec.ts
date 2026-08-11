import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const migrateScript = readFileSync(resolve(root, 'scripts/migrate.sh'), 'utf8');
const prismaMigrationConfig = readFileSync(resolve(root, 'prisma.migrate.config.ts'), 'utf8');
const runtimeEnvironment = readFileSync(resolve(root, '.env.example'), 'utf8');
const migrationEnvironment = readFileSync(resolve(root, '.env.migration.example'), 'utf8');

describe('offline migration command', () => {
  it('uses only the offline admin URL for Prisma and target safety checks', () => {
    expect(prismaMigrationConfig).toContain("env('STORAGE_ADMIN_DATABASE_URL')");
    expect(prismaMigrationConfig).not.toMatch(/env\('DATABASE_URL'\)/);
    expect(migrateScript).toContain('${STORAGE_ADMIN_DATABASE_URL:?STORAGE_ADMIN_DATABASE_URL is required}');
    expect(migrateScript).not.toMatch(/\$\{DATABASE_URL/);
    expect(migrateScript).toContain('--config prisma.migrate.config.ts');
  });

  it('ships a functional admin-only environment example for the accepted disposable target', () => {
    expect(migrationEnvironment).toMatch(
      /^STORAGE_ADMIN_DATABASE_URL=postgresql:\/\/wiki_arcana_admin:[^@]+@[^/]+\/wiki_arcana_wiki0002_test_\d{8}_\d{6}$/m,
    );
    expect(migrationEnvironment).not.toMatch(/^DATABASE_URL=/m);
    expect(runtimeEnvironment).not.toMatch(/^STORAGE_ADMIN_DATABASE_URL=/m);
    expect(migrateScript).toMatch(/wiki_arcana_wiki0002_test_/);
  });
});

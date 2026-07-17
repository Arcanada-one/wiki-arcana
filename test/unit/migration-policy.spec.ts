import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(resolve(root, 'prisma/migrations/202607170001_registry_v0/migration.sql'), 'utf8');

describe('registry v0 migration policy', () => {
  const requiredTables = ['knowledge_spaces', 'space_closure', 'access_levels', 'space_grants', 'effective_permissions'];

  it.each(requiredTables)('creates %s', (table) => {
    expect(migration).toMatch(new RegExp(`CREATE TABLE "${table}"`));
  });

  it('does not create content tables or engine extensions', () => {
    expect(migration).not.toMatch(/CREATE TABLE "(?:documents|nodes|edges|embeddings)"/i);
    expect(migration).not.toMatch(/CREATE\s+EXTENSION/i);
  });

  it('seeds four levels and one root space', () => {
    for (const slug of ['public', 'archivist', 'council', 'holocron']) {
      expect(migration).toContain(`'${slug}'`);
    }
    expect(migration).toContain("'arcanada'");
  });
});


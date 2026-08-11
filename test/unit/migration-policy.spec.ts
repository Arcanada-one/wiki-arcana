import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(resolve(root, 'prisma/migrations/202607170001_registry_v0/migration.sql'), 'utf8');
const storageMigrationPath = resolve(root, 'prisma/migrations/202607200001_storage_engines/migration.sql');
const searchActivationMigrationPath = resolve(root, 'prisma/migrations/202607220001_storage_search_activation/migration.sql');

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

describe('storage engines migration policy', () => {
  const storageMigration = readFileSync(storageMigrationPath, 'utf8');

  it('is additive and has no rollback companion', () => {
    expect(storageMigration).not.toMatch(/\b(?:DROP|TRUNCATE)\b|ALTER\s+TABLE[^;]+\bDROP\b|ON\s+DELETE\s+(?:CASCADE|SET\s+NULL)/i);
    expect(() => readFileSync(resolve(storageMigrationPath, '../rollback.sql'), 'utf8')).toThrow();
  });

  it.each(['vector', 'age'])('installs the %s extension', (extension) => {
    expect(storageMigration).toMatch(new RegExp(`CREATE EXTENSION IF NOT EXISTS "?${extension}"?`, 'i'));
  });

  it.each(['knowledge_nodes', 'knowledge_edges', 'knowledge_vectors'])('creates %s', (table) => {
    expect(storageMigration).toMatch(new RegExp(`CREATE TABLE "${table}"`, 'i'));
  });

  it('uses the pre-registered HNSW construction parameters', () => {
    expect(storageMigration).toMatch(/WITH\s*\(m\s*=\s*16,\s*ef_construction\s*=\s*128\)/i);
  });

  it('configures AGE and grants only bounded runtime privileges', () => {
    expect(storageMigration).toContain("session_preload_libraries");
    expect(storageMigration).toMatch(/ag_catalog,\s*"\$user",\s*public/);
    expect(storageMigration).toMatch(/SET search_path = public, ag_catalog, "\$user"/);
    expect(storageMigration).not.toMatch(/search_path\s*=\s*%L/);
    expect(storageMigration).toMatch(/REVOKE CONNECT ON DATABASE postgres FROM PUBLIC/i);
    expect(storageMigration).toMatch(/REVOKE CONNECT ON DATABASE template1 FROM PUBLIC/i);
    expect(storageMigration).toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(storageMigration).not.toMatch(/GRANT\s+(?:ALL|CREATE|SUPERUSER)/i);
  });

  it('fails closed unless the pre-provisioned runtime role can login, then removes elevated attributes', () => {
    expect(storageMigration).not.toMatch(/CREATE\s+ROLE\s+wiki_arcana_runtime/i);
    expect(storageMigration).toMatch(/rolname\s*=\s*'wiki_arcana_runtime'[\s\S]+rolcanlogin/i);
    expect(storageMigration).toMatch(/RAISE\s+EXCEPTION[^;]+wiki_arcana_runtime/i);
    expect(storageMigration).toMatch(
      /ALTER\s+ROLE\s+wiki_arcana_runtime\s+NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOINHERIT\s+NOREPLICATION\s+NOBYPASSRLS/i,
    );
    expect(storageMigration).not.toMatch(/ALTER\s+ROLE[^;]+PASSWORD/i);
  });

  it('enforces linked-only cross-space edge targets in the database', () => {
    expect(storageMigration).toMatch(
      /FOREIGN KEY \("space_id", "source_node_id"\) REFERENCES "knowledge_nodes"\("space_id", "id"\)/i,
    );
    expect(storageMigration).toMatch(
      /FOREIGN KEY \("target_node_id"\) REFERENCES "knowledge_nodes"\("id"\)/i,
    );
    expect(storageMigration).toMatch(/CREATE FUNCTION "validate_knowledge_edge_spaces"/i);
    expect(storageMigration).toMatch(/source_isolation_mode\s*<>\s*'linked'/i);
    expect(storageMigration).toMatch(
      /CREATE TRIGGER "knowledge_edges_validate_spaces"[\s\S]+BEFORE INSERT OR UPDATE[\s\S]+FOR EACH ROW/i,
    );
  });

  it('serializes grant mutations with storage writes using a transaction-scoped advisory lock', () => {
    expect(storageMigration).toMatch(/CREATE FUNCTION "lock_space_grant_mutation"/i);
    expect(storageMigration).toMatch(
      /(?:pg_catalog\.)?pg_advisory_xact_lock\((?:pg_catalog\.)?hashtextextended\([^,]+,\s*0\)\)/i,
    );
    expect(storageMigration).toMatch(/TG_OP\s*=\s*'INSERT'/i);
    expect(storageMigration).toMatch(/TG_OP\s*=\s*'DELETE'/i);
    expect(storageMigration).toMatch(/OLD\.space_id\s*<>\s*NEW\.space_id/i);
    expect(storageMigration).toMatch(
      /CREATE TRIGGER "space_grants_lock_mutation"[\s\S]+BEFORE INSERT OR UPDATE OR DELETE[\s\S]+FOR EACH ROW/i,
    );
  });

  it('pre-creates the fixed AGE labels so the runtime role never needs schema CREATE', () => {
    expect(storageMigration).toMatch(/create_vlabel\('wiki_arcana',\s*'KnowledgeNode'\)/);
    expect(storageMigration).toMatch(/create_elabel\('wiki_arcana',\s*'KNOWLEDGE_EDGE'\)/);
    expect(storageMigration).not.toMatch(/GRANT\s+CREATE\s+ON\s+SCHEMA/i);
  });
});

describe('storage search activation migration policy', () => {
  const searchActivationMigration = readFileSync(searchActivationMigrationPath, 'utf8');

  it('adds a synchronized half-precision projection without destructive DDL', () => {
    expect(searchActivationMigration).toMatch(/CREATE TABLE "knowledge_vector_projections"/i);
    expect(searchActivationMigration).toMatch(/"embedding" halfvec\(1024\)/i);
    expect(searchActivationMigration).toMatch(
      /ALTER TABLE "knowledge_vector_projections"\s+ALTER COLUMN "embedding" SET STORAGE PLAIN/i,
    );
    expect(searchActivationMigration).toMatch(/CREATE TRIGGER "knowledge_vectors_sync_projection"/i);
    expect(searchActivationMigration).toMatch(/AFTER INSERT OR UPDATE OF "space_id", "embedding"/i);
    expect(searchActivationMigration).toMatch(
      /INSERT INTO "knowledge_vector_projections"[\s\S]+SELECT[\s\S]+"embedding"::halfvec\(1024\)/i,
    );
    expect(searchActivationMigration).toMatch(
      /CREATE INDEX "knowledge_vector_projections_ivfflat_idx"[\s\S]+USING ivfflat[\s\S]+halfvec_cosine_ops[\s\S]+lists\s*=\s*100/i,
    );
    expect(searchActivationMigration).not.toMatch(/\b(?:DROP|TRUNCATE)\b|ALTER\s+TABLE[^;]+\bDROP\b/i);
  });

  it('adds the source-only recursive traversal index', () => {
    expect(searchActivationMigration).toMatch(/CREATE INDEX "knowledge_edges_source_node_idx"[\s\S]+"knowledge_edges" \("source_node_id"\)/i);
  });

  it('grants the runtime role projection reads but not projection writes', () => {
    expect(searchActivationMigration).toMatch(/GRANT SELECT ON "knowledge_vector_projections" TO wiki_arcana_runtime/i);
    expect(searchActivationMigration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]+knowledge_vector_projections/i);
  });
});

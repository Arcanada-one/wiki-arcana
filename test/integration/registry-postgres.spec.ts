import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRegistryAdapter } from '../../src/storage/adapters/postgres/postgres-registry.adapter.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const ids = {
  parent: '01981c60-0000-7000-8000-000000000010',
  child: '01981c60-0000-7000-8000-000000000011',
};

describeDatabase('registry migration on PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PostgresRegistryAdapter(pool);

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO knowledge_spaces (id, slug, name, parent_id, required_level)
       VALUES ($1, 'test-parent', 'Test parent', '01981c60-0000-7000-8000-000000000001', 'public'),
              ($2, 'test-child', 'Test child', $1, 'public')`,
      [ids.parent, ids.child],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM knowledge_spaces WHERE id IN ($1, $2)', [ids.child, ids.parent]);
    await pool.end();
  });

  it('contains exactly four levels and one canonical root seed', async () => {
    const levels = await pool.query('SELECT count(*)::int AS count FROM access_levels');
    const root = await pool.query("SELECT count(*)::int AS count FROM knowledge_spaces WHERE slug='arcanada'");
    expect(levels.rows[0]?.count).toBe(4);
    expect(root.rows[0]?.count).toBe(1);
  });

  it('maintains closure semantics for ancestors and self rows', async () => {
    const result = await pool.query(
      'SELECT depth FROM space_closure WHERE ancestor_id=$1 AND descendant_id=$2',
      [ids.parent, ids.child],
    );
    expect(result.rows[0]?.depth).toBe(1);
  });

  it('applies clearance rank when no explicit grant exists', async () => {
    await expect(adapter.getSpace(
      { subjectId: 'rank-only-user', level: 0, spaceGrants: { allow: [], deny: [] } },
      ids.child,
    )).resolves.toMatchObject({ id: ids.child });
  });

  it('supports user and role grants and recomputes allow rows', async () => {
    await adapter.addGrant({ spaceId: ids.parent, subjectType: 'user', subjectId: 'user-a', effect: 'allow', capability: 'read' });
    await adapter.addGrant({ spaceId: ids.parent, subjectType: 'role', subjectId: 'role-a', effect: 'allow', capability: 'read' });
    const result = await pool.query(
      `SELECT subject_id FROM effective_permissions
       WHERE space_id=$1 AND subject_id IN ('user-a','role-a') ORDER BY subject_id`,
      [ids.child],
    );
    expect(result.rows.map((row) => row.subject_id)).toEqual(['role-a', 'user-a']);
  });

  it('makes explicit denial win and restores access after removal', async () => {
    const deny = { spaceId: ids.child, subjectType: 'user' as const, subjectId: 'user-a', effect: 'deny' as const, capability: 'read' as const };
    await adapter.addGrant(deny);
    await expect(adapter.getSpace({ subjectId: 'user-a', level: 30, spaceGrants: { allow: [], deny: [] } }, ids.child)).resolves.toBeNull();
    await adapter.removeGrant(deny);
    await expect(adapter.getSpace({ subjectId: 'user-a', level: 30, spaceGrants: { allow: [], deny: [] } }, ids.child)).resolves.toMatchObject({ id: ids.child });
  });

  it('deletes stale permissions after an ancestor move', async () => {
    await adapter.moveSpace(ids.child, null);
    const stale = await pool.query(
      "SELECT count(*)::int AS count FROM effective_permissions WHERE space_id=$1 AND subject_id='user-a'",
      [ids.child],
    );
    expect(stale.rows[0]?.count).toBe(0);
    await adapter.moveSpace(ids.child, ids.parent);
  });

  it('rolls back grant-derived rows with their transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO space_grants (id,space_id,subject_type,subject_id,effect,capability)
         VALUES (gen_random_uuid(),$1,'user','user-a','deny','read')`,
        [ids.child],
      );
      const denied = await client.query(
        "SELECT count(*)::int AS count FROM effective_permissions WHERE space_id=$1 AND subject_id='user-a'",
        [ids.child],
      );
      expect(denied.rows[0]?.count).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const restored = await pool.query(
      "SELECT count(*)::int AS count FROM effective_permissions WHERE space_id=$1 AND subject_id='user-a'",
      [ids.child],
    );
    expect(restored.rows[0]?.count).toBe(1);
  });

  it('contains no content-class tables', async () => {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('documents','nodes','edges','embeddings')`,
    );
    expect(result.rows[0]?.count).toBe(0);
  });
});

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessContextPolicy } from '../../src/storage/access-context.policy.js';
import { AgeGraphAdapter } from '../../src/storage/adapters/age/age-graph.adapter.js';
import { PgvectorVectorAdapter } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import { PostgresUnitOfWorkAdapter } from '../../src/storage/adapters/postgres/postgres-unit-of-work.adapter.js';
import { QueryExecutor } from '../../src/storage/adapters/postgres/query-executor.js';
import { RecursiveCteGraphAdapter } from '../../src/storage/adapters/postgres/recursive-cte-graph.adapter.js';
import type { AccessContext } from '../../src/storage/ports/access-context.js';
import { AccessDeniedError } from '../../src/storage/storage.errors.js';

const runtimeUrl = process.env.TEST_STORAGE_DATABASE_URL;
const adminUrl = process.env.TEST_STORAGE_ADMIN_DATABASE_URL;
const describeStorage = runtimeUrl && adminUrl ? describe : describe.skip;
const ids = {
  subject: '11111111-1111-4111-8111-111111111111',
  linked: '22222222-2222-4222-8222-222222222221',
  denied: '22222222-2222-4222-8222-222222222222',
  compartmented: '22222222-2222-4222-8222-222222222223',
  start: '33333333-3333-4333-8333-333333333331',
  allowed: '33333333-3333-4333-8333-333333333332',
  deniedNode: '33333333-3333-4333-8333-333333333333',
  compartmentedNode: '33333333-3333-4333-8333-333333333334',
  directEdge: '44444444-4444-4444-8444-444444444441',
  deniedEdge: '44444444-4444-4444-8444-444444444442',
  hiddenBridge: '44444444-4444-4444-8444-444444444443',
  forbiddenEdge: '44444444-4444-4444-8444-444444444444',
};
const context: AccessContext = {
  subjectId: ids.subject,
  level: 0,
  spaceGrants: { allow: [], deny: [] },
};
const vector = Array.from({ length: 1_024 }, (_, index) => (index === 0 ? 1 : 0));

describeStorage('storage adapters on disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: adminUrl });
  const runtime = new Pool({ connectionString: runtimeUrl });
  const executor = new QueryExecutor(runtime);
  const unit = new PostgresUnitOfWorkAdapter(runtime, executor);
  const policy = new AccessContextPolicy();
  const age = new AgeGraphAdapter(executor, policy, unit);
  const cte = new RecursiveCteGraphAdapter(executor, policy);
  const vectors = new PgvectorVectorAdapter(executor, policy, unit);

  beforeAll(async () => {
    await admin.query(
      `INSERT INTO knowledge_spaces (id, slug, name, parent_id, required_level, isolation_mode) VALUES
         ($1, 'it-linked', 'IT linked', '01981c60-0000-7000-8000-000000000001', 'public', 'linked'),
         ($2, 'it-denied', 'IT denied', '01981c60-0000-7000-8000-000000000001', 'holocron', 'linked'),
         ($3, 'it-compartmented', 'IT compartmented', '01981c60-0000-7000-8000-000000000001', 'public', 'compartmented')`,
      [ids.linked, ids.denied, ids.compartmented],
    );
    await admin.query(
      `INSERT INTO space_grants (id, space_id, subject_type, subject_id, effect, capability) VALUES
         (gen_random_uuid(), $1, 'user', $4, 'allow', 'read'),
         (gen_random_uuid(), $1, 'user', $4, 'allow', 'write'),
         (gen_random_uuid(), $2, 'user', $4, 'allow', 'write'),
         (gen_random_uuid(), $2, 'user', $4, 'deny', 'read'),
         (gen_random_uuid(), $3, 'user', $4, 'allow', 'read'),
         (gen_random_uuid(), $3, 'user', $4, 'allow', 'write')`,
      [ids.linked, ids.denied, ids.compartmented, ids.subject],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM space_grants WHERE subject_id = $1', [ids.subject]);
    await admin.query('DELETE FROM knowledge_spaces WHERE id = ANY($1::uuid[])', [
      [ids.linked, ids.denied, ids.compartmented],
    ]);
    await runtime.end();
    await admin.end();
  });

  it('keeps AGE, CTE, vector ACL, linked edges, and rollback semantics aligned', async () => {
    const rollback = new Error('integration rollback');
    await expect(unit.transaction(async () => {
      await age.upsertNode(context, { id: ids.start, spaceId: ids.linked });
      await age.upsertNode(context, { id: ids.allowed, spaceId: ids.linked });
      await age.upsertNode(context, { id: ids.deniedNode, spaceId: ids.denied });
      await age.upsertNode(context, { id: ids.compartmentedNode, spaceId: ids.compartmented });
      await age.upsertEdge(context, {
        id: ids.directEdge, spaceId: ids.linked, sourceNodeId: ids.start,
        targetNodeId: ids.allowed, edgeType: 'LINKS_TO',
      });
      await age.upsertEdge(context, {
        id: ids.deniedEdge, spaceId: ids.linked, sourceNodeId: ids.start,
        targetNodeId: ids.deniedNode, edgeType: 'LINKS_TO',
      });
      await age.upsertEdge(context, {
        id: ids.hiddenBridge, spaceId: ids.denied, sourceNodeId: ids.deniedNode,
        targetNodeId: ids.allowed, edgeType: 'LINKS_TO',
      });
      await expect(age.upsertEdge(context, {
        id: ids.forbiddenEdge, spaceId: ids.compartmented, sourceNodeId: ids.compartmentedNode,
        targetNodeId: ids.deniedNode, edgeType: 'LINKS_TO',
      })).rejects.toBeInstanceOf(AccessDeniedError);

      await vectors.upsert(context, ids.allowed, ids.linked, vector);
      const ageResult = await age.traverse(context, { startNodeId: ids.start, maxDepth: 2 });
      const cteResult = await cte.traverse(context, { startNodeId: ids.start, maxDepth: 2 });
      expect(ageResult).toEqual([{ id: ids.allowed, spaceId: ids.linked }]);
      expect(cteResult).toEqual(ageResult);
      await expect(vectors.search(context, { spaceId: ids.linked, values: vector, limit: 10 }))
        .resolves.toEqual([{ id: ids.allowed, spaceId: ids.linked, score: 1 }]);
      throw rollback;
    })).rejects.toBe(rollback);

    const counts = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM knowledge_nodes) AS nodes,
         (SELECT count(*)::int FROM knowledge_vectors) AS vectors,
         (SELECT count(*)::int FROM ag_catalog.cypher('wiki_arcana', $cypher$ MATCH (n:KnowledgeNode) RETURN n $cypher$)
           AS (n ag_catalog.agtype)) AS age_nodes`,
    );
    expect(counts.rows[0]).toEqual({ nodes: 0, vectors: 0, age_nodes: 0 });
  });

  it('loads AGE on a fresh backend after pool churn without API-side LOAD', async () => {
    const freshPool = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      const freshExecutor = new QueryExecutor(freshPool);
      const freshUnit = new PostgresUnitOfWorkAdapter(freshPool, freshExecutor);
      const freshAge = new AgeGraphAdapter(freshExecutor, policy, freshUnit);
      await expect(freshAge.traverse(context, { startNodeId: ids.start, maxDepth: 1 })).resolves.toEqual([]);
    } finally {
      await freshPool.end();
    }
  });
});

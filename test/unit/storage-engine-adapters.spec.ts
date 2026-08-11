import { describe, expect, it, vi } from 'vitest';
import { AccessContextPolicy } from '../../src/storage/access-context.policy.js';
import { AGE_TRAVERSAL_QUERIES, AgeGraphAdapter } from '../../src/storage/adapters/age/age-graph.adapter.js';
import { PgvectorVectorAdapter, VECTOR_SEARCH_SETTINGS } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import { RecursiveCteGraphAdapter } from '../../src/storage/adapters/postgres/recursive-cte-graph.adapter.js';
import type { QueryExecutor } from '../../src/storage/adapters/postgres/query-executor.js';
import type { AccessContext } from '../../src/storage/ports/access-context.js';
import { AccessDeniedError, InvalidStorageInputError } from '../../src/storage/storage.errors.js';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_NODE_ID = '44444444-4444-4444-8444-444444444444';
const vector = Array.from({ length: 1_024 }, (_, index) => index / 1_024);
const unitOfWork = { transaction: <T>(work: () => Promise<T>) => work() };

function context(capability: 'read' | 'write' | 'admin' = 'read'): AccessContext {
  return {
    subjectId: SUBJECT_ID,
    level: 10,
    spaceGrants: { allow: [{ spaceId: SPACE_ID, capability }], deny: [] },
  };
}

function executor(rows: readonly unknown[] = [], rowCount = rows.length) {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount }) } as unknown as QueryExecutor;
}

describe('storage engine adapters', () => {
  it('pins the measured v21 ANN execution settings', () => {
    expect(VECTOR_SEARCH_SETTINGS).toContain('SET LOCAL jit = off');
    expect(VECTOR_SEARCH_SETTINGS).toContain('SET LOCAL enable_sort = off');
    expect(VECTOR_SEARCH_SETTINGS).toContain('SET LOCAL hnsw.ef_search = 1');
    expect(VECTOR_SEARCH_SETTINGS).toContain('SET LOCAL ivfflat.probes = 100');
  });

  it('records the effective ANN v21 settings in benchmark evidence', async () => {
    const database = executor([{
      statementTimeout: '1500ms', jit: 'off', enableSort: 'off', efSearch: '1', iterativeScan: 'strict_order',
      maxScanTuples: '20000', scanMemMultiplier: '2', ivfflatProbes: '100',
    }]);
    const transaction = vi.fn((work: () => Promise<unknown>) => work());
    const observed = await new PgvectorVectorAdapter(database, new AccessContextPolicy(), { transaction } as never)
      .observeSearchSettings();

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), VECTOR_SEARCH_SETTINGS);
    const [statement] = vi.mocked(database.query).mock.calls[0]!;
    expect(statement).toContain("current_setting('jit')");
    expect(statement).toContain("current_setting('enable_sort')");
    expect(statement).toContain("current_setting('ivfflat.probes')");
    expect(observed.enableSort).toBe('off');
    expect(observed.jit).toBe('off');
    expect(observed.efSearch).toBe('1');
  });

  it('exposes exactly four static AGE depth templates without caller interpolation', async () => {
    expect(Object.keys(AGE_TRAVERSAL_QUERIES)).toEqual(['1', '2', '3', '4']);
    for (const [depth, query] of Object.entries(AGE_TRAVERSAL_QUERIES)) {
      expect(query).toContain(`*1..${depth}`);
      expect(query).toContain('MATCH path = (start:KnowledgeNode');
      expect(query).toContain('$startNodeId');
      expect(query).not.toContain('all(');
    }
    const database = executor([{ node_id: NODE_ID, space_id: SPACE_ID }]);
    const adapter = new AgeGraphAdapter(database, new AccessContextPolicy(), unitOfWork);
    await expect(adapter.traverse(context(), { startNodeId: NODE_ID, maxDepth: 2 }))
      .resolves.toEqual([{ id: NODE_ID, spaceId: SPACE_ID }]);
    const [statement, values] = vi.mocked(database.query).mock.calls[0]!;
    expect(statement).toContain(AGE_TRAVERSAL_QUERIES[2]);
    expect(statement).toContain('authorized_walk(node_id, depth, path)');
    expect(statement).toContain('JOIN authorized_walk ON authorized_walk.node_id = kn.id');
    expect(statement).toContain('JOIN access_levels');
    expect(statement).toContain('authorized_start');
    expect(statement).toContain('SELECT DISTINCT kn.id AS node_id');
    expect(statement).toContain('$5::ag_catalog.agtype');
    expect(statement).toContain('node_id ag_catalog.agtype, space_id ag_catalog.agtype');
    expect(statement).not.toContain('SET LOCAL jit');
    expect(statement).not.toMatch(/::agtype\b|\b(?:node_id|space_id)\s+agtype\b/);
    expect(JSON.stringify(values)).toContain(NODE_ID);
    expect(statement).not.toContain(NODE_ID);
    expect(Math.max(...[...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))).toBe(values?.length);
  });

  it('rejects invalid traversal before calling the database', async () => {
    const database = executor();
    const adapter = new AgeGraphAdapter(database, new AccessContextPolicy(), unitOfWork);
    await expect(adapter.traverse(context(), { startNodeId: NODE_ID, maxDepth: 5 }))
      .rejects.toBeInstanceOf(InvalidStorageInputError);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('uses the relational CTE as an ACL-bound semantic oracle', async () => {
    const database = executor();
    await new RecursiveCteGraphAdapter(database, new AccessContextPolicy())
      .traverse(context(), { startNodeId: NODE_ID, maxDepth: 4 });
    const [statement, values] = vi.mocked(database.query).mock.calls[0]!;
    expect(statement).toContain('WITH RECURSIVE');
    expect(statement).toContain('JOIN access_levels');
    expect(statement).toContain('NOT EXISTS');
    expect(statement.match(/JOIN access_levels/g)?.length).toBeGreaterThanOrEqual(2);
    expect(values).toContain(SUBJECT_ID);
  });

  it('keeps ACL filtering and ANN ordering in one vector statement', async () => {
    const database = executor();
    const transaction = vi.fn((work: () => Promise<unknown>) => work());
    await new PgvectorVectorAdapter(database, new AccessContextPolicy(), { transaction } as never).search(context(), {
      spaceId: SPACE_ID, values: vector, limit: 12, excludeNodeId: NODE_ID,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), VECTOR_SEARCH_SETTINGS);
    const [statement, values] = vi.mocked(database.query).mock.calls[0]!;
    expect(statement).toContain('JOIN access_levels');
    expect(statement).toContain('hnsw_candidates AS MATERIALIZED');
    expect(statement).toContain('knowledge_vector_projections');
    expect(statement).toContain('$4::halfvec(1024)');
    expect(statement).not.toContain("projection.embedding <=> $4::halfvec(1024)) + 0");
    expect(statement).toContain('candidate_ids');
    expect(statement).toContain('<=>');
    expect(statement).toContain('kv.node_id <>');
    expect(statement).toContain('LIMIT $');
    expect(values).toContain(SUBJECT_ID);
    expect(values).toContain(12);
    expect(values).toContain(NODE_ID);
    expect(values?.slice(-3)).toEqual([12, 10, 12]);
    expect(Math.max(...[...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))).toBe(values?.length);
  });

  it('captures an ANN plan without executing the measured query', async () => {
    const database = executor([{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan' } }] }]);
    const transaction = vi.fn((work: () => Promise<unknown>) => work());
    await new PgvectorVectorAdapter(database, new AccessContextPolicy(), { transaction } as never).explainSearch(context(), {
      spaceId: SPACE_ID, values: vector, limit: 10, excludeNodeId: NODE_ID,
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), VECTOR_SEARCH_SETTINGS);
    const [statement] = vi.mocked(database.query).mock.calls[0]!;
    expect(statement).toContain('EXPLAIN');
    expect(statement).toContain('FORMAT JSON');
    expect(statement).not.toContain('ANALYZE');
    expect(statement).not.toContain('BUFFERS');
  });

  it('rejects unauthorized writes before any query', async () => {
    const database = executor([], 0);
    const adapter = new PgvectorVectorAdapter(database, new AccessContextPolicy(), unitOfWork);
    await expect(adapter.upsert(context('write'), NODE_ID, SPACE_ID, vector))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(database.query).toHaveBeenCalledOnce();
    expect(vi.mocked(database.query).mock.calls[0]![0]).toContain('effective_permissions');
    expect(vi.mocked(database.query).mock.calls[0]![0]).toContain('pg_advisory_xact_lock');
  });

  it('writes relational and AGE node representations through the same executor', async () => {
    const database = executor([{ '?column?': 1 }], 1);
    vi.mocked(database.query)
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await new AgeGraphAdapter(database, new AccessContextPolicy(), unitOfWork)
      .upsertNode(context('write'), { id: OTHER_NODE_ID, spaceId: SPACE_ID });
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(vi.mocked(database.query).mock.calls[0]![0]).toContain('effective_permissions');
    expect(vi.mocked(database.query).mock.calls[1]![0]).toContain('FROM knowledge_nodes');
    expect(vi.mocked(database.query).mock.calls[2]![0]).toContain('INSERT INTO knowledge_nodes');
    expect(vi.mocked(database.query).mock.calls[3]![0]).toContain("cypher('wiki_arcana'");
    expect(vi.mocked(database.query).mock.calls[3]![0]).toContain('$1::ag_catalog.agtype');
    expect(vi.mocked(database.query).mock.calls[3]![0]).toContain('node ag_catalog.agtype');
  });

  it('rejects moving an existing node from another space before mutation', async () => {
    const database = executor();
    vi.mocked(database.query)
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ space_id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 } as never);
    const adapter = new AgeGraphAdapter(database, new AccessContextPolicy(), unitOfWork);

    await expect(adapter.upsertNode(context('write'), { id: NODE_ID, spaceId: SPACE_ID }))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(database.query).mock.calls.some(([sql]) => sql.includes('INSERT INTO knowledge_nodes'))).toBe(false);
  });

  it('does not trust a forged context allow as a database authorization source', async () => {
    const database = executor([], 0);
    const forged = context('write');
    await expect(new AgeGraphAdapter(database, new AccessContextPolicy(), unitOfWork)
      .upsertNode(forged, { id: NODE_ID, spaceId: SPACE_ID }))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(database.query).toHaveBeenCalledOnce();
    expect(vi.mocked(database.query).mock.calls[0]![0]).not.toContain('jsonb_to_recordset');
  });
});

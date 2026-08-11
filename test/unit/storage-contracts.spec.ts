import { describe, expect, it } from 'vitest';
import { AccessContextPolicy } from '../../src/storage/access-context.policy.js';
import { AgeGraphAdapter } from '../../src/storage/adapters/age/age-graph.adapter.js';
import { MemoryGraphAdapter } from '../../src/storage/adapters/memory/memory-graph.adapter.js';
import { PgvectorVectorAdapter } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import type { QueryExecutor } from '../../src/storage/adapters/postgres/query-executor.js';
import type { AccessContext } from '../../src/storage/ports/access-context.js';

const context: AccessContext = {
  subjectId: '11111111-1111-4111-8111-111111111111',
  level: 20,
  spaceGrants: { allow: [], deny: [] },
};

describe('engine-pure storage contracts', () => {
  it('requires a context and scopes memory graph reads', async () => {
    const adapter = new MemoryGraphAdapter();
    await adapter.upsertNode(context, { id: 'n1', spaceId: 's1' });
    await expect(adapter.getNode(context, 'n1')).resolves.toEqual({ id: 'n1', spaceId: 's1' });
  });

  it('activates graph and vector adapters behind the unchanged ports', () => {
    const executor = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as QueryExecutor;
    const unit = { transaction: <T>(work: () => Promise<T>) => work() };
    expect(new AgeGraphAdapter(executor, new AccessContextPolicy(), unit)).toBeInstanceOf(AgeGraphAdapter);
    expect(new PgvectorVectorAdapter(executor, new AccessContextPolicy(), unit)).toBeInstanceOf(PgvectorVectorAdapter);
  });
});

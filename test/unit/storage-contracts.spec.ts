import { describe, expect, it } from 'vitest';
import { AgeGraphAdapter } from '../../src/storage/adapters/age/age-graph.adapter.js';
import { MemoryGraphAdapter } from '../../src/storage/adapters/memory/memory-graph.adapter.js';
import { PgvectorVectorAdapter } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import { NotImplementedInPhaseOneError } from '../../src/storage/not-implemented-in-phase-one.error.js';
import type { AccessContext } from '../../src/storage/ports/access-context.js';

const context: AccessContext = {
  subjectId: 'user-1',
  level: 20,
  spaceGrants: { allow: [], deny: [] },
};

describe('engine-pure storage contracts', () => {
  it('requires a context and scopes memory graph reads', async () => {
    const adapter = new MemoryGraphAdapter();
    await adapter.upsertNode(context, { id: 'n1', spaceId: 's1' });
    await expect(adapter.getNode(context, 'n1')).resolves.toEqual({ id: 'n1', spaceId: 's1' });
  });

  it('keeps future graph and vector adapters inactive', async () => {
    await expect(new AgeGraphAdapter().getNode(context, 'n1')).rejects.toBeInstanceOf(NotImplementedInPhaseOneError);
    await expect(new PgvectorVectorAdapter().search(context, { spaceId: 's1', values: [1] }))
      .rejects.toBeInstanceOf(NotImplementedInPhaseOneError);
  });
});


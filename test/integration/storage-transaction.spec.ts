import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { VECTOR_SEARCH_SETTINGS } from '../../src/storage/adapters/pgvector/pgvector-vector.adapter.js';
import { PostgresUnitOfWorkAdapter } from '../../src/storage/adapters/postgres/postgres-unit-of-work.adapter.js';
import { QueryExecutor } from '../../src/storage/adapters/postgres/query-executor.js';

const runtimeUrl = process.env.TEST_STORAGE_DATABASE_URL;
const describeStorage = runtimeUrl ? describe : describe.skip;

describeStorage('storage transaction integration', () => {
  const pool = new Pool({ connectionString: runtimeUrl, max: 4 });
  const executor = new QueryExecutor(pool);
  const unit = new PostgresUnitOfWorkAdapter(pool, executor);

  it('uses distinct backends for concurrent top-level transactions', async () => {
    const backend = () => unit.transaction(async () => {
      const result = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await executor.query('SELECT pg_sleep(0.05)');
      return result.rows[0]!.pid;
    });
    const [first, second] = await Promise.all([backend(), backend()]);
    expect(first).not.toBe(second);
  });

  it('keeps ANN settings local to one real PostgreSQL transaction', async () => {
    const settingsPool = new Pool({ connectionString: runtimeUrl, max: 1 });
    const settingsExecutor = new QueryExecutor(settingsPool);
    const settingsUnit = new PostgresUnitOfWorkAdapter(settingsPool, settingsExecutor);
    const observe = () => settingsExecutor.query<{ pid: number; jit: string; efSearch: string }>(`
      SELECT pg_backend_pid() AS pid,
             current_setting('jit') AS jit,
             current_setting('hnsw.ef_search') AS "efSearch"
    `);

    try {
      const extension = await settingsExecutor.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      expect(extension.rows).toHaveLength(1);
      await settingsExecutor.query('SET jit = on; SET hnsw.ef_search = 40');
      const outsideBefore = await observe();
      const inside = await settingsUnit.transaction(async () => (await observe()).rows[0]!, VECTOR_SEARCH_SETTINGS);
      const outsideAfter = await observe();

      expect(outsideBefore.rows[0]).toMatchObject({ jit: 'on', efSearch: '40' });
      expect(inside).toEqual({ ...outsideBefore.rows[0], jit: 'off', efSearch: '1' });
      expect(outsideAfter.rows[0]).toEqual(outsideBefore.rows[0]);
    } finally {
      await settingsPool.end();
    }
  });

  it('rolls back an injected failure on the real executor path', async () => {
    const failure = new Error('real rollback');
    await expect(unit.transaction(async () => {
      await executor.query('SELECT 1');
      throw failure;
    })).rejects.toBe(failure);
    await expect(executor.query('SELECT 1 AS healthy')).resolves.toMatchObject({ rowCount: 1 });
  });
});

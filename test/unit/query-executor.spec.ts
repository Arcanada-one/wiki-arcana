import { describe, expect, it, vi } from 'vitest';
import { QueryExecutor } from '../../src/storage/adapters/postgres/query-executor.js';
import { PostgresUnitOfWorkAdapter } from '../../src/storage/adapters/postgres/postgres-unit-of-work.adapter.js';

function client(label: string) {
  return { label, query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
}

describe('PostgresUnitOfWorkAdapter', () => {
  it('releases the client without rolling back when BEGIN rejects', async () => {
    const first = client('first');
    const failure = new Error('begin failed');
    first.query.mockRejectedValueOnce(failure);
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(first) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);

    await expect(unit.transaction(async () => undefined)).rejects.toBe(failure);

    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    expect(first.release).toHaveBeenCalledOnce();
  });

  it('uses one client for an outer transaction and nested work', async () => {
    const first = client('first');
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(first) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);

    await unit.transaction(async () => {
      await executor.query('SELECT outer');
      await unit.transaction(() => executor.query('SELECT nested'));
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT outer', 'SELECT nested', 'COMMIT']);
    expect(first.release).toHaveBeenCalledOnce();
  });

  it('combines transaction-local planner settings with BEGIN in one round trip', async () => {
    const first = client('first');
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(first) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);

    await unit.transaction(() => executor.query('SELECT vector'), [
      'SET LOCAL hnsw.ef_search = 100',
      'SET LOCAL ivfflat.probes = 100',
    ]);

    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN;\nSET LOCAL hnsw.ef_search = 100;\nSET LOCAL ivfflat.probes = 100',
      'SELECT vector',
      'COMMIT',
    ]);
  });

  it('rolls back and releases when nested work fails', async () => {
    const first = client('first');
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(first) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);
    const failure = new Error('synthetic failure');

    await expect(unit.transaction(() => unit.transaction(async () => { throw failure; }))).rejects.toBe(failure);
    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(first.release).toHaveBeenCalledOnce();
  });

  it('cannot commit after a nested failure was caught by outer work', async () => {
    const first = client('first');
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(first) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);
    const failure = new Error('nested failure');

    await expect(unit.transaction(async () => {
      await unit.transaction(async () => { throw failure; }).catch(() => undefined);
    })).rejects.toBe(failure);
    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('allocates distinct clients to concurrent top-level transactions', async () => {
    const first = client('first');
    const second = client('second');
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const executor = new QueryExecutor(pool as never);
    const unit = new PostgresUnitOfWorkAdapter(pool as never, executor);
    let releaseFirst!: () => void;
    const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const a = unit.transaction(async () => { await executor.query('SELECT a'); await wait; });
    const b = unit.transaction(async () => { await executor.query('SELECT b'); releaseFirst(); });
    await Promise.all([a, b]);

    expect(first.query).toHaveBeenCalledWith('SELECT a', undefined);
    expect(second.query).toHaveBeenCalledWith('SELECT b', undefined);
  });
});

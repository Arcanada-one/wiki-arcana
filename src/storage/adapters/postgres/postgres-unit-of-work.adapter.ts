import type { Pool } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import { QueryExecutor } from './query-executor.js';

export class PostgresUnitOfWorkAdapter implements UnitOfWorkPort {
  private readonly transactionState = new AsyncLocalStorage<{ failure?: unknown; settings: Set<string> }>();
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly executor: QueryExecutor,
  ) {}

  async transaction<T>(work: () => Promise<T>, settings: readonly string[] = []): Promise<T> {
    const active = this.transactionState.getStore();
    if (active) {
      try {
        const pending = settings.filter((setting) => !active.settings.has(setting));
        if (pending.length > 0) {
          await this.executor.query(pending.join(';\n'));
          pending.forEach((setting) => active.settings.add(setting));
        }
        return await work();
      } catch (error) {
        active.failure ??= error;
        throw error;
      }
    }

    const client = await this.pool.connect();
    const state: { failure?: unknown; settings: Set<string> } = { settings: new Set(settings) };
    return this.transactionState.run(state, () => this.executor.withClient(client, async () => {
        let began = false;
        try {
          const beginSql = ['BEGIN', ...settings].join(';\n');
          if (settings.length > 0) began = true;
          await client.query(beginSql);
          began = true;
          const result = await work();
          if (state.failure) throw state.failure;
          await client.query('COMMIT');
          return result;
        } catch (error) {
          if (began) await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }));
  }
}

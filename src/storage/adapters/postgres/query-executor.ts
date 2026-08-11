import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

type QueryTarget = Pick<Pool | PoolClient, 'query'>;

export class QueryExecutor {
  private readonly clients = new AsyncLocalStorage<PoolClient>();

  constructor(private readonly pool: QueryTarget) {}

  query<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const target = this.clients.getStore() ?? this.pool;
    return target.query<Row>(statement, values as unknown[] | undefined);
  }

  currentClient(): PoolClient | undefined {
    return this.clients.getStore();
  }

  withClient<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
    return this.clients.run(client, work);
  }
}

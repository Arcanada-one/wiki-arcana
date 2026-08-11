import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { AppConfig } from '../config/env.schema.js';
import { AgeGraphAdapter } from './adapters/age/age-graph.adapter.js';
import { PgvectorVectorAdapter } from './adapters/pgvector/pgvector-vector.adapter.js';
import { PostgresUnitOfWorkAdapter } from './adapters/postgres/postgres-unit-of-work.adapter.js';
import { QueryExecutor } from './adapters/postgres/query-executor.js';
import { POSTGRES_SESSION_OPTIONS } from './adapters/postgres/postgres-session.options.js';
import { RecursiveCteGraphAdapter } from './adapters/postgres/recursive-cte-graph.adapter.js';
import { AccessContextPolicy } from './access-context.policy.js';
import {
  GRAPH_PORT,
  STORAGE_POOL,
  STORAGE_QUERY_EXECUTOR,
  UNIT_OF_WORK_PORT,
  VECTOR_PORT,
} from './storage.tokens.js';

export function createStoragePool(configuration: AppConfig): Pool {
  return new Pool({
    connectionString: configuration.STORAGE_DATABASE_URL,
    max: configuration.STORAGE_POOL_MAX,
    connectionTimeoutMillis: configuration.STORAGE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: configuration.STORAGE_IDLE_TIMEOUT_MS,
    statement_timeout: configuration.STORAGE_STATEMENT_TIMEOUT_MS,
    options: POSTGRES_SESSION_OPTIONS,
    application_name: 'wiki-arcana-api',
  });
}

@Injectable()
export class StoragePoolLifecycle implements OnApplicationShutdown {
  private closePromise: Promise<void> | undefined;

  constructor(@Inject(STORAGE_POOL) private readonly pool: Pool) {}

  onApplicationShutdown(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }
}

@Module({})
export class StorageModule {
  static register(configuration: AppConfig): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        { provide: STORAGE_POOL, useFactory: () => createStoragePool(configuration) },
        StoragePoolLifecycle,
        AccessContextPolicy,
        {
          provide: STORAGE_QUERY_EXECUTOR,
          useFactory: (pool: Pool) => new QueryExecutor(pool),
          inject: [STORAGE_POOL],
        },
        {
          provide: UNIT_OF_WORK_PORT,
          useFactory: (pool: Pool, executor: QueryExecutor) => new PostgresUnitOfWorkAdapter(pool, executor),
          inject: [STORAGE_POOL, STORAGE_QUERY_EXECUTOR],
        },
        {
          provide: AgeGraphAdapter,
          useFactory: (executor: QueryExecutor, policy: AccessContextPolicy, unit: PostgresUnitOfWorkAdapter) =>
            new AgeGraphAdapter(executor, policy, unit),
          inject: [STORAGE_QUERY_EXECUTOR, AccessContextPolicy, UNIT_OF_WORK_PORT],
        },
        {
          provide: PgvectorVectorAdapter,
          useFactory: (executor: QueryExecutor, policy: AccessContextPolicy, unit: PostgresUnitOfWorkAdapter) =>
            new PgvectorVectorAdapter(executor, policy, unit),
          inject: [STORAGE_QUERY_EXECUTOR, AccessContextPolicy, UNIT_OF_WORK_PORT],
        },
        {
          provide: RecursiveCteGraphAdapter,
          useFactory: (executor: QueryExecutor, policy: AccessContextPolicy) =>
            new RecursiveCteGraphAdapter(executor, policy),
          inject: [STORAGE_QUERY_EXECUTOR, AccessContextPolicy],
        },
        { provide: GRAPH_PORT, useExisting: AgeGraphAdapter },
        { provide: VECTOR_PORT, useExisting: PgvectorVectorAdapter },
      ],
      exports: [GRAPH_PORT, VECTOR_PORT, UNIT_OF_WORK_PORT, RecursiveCteGraphAdapter],
    };
  }
}

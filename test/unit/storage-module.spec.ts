import type { DynamicModule, Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/env.schema.js';
import { StorageModule, StoragePoolLifecycle, createStoragePool } from '../../src/storage/storage.module.js';
import { GRAPH_PORT, VECTOR_PORT } from '../../src/storage/storage.tokens.js';

const configuration = AppConfigSchema.parse({
  AUTH_ISSUER_URL: 'https://auth.example.com',
  AUTH_AUDIENCE: 'https://wiki.example.com',
  AUTH_JWKS_URL: 'https://auth.example.com/oidc/jwks',
  SCRUTATOR_API_URL: 'https://search.example.com',
  SCRUTATOR_EMBEDDING_URL: 'https://embedding.example.com',
  LTM_API_URL: 'https://memory.example.com',
  STORAGE_DATABASE_URL: 'postgresql://wiki_runtime:runtime-secret@db.example.com:5432/wiki',
});

describe('StorageModule', () => {
  it('exports engine-neutral graph and vector tokens', () => {
    const definition: DynamicModule = StorageModule.register(configuration);
    expect(definition.exports).toEqual(expect.arrayContaining([GRAPH_PORT, VECTOR_PORT]));
    expect(definition.providers).toEqual(expect.any(Array<Provider>));
  });

  it('constructs the API pool with only the least-privilege runtime URL and bounded settings', async () => {
    const pool = createStoragePool(configuration);
    expect(pool.options.connectionString).toBe(configuration.STORAGE_DATABASE_URL);
    expect(configuration).not.toHaveProperty('STORAGE_ADMIN_DATABASE_URL');
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(1_500);
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
    expect(pool.options.options).toBe('-c jit=off');
    await pool.end();
  });

  it('closes its pool once during application shutdown', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new StoragePoolLifecycle({ end } as unknown as Pool);
    await Promise.all([lifecycle.onApplicationShutdown(), lifecycle.onApplicationShutdown()]);
    expect(end).toHaveBeenCalledOnce();
  });
});

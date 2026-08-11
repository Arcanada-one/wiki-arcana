import { describe, expect, it } from 'vitest';
import { AppConfigSchema, StorageAdminConfigSchema } from '../../src/config/env.schema.js';

const validEnvironment = {
  AUTH_ISSUER_URL: 'https://auth.arcanada.one',
  AUTH_AUDIENCE: 'https://api.arcanada.wiki',
  AUTH_JWKS_URL: 'https://auth.arcanada.one/oidc/jwks',
  SCRUTATOR_API_URL: 'https://search.internal.example',
  SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
  LTM_API_URL: 'https://memory.internal.example',
  STORAGE_DATABASE_URL: 'postgresql://wiki_runtime:runtime-secret@db.example.internal:5432/wiki',
};

describe('application configuration', () => {
  it('accepts the canonical loopback and OIDC configuration', () => {
    const config = AppConfigSchema.parse(validEnvironment);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.AUTH_AUDIENCE).toBe('https://api.arcanada.wiki');
  });

  it.each(['AUTH_ISSUER_URL', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'] as const)(
    'rejects a missing %s',
    (field) => {
      const environment = { ...validEnvironment };
      delete environment[field];
      expect(() => AppConfigSchema.parse(environment)).toThrow();
    },
  );

  it('rejects non-HTTPS issuer, audience, and JWKS URLs', () => {
    for (const field of ['AUTH_ISSUER_URL', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'] as const) {
      expect(() => AppConfigSchema.parse({ ...validEnvironment, [field]: 'http://auth.invalid' })).toThrow();
    }
  });

  it('requires the JWKS URL to share the issuer origin', () => {
    expect(() => AppConfigSchema.parse({
      ...validEnvironment,
      AUTH_JWKS_URL: 'https://attacker.invalid/jwks',
    })).toThrow();
  });

  it('keeps the offline admin URL outside the runtime configuration object', () => {
    const config = AppConfigSchema.parse({
      ...validEnvironment,
      STORAGE_ADMIN_DATABASE_URL: 'postgresql://wiki_admin:admin-secret@db.example.internal:5432/wiki',
    });
    expect(config).not.toHaveProperty('STORAGE_ADMIN_DATABASE_URL');
    expect(() => AppConfigSchema.parse({
      ...validEnvironment,
      STORAGE_DATABASE_URL: 'https://db.example.internal/wiki',
    })).toThrow();
  });

  it('requires separate canonically decoded roles in offline migration configuration', () => {
    const runtime = validEnvironment.STORAGE_DATABASE_URL;
    expect(() => StorageAdminConfigSchema.parse({
      STORAGE_DATABASE_URL: runtime,
      STORAGE_ADMIN_DATABASE_URL: runtime,
    })).toThrow();
    expect(() => StorageAdminConfigSchema.parse({
      STORAGE_DATABASE_URL: 'postgresql://wiki%5Fruntime:runtime-secret@db.example.internal:5432/wiki',
      STORAGE_ADMIN_DATABASE_URL: 'postgresql://wiki_runtime:admin-secret@db.example.internal:5432/wiki',
    })).toThrow();
    expect(StorageAdminConfigSchema.safeParse({
      STORAGE_DATABASE_URL: 'not a URL',
      STORAGE_ADMIN_DATABASE_URL: 'also not a URL',
    }).success).toBe(false);
  });

  it('validates storage pool and timeout bounds', () => {
    expect(() => AppConfigSchema.parse({ ...validEnvironment, STORAGE_POOL_MAX: 0 })).toThrow();
    expect(() => AppConfigSchema.parse({ ...validEnvironment, STORAGE_CONNECTION_TIMEOUT_MS: 99 })).toThrow();
    expect(() => AppConfigSchema.parse({ ...validEnvironment, STORAGE_IDLE_TIMEOUT_MS: 999 })).toThrow();
    expect(() => AppConfigSchema.parse({ ...validEnvironment, STORAGE_STATEMENT_TIMEOUT_MS: 99 })).toThrow();
  });
});

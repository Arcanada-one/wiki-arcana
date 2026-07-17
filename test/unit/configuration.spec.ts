import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config/env.schema.js';

const validEnvironment = {
  AUTH_ISSUER_URL: 'https://auth.arcanada.one',
  AUTH_AUDIENCE: 'https://api.arcanada.wiki',
  AUTH_JWKS_URL: 'https://auth.arcanada.one/oidc/jwks',
  SCRUTATOR_API_URL: 'https://search.internal.example',
  SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
  LTM_API_URL: 'https://memory.internal.example',
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
});

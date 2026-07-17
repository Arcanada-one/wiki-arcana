import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config/env.schema.js';
import { HealthController } from '../../src/health/health.controller.js';

describe('server baseline', () => {
  it('binds to loopback on the allocated port by default', () => {
    const config = AppConfigSchema.parse({
      AUTH_ISSUER_URL: 'https://auth.arcanada.one',
      AUTH_AUDIENCE: 'https://api.arcanada.wiki',
      AUTH_JWKS_URL: 'https://auth.arcanada.one/oidc/jwks',
      SCRUTATOR_API_URL: 'https://search.internal.example',
      SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
      LTM_API_URL: 'https://memory.internal.example',
    });
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.PORT).toBe(4110);
  });

  it('rejects a non-loopback bind', () => {
    expect(() => AppConfigSchema.parse({
      HOST: '0.0.0.0',
      AUTH_ISSUER_URL: 'https://auth.arcanada.one',
      AUTH_AUDIENCE: 'https://api.arcanada.wiki',
      AUTH_JWKS_URL: 'https://auth.arcanada.one/oidc/jwks',
      SCRUTATOR_API_URL: 'https://search.internal.example',
      SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
      LTM_API_URL: 'https://memory.internal.example',
    })).toThrow();
  });

  it('returns stable health and version payloads', () => {
    const controller = new HealthController();
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(controller.version()).toEqual({ service: 'wiki-arcana', version: '0.1.0' });
  });
});

import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createWikiApplication } from '../../src/bootstrap.js';
import { OidcTokenVerifier } from '../../src/auth/oidc-token-verifier.js';

const issuer = 'https://auth.arcanada.one';
const audience = 'https://api.arcanada.wiki';
let app: NestFastifyApplication;
let token: string;

beforeAll(async () => {
  const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const publicJwk = await exportJWK(keyPair.publicKey);
  const verifier = new OidcTokenVerifier(
    { issuer, audience },
    createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'fixture-key', alg: 'EdDSA', use: 'sig' }] }),
  );
  token = await new SignJWT({ wiki_level: 'archivist', scope: 'wiki.read wiki.write' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'fixture-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('fixture-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keyPair.privateKey);
  app = await createWikiApplication({
    environment: {
      AUTH_ISSUER_URL: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `${issuer}/oidc/jwks`,
      SCRUTATOR_API_URL: 'https://search.internal.example',
      SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
      LTM_API_URL: 'https://memory.internal.example',
    },
    tokenVerifier: verifier,
  });
});

afterAll(async () => app.close());

describe('public and guarded HTTP routes', () => {
  it.each(['/health', '/version'])('returns 200 for public route %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
  });

  it('returns 401 without bearer on /v1/whoami', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 and Auth claims with an authorized fixture token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sub: 'fixture-user',
      wiki_level: 'archivist',
      scopes: ['wiki.read', 'wiki.write'],
    });
  });
});

import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  OidcTokenVerifier,
  hasRequiredAccess,
  type AuthPrincipal,
} from '../../src/auth/oidc-token-verifier.js';

const issuer = 'https://auth.arcanada.one';
const audience = 'https://api.arcanada.wiki';
let verifier: OidcTokenVerifier;
let privateKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  verifier = new OidcTokenVerifier(
    { issuer, audience },
    createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'fixture-key', alg: 'EdDSA', use: 'sig' }] }),
  );
});

async function sign(claims: Record<string, unknown>, overrides: { issuer?: string; audience?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'fixture-key' })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject('fixture-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('Auth Arcana OIDC token verifier', () => {
  it('accepts a correctly signed Auth-shaped token and extracts claims', async () => {
    const principal = await verifier.verify(await sign({ wiki_level: 'archivist', scope: 'wiki.read wiki.write' }));
    expect(principal).toEqual({
      subject: 'fixture-user',
      wikiLevel: 'archivist',
      scopes: ['wiki.read', 'wiki.write'],
    });
  });

  it('rejects issuer and audience mismatches', async () => {
    await expect(verifier.verify(await sign({ wiki_level: 'public', scope: 'wiki.read' }, { issuer: 'https://evil.invalid' }))).rejects.toThrow();
    await expect(verifier.verify(await sign({ wiki_level: 'public', scope: 'wiki.read' }, { audience: 'https://other.invalid' }))).rejects.toThrow();
  });

  it('rejects missing or unknown wiki_level and missing wiki scopes', async () => {
    await expect(verifier.verify(await sign({ scope: 'wiki.read' }))).rejects.toThrow();
    await expect(verifier.verify(await sign({ wiki_level: 'unknown', scope: 'wiki.read' }))).rejects.toThrow();
    await expect(verifier.verify(await sign({ wiki_level: 'public', scope: 'openid' }))).rejects.toThrow();
  });

  it('enforces scope, clearance, and explicit deny with deny winning', () => {
    const principal: AuthPrincipal = {
      subject: 'fixture-user',
      wikiLevel: 'council',
      scopes: ['wiki.read', 'wiki.write'],
    };
    expect(hasRequiredAccess(principal, 'wiki.read', 'archivist', false)).toBe(true);
    expect(hasRequiredAccess(principal, 'wiki.admin', 'public', false)).toBe(false);
    expect(hasRequiredAccess(principal, 'wiki.read', 'holocron', false)).toBe(false);
    expect(hasRequiredAccess(principal, 'wiki.read', 'public', true)).toBe(false);
  });
});

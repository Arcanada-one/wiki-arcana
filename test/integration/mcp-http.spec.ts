import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createWikiApplication } from '../../src/bootstrap.js';
import { OidcTokenVerifier } from '../../src/auth/oidc-token-verifier.js';

const issuer = 'https://auth.arcanada.one';
const audience = 'https://api.arcanada.wiki';
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wiki-test', version: '1.0.0' },
  },
};
let app: NestFastifyApplication;
let authorizedToken: string;
let wrongAudienceToken: string;

beforeAll(async () => {
  const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const publicJwk = await exportJWK(keyPair.publicKey);
  const verifier = new OidcTokenVerifier(
    { issuer, audience },
    createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'fixture-key', alg: 'EdDSA', use: 'sig' }] }),
  );
  const token = (targetAudience: string) => new SignJWT({ wiki_level: 'archivist', scope: 'wiki.read' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'fixture-key' })
    .setIssuer(issuer)
    .setAudience(targetAudience)
    .setSubject('fixture-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keyPair.privateKey);
  [authorizedToken, wrongAudienceToken] = await Promise.all([token(audience), token('https://other.invalid')]);
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

async function mcp(body: object, token = authorizedToken, protocolVersion = '2025-06-18') {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion,
    },
    payload: body,
  });
}

describe('MCP Streamable HTTP skeleton', () => {
  it('returns 401 without bearer', async () => {
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: initialize });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a bearer for the wrong resource audience', async () => {
    const response = await mcp(initialize, wrongAudienceToken);
    expect(response.statusCode).toBe(401);
  });

  it('negotiates a supported protocol version in JSON response mode', async () => {
    const response = await mcp(initialize);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().result.protocolVersion).toBe('2025-06-18');
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  it('rejects an unsupported protocol-version header', async () => {
    const response = await mcp(initialize, authorizedToken, '1900-01-01');
    expect(response.statusCode).toBe(400);
  });

  it('lists exactly the two Phase-1 tools', async () => {
    const response = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'wiki_ping',
      'wiki_spaces_list',
    ]);
  });

  it('executes a scoped skeleton tool with a valid principal', async () => {
    const response = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wiki_spaces_list', arguments: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent.spaces).toEqual([
      { slug: 'arcanada', required_level: 'public' },
    ]);
  });

  it('publishes RFC 9728 protected-resource metadata', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ['wiki.read', 'wiki.write', 'wiki.admin'],
      bearer_methods_supported: ['header'],
    });
  });

  it('rejects bodies over the configured 64 KiB limit', async () => {
    const response = await mcp({ ...initialize, padding: 'x'.repeat(70_000) });
    expect(response.statusCode).toBe(413);
  });
});

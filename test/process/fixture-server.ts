import { chmod, writeFile } from 'node:fs/promises';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWikiApplication } from '../../src/bootstrap.js';
import { OidcTokenVerifier } from '../../src/auth/oidc-token-verifier.js';

const issuer = 'https://auth.arcanada.one';
const audience = 'https://api.arcanada.wiki';
const port = Number(process.env.WIKI_FIXTURE_PORT ?? '4110');
const tokenFile = process.env.WIKI_FIXTURE_TOKEN_FILE;
if (!tokenFile) throw new Error('WIKI_FIXTURE_TOKEN_FILE is required');

const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const publicJwk = await exportJWK(keyPair.publicKey);
const verifier = new OidcTokenVerifier(
  { issuer, audience },
  createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'process-fixture', alg: 'EdDSA', use: 'sig' }] }),
);
const token = await new SignJWT({ wiki_level: 'archivist', scope: 'wiki.read wiki.write' })
  .setProtectedHeader({ alg: 'EdDSA', kid: 'process-fixture' })
  .setIssuer(issuer)
  .setAudience(audience)
  .setSubject('process-fixture-user')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(keyPair.privateKey);
await writeFile(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
await chmod(tokenFile, 0o600);

const app = await createWikiApplication({
  environment: {
    HOST: '127.0.0.1',
    PORT: String(port),
    AUTH_ISSUER_URL: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/oidc/jwks`,
    SCRUTATOR_API_URL: 'https://search.internal.example',
    SCRUTATOR_EMBEDDING_URL: 'https://embedding.internal.example',
    LTM_API_URL: 'https://memory.internal.example',
  },
  tokenVerifier: verifier,
});
await app.listen(port, '127.0.0.1');
process.stdout.write(`READY http://127.0.0.1:${port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().finally(() => process.exit(0)));
}

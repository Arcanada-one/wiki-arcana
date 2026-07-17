import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { ACCESS_LEVELS, type AccessLevelSlug } from '../rbac/rbac.service.js';

export type WikiScope = 'wiki.read' | 'wiki.write' | 'wiki.admin';

export interface AuthPrincipal {
  subject: string;
  wikiLevel: AccessLevelSlug;
  scopes: WikiScope[];
}

export interface OidcVerifierConfiguration {
  issuer: string;
  audience: string;
  jwksUrl?: string;
}

export class OidcTokenVerifier {
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(
    private readonly configuration: OidcVerifierConfiguration,
    keyResolver?: JWTVerifyGetKey,
  ) {
    if (!keyResolver && !configuration.jwksUrl) {
      throw new Error('A JWKS URL or key resolver is required');
    }
    this.keyResolver = keyResolver ?? createRemoteJWKSet(new URL(configuration.jwksUrl!));
  }

  async verify(token: string): Promise<AuthPrincipal> {
    const result = await jwtVerify(token, this.keyResolver, {
      issuer: this.configuration.issuer,
      audience: this.configuration.audience,
      algorithms: ['EdDSA', 'ES256', 'RS256'],
    });
    return parsePrincipal(result.payload);
  }
}

function parsePrincipal(payload: JWTPayload): AuthPrincipal {
  if (!payload.sub) throw new Error('OIDC token has no subject');
  if (!isAccessLevel(payload.wiki_level)) throw new Error('OIDC token has an invalid wiki_level');
  const scopes = parseScopes(payload.scope);
  if (scopes.length === 0) throw new Error('OIDC token has no Wiki Arcana scope');
  return { subject: payload.sub, wikiLevel: payload.wiki_level, scopes };
}

function parseScopes(scope: unknown): WikiScope[] {
  if (typeof scope !== 'string') return [];
  return scope.split(/\s+/).filter(isWikiScope);
}

function isWikiScope(scope: string): scope is WikiScope {
  return scope === 'wiki.read' || scope === 'wiki.write' || scope === 'wiki.admin';
}

function isAccessLevel(level: unknown): level is AccessLevelSlug {
  return typeof level === 'string' && Object.hasOwn(ACCESS_LEVELS, level);
}

export function hasRequiredAccess(
  principal: AuthPrincipal,
  scope: WikiScope,
  requiredLevel: AccessLevelSlug,
  explicitDeny: boolean,
): boolean {
  if (explicitDeny || !principal.scopes.includes(scope)) return false;
  return ACCESS_LEVELS[principal.wikiLevel] >= ACCESS_LEVELS[requiredLevel];
}

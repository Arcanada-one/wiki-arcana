import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { OIDC_TOKEN_VERIFIER } from './auth.constants.js';
import { hasRequiredAccess, type AuthPrincipal, type OidcTokenVerifier } from './oidc-token-verifier.js';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  authPrincipal?: AuthPrincipal;
}

@Injectable()
export class WikiAuthGuard implements CanActivate {
  constructor(@Inject(OIDC_TOKEN_VERIFIER) private readonly verifier: OidcTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer authentication required');

    try {
      const principal = await this.verifier.verify(token);
      if (!hasRequiredAccess(principal, 'wiki.read', 'public', false)) {
        throw new ForbiddenException('wiki.read scope required');
      }
      request.authPrincipal = principal;
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException('Invalid bearer token');
    }
  }
}

function extractBearer(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}

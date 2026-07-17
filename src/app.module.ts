import { DynamicModule, Module } from '@nestjs/common';
import { OIDC_TOKEN_VERIFIER } from './auth/auth.constants.js';
import { OidcTokenVerifier } from './auth/oidc-token-verifier.js';
import { WhoamiController } from './auth/whoami.controller.js';
import { WikiAuthGuard } from './auth/wiki-auth.guard.js';
import type { AppConfig } from './config/env.schema.js';
import { APP_CONFIG } from './config/config.constants.js';
import { HealthController } from './health/health.controller.js';
import { McpController } from './mcp/mcp.controller.js';
import { McpRateLimiter } from './mcp/mcp-rate-limiter.js';
import { ProtectedResourceController } from './mcp/protected-resource.controller.js';

@Module({})
export class AppModule {
  static register(configuration: AppConfig, tokenVerifier?: OidcTokenVerifier): DynamicModule {
    const verifier = tokenVerifier ?? new OidcTokenVerifier({
      issuer: configuration.AUTH_ISSUER_URL,
      audience: configuration.AUTH_AUDIENCE,
      jwksUrl: configuration.AUTH_JWKS_URL,
    });
    return {
      module: AppModule,
      controllers: [HealthController, WhoamiController, McpController, ProtectedResourceController],
      providers: [
        WikiAuthGuard,
        McpRateLimiter,
        { provide: APP_CONFIG, useValue: configuration },
        { provide: OIDC_TOKEN_VERIFIER, useValue: verifier },
      ],
    };
  }
}

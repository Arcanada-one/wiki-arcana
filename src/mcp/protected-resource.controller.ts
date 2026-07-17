import { Controller, Get, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.schema.js';

@Controller('.well-known')
export class ProtectedResourceController {
  constructor(@Inject(APP_CONFIG) private readonly configuration: AppConfig) {}

  @Get('oauth-protected-resource')
  metadata(): Record<string, unknown> {
    return {
      resource: this.configuration.AUTH_AUDIENCE,
      authorization_servers: [this.configuration.AUTH_ISSUER_URL],
      scopes_supported: ['wiki.read', 'wiki.write', 'wiki.admin'],
      bearer_methods_supported: ['header'],
    };
  }
}

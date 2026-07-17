import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from './wiki-auth.guard.js';
import { WikiAuthGuard } from './wiki-auth.guard.js';

@Controller('v1')
@UseGuards(WikiAuthGuard)
export class WhoamiController {
  @Get('whoami')
  whoami(@Req() request: AuthenticatedRequest): { sub: string; wiki_level: string; scopes: string[] } {
    const principal = request.authPrincipal;
    if (!principal) throw new Error('Auth guard did not attach a principal');
    return {
      sub: principal.subject,
      wiki_level: principal.wikiLevel,
      scopes: principal.scopes,
    };
  }
}

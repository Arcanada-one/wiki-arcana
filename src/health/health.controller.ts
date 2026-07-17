import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('version')
  version(): { service: 'wiki-arcana'; version: '0.1.0' } {
    return { service: 'wiki-arcana', version: '0.1.0' };
  }
}


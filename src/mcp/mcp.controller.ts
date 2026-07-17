import { BadRequestException, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../auth/wiki-auth.guard.js';
import { WikiAuthGuard } from '../auth/wiki-auth.guard.js';
import { createMcpRequestServer } from './mcp-server.factory.js';
import { McpRateLimiter } from './mcp-rate-limiter.js';

type AuthenticatedFastifyRequest = FastifyRequest & AuthenticatedRequest;

@Controller('mcp')
@UseGuards(WikiAuthGuard)
export class McpController {
  constructor(@Inject(McpRateLimiter) private readonly rateLimiter: McpRateLimiter) {}

  @Post()
  async handle(@Req() request: AuthenticatedFastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const principal = request.authPrincipal;
    if (!principal) throw new Error('Auth guard did not attach a principal');
    assertProtocolVersion(request.headers['mcp-protocol-version']);
    this.rateLimiter.consume(principal.subject);
    const { server, transport } = createMcpRequestServer({ principal });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await server.close();
    }
  }
}

function assertProtocolVersion(value: string | string[] | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(value)) {
    throw new BadRequestException('Unsupported MCP protocol version');
  }
}

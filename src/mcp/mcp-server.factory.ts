import { ForbiddenException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { hasRequiredAccess, type AuthPrincipal, type WikiScope } from '../auth/oidc-token-verifier.js';
import type { AccessLevelSlug } from '../rbac/rbac.service.js';

export const MCP_TRANSPORT_OPTIONS: StreamableHTTPServerTransportOptions = {
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
};

export interface McpRequestResources {
  principal: AuthPrincipal;
  explicitDeny?: boolean;
}

export function createMcpRequestServer(resources: McpRequestResources): {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
} {
  const server = new McpServer({ name: 'wiki-arcana', version: '0.1.0' });
  server.registerTool('wiki_ping', {
    description: 'Report the Wiki Arcana skeleton version.',
    inputSchema: { echo: z.string().max(128).optional() },
    outputSchema: { version: z.string(), echo: z.string().optional() },
  }, async ({ echo }) => {
    authorizeMcpTool(resources.principal, 'wiki.read', 'public', resources.explicitDeny ?? false);
    const structuredContent = { version: '0.1.0', ...(echo === undefined ? {} : { echo }) };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  });
  server.registerTool('wiki_spaces_list', {
    description: 'List Phase-1 knowledge spaces visible to the authenticated principal.',
    inputSchema: {},
    outputSchema: {
      spaces: z.array(z.object({ slug: z.string(), required_level: z.string() })),
    },
  }, async () => {
    authorizeMcpTool(resources.principal, 'wiki.read', 'public', resources.explicitDeny ?? false);
    const structuredContent = { spaces: [{ slug: 'arcanada', required_level: 'public' }] };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  });
  return { server, transport: new StreamableHTTPServerTransport(MCP_TRANSPORT_OPTIONS) };
}

export function authorizeMcpTool(
  principal: AuthPrincipal,
  scope: WikiScope,
  requiredLevel: AccessLevelSlug,
  explicitDeny: boolean,
): void {
  if (explicitDeny) throw new ForbiddenException('MCP tool access explicitly denied');
  if (!principal.scopes.includes(scope)) throw new ForbiddenException(`MCP tool requires ${scope} scope`);
  if (!hasRequiredAccess(principal, scope, requiredLevel, false)) {
    throw new ForbiddenException(`MCP tool requires ${requiredLevel} clearance`);
  }
}

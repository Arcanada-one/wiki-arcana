import { describe, expect, it } from 'vitest';
import { authorizeMcpTool, MCP_TRANSPORT_OPTIONS } from '../../src/mcp/mcp-server.factory.js';
import type { AuthPrincipal } from '../../src/auth/oidc-token-verifier.js';

const councilReader: AuthPrincipal = {
  subject: 'council-reader',
  wikiLevel: 'council',
  scopes: ['wiki.read'],
};

describe('MCP per-tool security', () => {
  it('is explicitly stateless and uses JSON response mode', () => {
    expect(MCP_TRANSPORT_OPTIONS).toEqual({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
  });

  it('authorizes the required scope and level inside each tool handler', () => {
    expect(() => authorizeMcpTool(councilReader, 'wiki.read', 'public', false)).not.toThrow();
    expect(() => authorizeMcpTool(councilReader, 'wiki.admin', 'public', false)).toThrow('scope');
    expect(() => authorizeMcpTool(councilReader, 'wiki.read', 'holocron', false)).toThrow('clearance');
  });

  it('applies explicit deny before scope and clearance allows', () => {
    expect(() => authorizeMcpTool(councilReader, 'wiki.read', 'public', true)).toThrow('denied');
  });
});

import { describe, expect, it } from 'vitest';
import { McpRateLimiter } from '../../src/mcp/mcp-rate-limiter.js';

describe('MCP rate limiter', () => {
  it('limits each authenticated subject independently inside the window', () => {
    const limiter = new McpRateLimiter(2, 60_000);
    expect(() => limiter.consume('subject-a', 1_000)).not.toThrow();
    expect(() => limiter.consume('subject-a', 1_001)).not.toThrow();
    expect(() => limiter.consume('subject-a', 1_002)).toThrow('rate limit');
    expect(() => limiter.consume('subject-b', 1_002)).not.toThrow();
  });

  it('drops expired timestamps atomically before evaluating the limit', () => {
    const limiter = new McpRateLimiter(1, 100);
    limiter.consume('subject-a', 1_000);
    expect(() => limiter.consume('subject-a', 1_101)).not.toThrow();
  });
});

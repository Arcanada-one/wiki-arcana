export class McpRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
  ) {}

  consume(subject: string, now = Date.now()): void {
    const cutoff = now - this.windowMs;
    const active = (this.requests.get(subject) ?? []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= this.limit) throw new Error('MCP rate limit exceeded');
    active.push(now);
    this.requests.set(subject, active);
  }
}

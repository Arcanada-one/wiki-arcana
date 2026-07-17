import type { ZodType } from 'zod';

export type ServiceCredentialProvider = () => Promise<string>;

export interface CallerContext {
  callerBearer?: string;
}

export interface ResilientClientOptions {
  baseUrl: string;
  credentialProvider: ServiceCredentialProvider;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
}

export class CircuitOpenError extends Error {}
export class UpstreamTimeoutError extends Error {}

export class ResilientServiceClient {
  private failures = 0;
  private circuitOpenedAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitResetMs: number;

  constructor(private readonly options: ResilientClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.circuitFailureThreshold = options.circuitFailureThreshold ?? 3;
    this.circuitResetMs = options.circuitResetMs ?? 30_000;
  }

  async get<T>(path: string, schema: ZodType<T>, _context: CallerContext = {}): Promise<T> {
    this.assertCircuitAvailable();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new UpstreamTimeoutError('upstream request timed out')), this.timeoutMs);
    try {
      const credential = await this.options.credentialProvider();
      if (!credential) throw new Error('service credential provider returned an empty credential');
      const response = await this.fetcher(new URL(path, this.options.baseUrl), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${credential}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
      const decoded = schema.parse(await response.json());
      this.failures = 0;
      this.circuitOpenedAt = 0;
      return decoded;
    } catch (error) {
      this.recordFailure();
      if (controller.signal.aborted) throw new UpstreamTimeoutError('upstream request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertCircuitAvailable(): void {
    if (this.circuitOpenedAt === 0) return;
    if (Date.now() - this.circuitOpenedAt >= this.circuitResetMs) {
      this.failures = 0;
      this.circuitOpenedAt = 0;
      return;
    }
    throw new CircuitOpenError('upstream circuit is open');
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.circuitFailureThreshold) this.circuitOpenedAt = Date.now();
  }
}

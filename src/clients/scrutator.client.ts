import { z } from 'zod';
import { ResilientServiceClient, type CallerContext, type ResilientClientOptions } from './resilient-service-client.js';

const ScrutatorHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('Scrutator'),
  version: z.string().min(1),
});

const EmbeddingHealthSchema = z.object({
  status: z.literal('ok'),
  model: z.string().min(1),
  dimension: z.number().int().positive(),
  fp16: z.boolean(),
  ram_mb: z.number().nonnegative(),
});

export interface ScrutatorClientOptions extends Omit<ResilientClientOptions, 'baseUrl'> {
  apiUrl: string;
  embeddingUrl: string;
}

export class ScrutatorClient {
  private readonly api: ResilientServiceClient;
  private readonly embedding: ResilientServiceClient;

  constructor(options: ScrutatorClientOptions) {
    const shared = {
      credentialProvider: options.credentialProvider,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
      circuitFailureThreshold: options.circuitFailureThreshold,
      circuitResetMs: options.circuitResetMs,
    };
    this.api = new ResilientServiceClient({ ...shared, baseUrl: options.apiUrl });
    this.embedding = new ResilientServiceClient({ ...shared, baseUrl: options.embeddingUrl });
  }

  health(context?: CallerContext): Promise<z.infer<typeof ScrutatorHealthSchema>> {
    return this.api.get('/health', ScrutatorHealthSchema, context);
  }

  embeddingHealth(context?: CallerContext): Promise<z.infer<typeof EmbeddingHealthSchema>> {
    return this.embedding.get('/health', EmbeddingHealthSchema, context);
  }
}

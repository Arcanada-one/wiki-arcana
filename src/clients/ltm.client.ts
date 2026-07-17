import { z } from 'zod';
import { ResilientServiceClient, type CallerContext, type ResilientClientOptions } from './resilient-service-client.js';

const LtmHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});

export class LtmClient {
  private readonly client: ResilientServiceClient;

  constructor(options: ResilientClientOptions) {
    this.client = new ResilientServiceClient(options);
  }

  health(context?: CallerContext): Promise<z.infer<typeof LtmHealthSchema>> {
    return this.client.get('/health', LtmHealthSchema, context);
  }
}

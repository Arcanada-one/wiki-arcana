import type { AccessContext } from './access-context.js';

export interface VectorQuery {
  spaceId: string;
  values: readonly number[];
  limit?: number;
}

export interface VectorHit {
  id: string;
  score: number;
  spaceId: string;
}

export interface VectorPort {
  search(context: AccessContext, query: VectorQuery): Promise<readonly VectorHit[]>;
  upsert(context: AccessContext, id: string, spaceId: string, values: readonly number[]): Promise<void>;
}


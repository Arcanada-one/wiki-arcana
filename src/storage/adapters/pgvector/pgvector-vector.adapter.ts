import { NotImplementedInPhaseOneError } from '../../not-implemented-in-phase-one.error.js';
import type { AccessContext } from '../../ports/access-context.js';
import type { VectorHit, VectorPort, VectorQuery } from '../../ports/vector.port.js';

export class PgvectorVectorAdapter implements VectorPort {
  search(_context: AccessContext, _query: VectorQuery): Promise<readonly VectorHit[]> {
    return Promise.reject(new NotImplementedInPhaseOneError('Vector search'));
  }

  upsert(_context: AccessContext, _id: string, _spaceId: string, _values: readonly number[]): Promise<void> {
    return Promise.reject(new NotImplementedInPhaseOneError('Vector mutation'));
  }
}


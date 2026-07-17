import { NotImplementedInPhaseOneError } from '../../not-implemented-in-phase-one.error.js';
import type { AccessContext } from '../../ports/access-context.js';
import type { GraphPort, KnowledgeNode, TraversalSpec } from '../../ports/graph.port.js';

export class AgeGraphAdapter implements GraphPort {
  getNode(_context: AccessContext, _nodeId: string): Promise<KnowledgeNode | null> {
    return Promise.reject(new NotImplementedInPhaseOneError('Graph storage'));
  }

  traverse(_context: AccessContext, _specification: TraversalSpec): Promise<readonly KnowledgeNode[]> {
    return Promise.reject(new NotImplementedInPhaseOneError('Graph traversal'));
  }

  upsertNode(_context: AccessContext, _node: KnowledgeNode): Promise<void> {
    return Promise.reject(new NotImplementedInPhaseOneError('Graph mutation'));
  }
}


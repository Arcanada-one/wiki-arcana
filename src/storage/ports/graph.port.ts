import type { AccessContext } from './access-context.js';

export interface KnowledgeNode {
  id: string;
  spaceId: string;
}

export interface TraversalSpec {
  startNodeId: string;
  maxDepth: number;
}

export interface GraphPort {
  getNode(context: AccessContext, nodeId: string): Promise<KnowledgeNode | null>;
  traverse(context: AccessContext, specification: TraversalSpec): Promise<readonly KnowledgeNode[]>;
  upsertNode(context: AccessContext, node: KnowledgeNode): Promise<void>;
}


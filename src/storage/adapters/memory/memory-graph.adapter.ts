import type { AccessContext } from '../../ports/access-context.js';
import type { GraphPort, KnowledgeNode, TraversalSpec } from '../../ports/graph.port.js';

export class MemoryGraphAdapter implements GraphPort {
  private readonly nodes = new Map<string, KnowledgeNode>();

  async getNode(context: AccessContext, nodeId: string): Promise<KnowledgeNode | null> {
    const node = this.nodes.get(nodeId) ?? null;
    if (!node) return null;
    const denied = context.spaceGrants.deny.some((grant) => grant.spaceId === node.spaceId && grant.capability === 'read');
    return denied ? null : node;
  }

  async traverse(context: AccessContext, specification: TraversalSpec): Promise<readonly KnowledgeNode[]> {
    const start = await this.getNode(context, specification.startNodeId);
    return start ? [start] : [];
  }

  async upsertNode(_context: AccessContext, node: KnowledgeNode): Promise<void> {
    this.nodes.set(node.id, node);
  }
}


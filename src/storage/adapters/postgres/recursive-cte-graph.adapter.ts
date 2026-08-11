import { AccessContextPolicy } from '../../access-context.policy.js';
import type { AccessContext } from '../../ports/access-context.js';
import type { GraphPort, KnowledgeNode, TraversalSpec } from '../../ports/graph.port.js';
import { validateTraversalSpec, validateUuid } from '../../storage-input.validation.js';
import { QueryExecutor } from './query-executor.js';
import { accessContextValues, READ_ACL_CTE, READ_ACL_PREDICATE } from './storage-acl.sql.js';

export class RecursiveCteGraphAdapter implements GraphPort {
  constructor(private readonly executor: QueryExecutor, private readonly policy: AccessContextPolicy) {}

  async getNode(context: AccessContext, nodeId: string): Promise<KnowledgeNode | null> {
    const validContext = this.policy.validate(context);
    const id = validateUuid(nodeId, 'nodeId');
    const result = await this.executor.query<KnowledgeNode>(
      `WITH ${READ_ACL_CTE}
       SELECT kn.id, kn.space_id AS "spaceId"
       FROM knowledge_nodes kn
       JOIN knowledge_spaces ks ON ks.id = kn.space_id
       JOIN access_levels access_level ON access_level.slug = ks.required_level
       CROSS JOIN access_context
       WHERE kn.id = $1 AND ${READ_ACL_PREDICATE}`,
      [id, ...accessContextValues(validContext)],
    );
    return result.rows[0] ?? null;
  }

  async traverse(context: AccessContext, specification: TraversalSpec): Promise<readonly KnowledgeNode[]> {
    const validContext = this.policy.validate(context);
    const valid = validateTraversalSpec(specification);
    const result = await this.executor.query<KnowledgeNode>(
      `WITH RECURSIVE ${READ_ACL_CTE}, authorized_start AS (
         SELECT kn.id
         FROM knowledge_nodes kn
         JOIN knowledge_spaces ks ON ks.id = kn.space_id
         JOIN access_levels access_level ON access_level.slug = ks.required_level
         CROSS JOIN access_context
         WHERE kn.id = $1 AND ${READ_ACL_PREDICATE}
       ), walk(node_id, depth, path) AS (
         SELECT authorized_start.id, 0, ARRAY[authorized_start.id]
         FROM authorized_start
         UNION ALL
         SELECT edge.target_node_id, walk.depth + 1, walk.path || edge.target_node_id
         FROM walk
         JOIN knowledge_edges edge ON edge.source_node_id = walk.node_id
         JOIN knowledge_nodes target_node ON target_node.id = edge.target_node_id
         JOIN knowledge_spaces ks ON ks.id = target_node.space_id
         JOIN access_levels access_level ON access_level.slug = ks.required_level
         CROSS JOIN access_context
         WHERE walk.depth < $4 AND NOT edge.target_node_id = ANY(walk.path)
           AND ${READ_ACL_PREDICATE}
       )
       SELECT DISTINCT kn.id, kn.space_id AS "spaceId"
       FROM walk
       JOIN knowledge_nodes kn ON kn.id = walk.node_id
       JOIN knowledge_spaces ks ON ks.id = kn.space_id
       JOIN access_levels access_level ON access_level.slug = ks.required_level
       CROSS JOIN access_context
       WHERE walk.depth > 0 AND ${READ_ACL_PREDICATE}
       ORDER BY kn.id`,
      [valid.startNodeId, ...accessContextValues(validContext), valid.maxDepth],
    );
    return result.rows;
  }

  upsertNode(context: AccessContext, node: KnowledgeNode): Promise<void> {
    this.policy.validate(context);
    validateUuid(node.id, 'nodeId');
    validateUuid(node.spaceId, 'spaceId');
    return Promise.reject(new Error('Relational graph mutations must use AgeGraphAdapter to maintain the AGE mirror'));
  }
}

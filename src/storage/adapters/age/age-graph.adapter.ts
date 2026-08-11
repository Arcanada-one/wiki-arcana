import { AccessContextPolicy } from '../../access-context.policy.js';
import type { AccessContext } from '../../ports/access-context.js';
import type { GraphPort, KnowledgeNode, TraversalSpec } from '../../ports/graph.port.js';
import type { UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import { validateTraversalSpec, validateUuid } from '../../storage-input.validation.js';
import { AccessDeniedError, InvalidStorageInputError } from '../../storage.errors.js';
import { QueryExecutor } from '../postgres/query-executor.js';
import {
  accessContextValues,
  assertDatabaseCanWrite,
  assertEdgeEndpointsAllowed,
  assertEdgeIdentityAssignable,
  assertNodeAssignableToSpace,
  READ_ACL_CTE,
  READ_ACL_PREDICATE,
} from '../postgres/storage-acl.sql.js';

export const AGE_TRAVERSAL_QUERIES = Object.freeze({
  1: traversalQuery(1),
  2: traversalQuery(2),
  3: traversalQuery(3),
  4: traversalQuery(4),
} satisfies Record<1 | 2 | 3 | 4, string>);

interface AgNodeRow { node_id: unknown; space_id: unknown }

export interface KnowledgeEdgeInput {
  id: string;
  spaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
}

export class AgeGraphAdapter implements GraphPort {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly policy: AccessContextPolicy,
    private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async getNode(context: AccessContext, nodeId: string): Promise<KnowledgeNode | null> {
    const validContext = this.policy.validate(context);
    const validNodeId = validateUuid(nodeId, 'nodeId');
    const result = await this.executor.query<KnowledgeNode>(
      `WITH ${READ_ACL_CTE}
       SELECT kn.id, kn.space_id AS "spaceId"
       FROM knowledge_nodes kn
       JOIN knowledge_spaces ks ON ks.id = kn.space_id
       JOIN access_levels access_level ON access_level.slug = ks.required_level
       CROSS JOIN access_context
       WHERE kn.id = $1 AND ${READ_ACL_PREDICATE}`,
      [validNodeId, ...accessContextValues(validContext)],
    );
    return result.rows[0] ?? null;
  }

  async traverse(context: AccessContext, specification: TraversalSpec): Promise<readonly KnowledgeNode[]> {
    const validContext = this.policy.validate(context);
    const valid = validateTraversalSpec(specification);
    const template = AGE_TRAVERSAL_QUERIES[valid.maxDepth as 1 | 2 | 3 | 4];
    return this.unitOfWork.transaction(async () => {
      const result = await this.executor.query<AgNodeRow>(
      `WITH RECURSIVE ${READ_ACL_CTE}, authorized_start AS (
         SELECT kn.id
         FROM knowledge_nodes kn
         JOIN knowledge_spaces ks ON ks.id = kn.space_id
         JOIN access_levels access_level ON access_level.slug = ks.required_level
         CROSS JOIN access_context
         WHERE kn.id = $1 AND ${READ_ACL_PREDICATE}
       ), authorized_walk(node_id, depth, path) AS (
         SELECT authorized_start.id, 0, ARRAY[authorized_start.id]
         FROM authorized_start
         UNION ALL
         SELECT edge.target_node_id, authorized_walk.depth + 1,
                authorized_walk.path || edge.target_node_id
         FROM authorized_walk
         JOIN knowledge_edges edge ON edge.source_node_id = authorized_walk.node_id
         JOIN knowledge_nodes target_node ON target_node.id = edge.target_node_id
         JOIN knowledge_spaces ks ON ks.id = target_node.space_id
         JOIN access_levels access_level ON access_level.slug = ks.required_level
         CROSS JOIN access_context
         WHERE authorized_walk.depth < $4
           AND NOT edge.target_node_id = ANY(authorized_walk.path)
           AND ${READ_ACL_PREDICATE}
       ), traversed AS (
         SELECT node_id, space_id
         FROM authorized_start
         CROSS JOIN LATERAL ag_catalog.cypher('wiki_arcana', $cypher$${template}$cypher$, $5::ag_catalog.agtype)
           AS traversal(node_id ag_catalog.agtype, space_id ag_catalog.agtype)
       )
       SELECT DISTINCT kn.id AS node_id, kn.space_id AS space_id
       FROM traversed
       JOIN knowledge_nodes kn ON kn.id = trim(both '"' from traversed.node_id::text)::uuid
       JOIN authorized_walk ON authorized_walk.node_id = kn.id AND authorized_walk.depth > 0
       JOIN knowledge_spaces ks ON ks.id = kn.space_id
       JOIN access_levels access_level ON access_level.slug = ks.required_level
       CROSS JOIN access_context
       WHERE ${READ_ACL_PREDICATE}
       ORDER BY node_id`,
        [valid.startNodeId, ...accessContextValues(validContext), valid.maxDepth,
          JSON.stringify({ startNodeId: valid.startNodeId })],
      );
      return result.rows.map((row) => ({
        // The outer relational SELECT resolves AGE properties back to UUID
        // columns, so pg returns canonical UUID strings rather than agtype.
        id: String(row.node_id),
        spaceId: String(row.space_id),
      }));
    });
  }

  async upsertNode(context: AccessContext, node: KnowledgeNode): Promise<void> {
    const validContext = this.policy.validate(context);
    const id = validateUuid(node.id, 'nodeId');
    const spaceId = validateUuid(node.spaceId, 'spaceId');
    await this.unitOfWork.transaction(async () => {
      await assertDatabaseCanWrite(this.executor, this.policy, validContext, spaceId);
      await assertNodeAssignableToSpace(this.executor, id, spaceId);
      const relational = await this.executor.query(
        `INSERT INTO knowledge_nodes (id, space_id) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()
         WHERE knowledge_nodes.space_id = EXCLUDED.space_id`,
        [id, spaceId],
      );
      if (relational.rowCount !== 1) throw new AccessDeniedError();
      await this.executor.query(
        `SELECT * FROM ag_catalog.cypher('wiki_arcana',
          $cypher$MERGE (node:KnowledgeNode {id: $id}) SET node.spaceId = $spaceId RETURN node$cypher$,
          $1::ag_catalog.agtype) AS (node ag_catalog.agtype)`,
        [JSON.stringify({ id, spaceId })],
      );
    });
  }

  async upsertEdge(context: AccessContext, edge: KnowledgeEdgeInput): Promise<void> {
    const validContext = this.policy.validate(context);
    const id = validateUuid(edge.id, 'edgeId');
    const spaceId = validateUuid(edge.spaceId, 'spaceId');
    const sourceNodeId = validateUuid(edge.sourceNodeId, 'sourceNodeId');
    const targetNodeId = validateUuid(edge.targetNodeId, 'targetNodeId');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(edge.edgeType)) {
      throw new InvalidStorageInputError('edgeType');
    }
    await this.unitOfWork.transaction(async () => {
      await assertDatabaseCanWrite(this.executor, this.policy, validContext, spaceId);
      await assertEdgeEndpointsAllowed(this.executor, spaceId, sourceNodeId, targetNodeId);
      await assertEdgeIdentityAssignable(this.executor, id, spaceId, sourceNodeId, targetNodeId);
      const relational = await this.executor.query(
        `INSERT INTO knowledge_edges (id, space_id, source_node_id, target_node_id, edge_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET edge_type = EXCLUDED.edge_type, updated_at = now()
         WHERE knowledge_edges.space_id = EXCLUDED.space_id
           AND knowledge_edges.source_node_id = EXCLUDED.source_node_id
           AND knowledge_edges.target_node_id = EXCLUDED.target_node_id`,
        [id, spaceId, sourceNodeId, targetNodeId, edge.edgeType],
      );
      if (relational.rowCount !== 1) throw new AccessDeniedError();
      await this.executor.query(
        `SELECT * FROM ag_catalog.cypher('wiki_arcana',
          $cypher$MATCH (source:KnowledgeNode {id: $sourceNodeId})
          MATCH (target:KnowledgeNode {id: $targetNodeId})
          MERGE (source)-[edge:KNOWLEDGE_EDGE {id: $id}]->(target)
          SET edge.spaceId = $spaceId, edge.edgeType = $edgeType RETURN edge$cypher$,
          $1::ag_catalog.agtype) AS (edge ag_catalog.agtype)`,
        [JSON.stringify({ id, spaceId, sourceNodeId, targetNodeId, edgeType: edge.edgeType })],
      );
    });
  }
}

function traversalQuery(depth: 1 | 2 | 3 | 4): string {
  return `MATCH path = (start:KnowledgeNode {id: $startNodeId})-[:KNOWLEDGE_EDGE*1..${depth}]->(node:KnowledgeNode)
    RETURN node.id AS nodeId, node.spaceId AS spaceId`;
}

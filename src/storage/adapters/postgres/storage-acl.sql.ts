import type { AccessContext } from '../../ports/access-context.js';
import { AccessDeniedError } from '../../storage.errors.js';
import { AccessContextPolicy } from '../../access-context.policy.js';
import { QueryExecutor } from './query-executor.js';

export const READ_ACL_CTE = `access_context AS (
  SELECT $2::uuid AS subject_id, $3::integer AS clearance
)`;

export const READ_ACL_PREDICATE = `
  NOT EXISTS (
    SELECT 1
    FROM space_grants denied
    JOIN space_closure denied_scope ON denied_scope.ancestor_id = denied.space_id
    WHERE denied_scope.descendant_id = ks.id
      AND denied.subject_id = access_context.subject_id::text
      AND denied.effect = 'deny'
      AND denied.capability IN ('read', 'admin')
  )
  AND (
    access_context.clearance >= access_level.ordinal
    OR EXISTS (
      SELECT 1
      FROM effective_permissions allowed
      WHERE allowed.space_id = ks.id
        AND allowed.subject_id = access_context.subject_id::text
        AND allowed.capability IN ('read', 'admin')
    )
  )`;

export function accessContextValues(context: AccessContext): readonly unknown[] {
  return [context.subjectId, context.level];
}

export async function assertDatabaseCanWrite(
  executor: QueryExecutor,
  policy: AccessContextPolicy,
  context: AccessContext,
  spaceId: string,
): Promise<void> {
  const validated = policy.validate(context);
  const result = await executor.query(
    `WITH authorization_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))
     )
     SELECT 1
     FROM knowledge_spaces ks
     CROSS JOIN authorization_lock
     WHERE ks.id = $1::uuid
       AND EXISTS (
         SELECT 1 FROM effective_permissions allowed
         WHERE allowed.space_id = ks.id AND allowed.subject_id = $2::uuid::text
           AND allowed.capability IN ('write', 'admin')
       )
       AND NOT EXISTS (
         SELECT 1 FROM space_grants denied
         JOIN space_closure denied_scope ON denied_scope.ancestor_id = denied.space_id
         WHERE denied_scope.descendant_id = ks.id AND denied.subject_id = $2::uuid::text
           AND denied.effect = 'deny' AND denied.capability IN ('write', 'admin')
       )`,
    [spaceId, validated.subjectId],
  );
  if (result.rowCount !== 1) throw new AccessDeniedError();
}

export async function readableSpaceIds(
  executor: QueryExecutor,
  policy: AccessContextPolicy,
  context: AccessContext,
): Promise<readonly string[]> {
  const validated = policy.validate(context);
  const result = await executor.query<{ id: string }>(
    `WITH access_context AS (
       SELECT $1::uuid AS subject_id, $2::integer AS clearance
     )
     SELECT ks.id
     FROM knowledge_spaces ks
     JOIN access_levels access_level ON access_level.slug = ks.required_level
     CROSS JOIN access_context
     WHERE ${READ_ACL_PREDICATE}
     ORDER BY ks.id`,
    accessContextValues(validated),
  );
  return result.rows.map((row) => row.id);
}

export async function assertNodeAssignableToSpace(
  executor: QueryExecutor,
  nodeId: string,
  spaceId: string,
): Promise<void> {
  const result = await executor.query<{ space_id: string }>(
    'SELECT space_id FROM knowledge_nodes WHERE id = $1',
    [nodeId],
  );
  if (result.rows[0] && result.rows[0].space_id !== spaceId) throw new AccessDeniedError();
}

export async function assertEdgeIdentityAssignable(
  executor: QueryExecutor,
  edgeId: string,
  spaceId: string,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const result = await executor.query<{
    space_id: string;
    source_node_id: string;
    target_node_id: string;
  }>(
    `SELECT space_id, source_node_id, target_node_id
     FROM knowledge_edges WHERE id = $1`,
    [edgeId],
  );
  const existing = result.rows[0];
  if (existing && (
    existing.space_id !== spaceId
    || existing.source_node_id !== sourceNodeId
    || existing.target_node_id !== targetNodeId
  )) throw new AccessDeniedError();
}

export async function assertEdgeEndpointsAllowed(
  executor: QueryExecutor,
  spaceId: string,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const result = await executor.query(
    `SELECT 1
     FROM knowledge_nodes source
     JOIN knowledge_nodes target ON target.id = $3
     JOIN knowledge_spaces source_space ON source_space.id = source.space_id
     WHERE source.id = $2 AND source.space_id = $1
       AND (source_space.isolation_mode = 'linked' OR target.space_id = $1)`,
    [spaceId, sourceNodeId, targetNodeId],
  );
  if (result.rowCount !== 1) throw new AccessDeniedError();
}

export async function assertNodeInSpace(
  executor: QueryExecutor,
  spaceId: string,
  nodeId: string,
): Promise<void> {
  const result = await executor.query(
    'SELECT 1 FROM knowledge_nodes WHERE space_id = $1 AND id = $2',
    [spaceId, nodeId],
  );
  if (result.rowCount !== 1) throw new AccessDeniedError();
}

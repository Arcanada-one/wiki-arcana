import type { Pool, PoolClient } from 'pg';
import type { AccessContext, Capability } from '../../ports/access-context.js';
import type { KnowledgeSpace, SpaceGrant, SpaceRegistryPort } from '../../ports/space-registry.port.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export class PostgresRegistryAdapter implements SpaceRegistryPort {
  constructor(private readonly database: Queryable) {}

  async listSpaces(context: AccessContext, capability: Capability = 'read'): Promise<readonly KnowledgeSpace[]> {
    const result = await this.database.query<KnowledgeSpace>(
      `SELECT ks.id, ks.slug, ks.name, ks.parent_id AS "parentId", ks.required_level AS "requiredLevel"
       FROM knowledge_spaces ks
       JOIN access_levels level ON level.slug = ks.required_level
       LEFT JOIN effective_permissions ep ON ep.space_id = ks.id AND ep.subject_id = $1 AND ep.capability = $2
       WHERE (level.ordinal <= $3 OR ep.space_id IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM space_grants denied
           JOIN space_closure denied_scope ON denied_scope.ancestor_id = denied.space_id
           WHERE denied_scope.descendant_id = ks.id AND denied.subject_id = $1
             AND denied.capability = $2 AND denied.effect = 'deny'
         )
       ORDER BY ks.slug`,
      [context.subjectId, capability, context.level],
    );
    return result.rows;
  }

  async getSpace(context: AccessContext, spaceId: string): Promise<KnowledgeSpace | null> {
    const result = await this.database.query<KnowledgeSpace>(
      `SELECT ks.id, ks.slug, ks.name, ks.parent_id AS "parentId", ks.required_level AS "requiredLevel"
       FROM knowledge_spaces ks
       JOIN access_levels level ON level.slug = ks.required_level
       LEFT JOIN effective_permissions ep ON ep.space_id = ks.id AND ep.subject_id = $2 AND ep.capability = 'read'
       WHERE ks.id = $1 AND (level.ordinal <= $3 OR ep.space_id IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM space_grants denied
           JOIN space_closure denied_scope ON denied_scope.ancestor_id = denied.space_id
           WHERE denied_scope.descendant_id = ks.id AND denied.subject_id = $2
             AND denied.capability = 'read' AND denied.effect = 'deny'
         )`,
      [spaceId, context.subjectId, context.level],
    );
    return result.rows[0] ?? null;
  }

  async addGrant(grant: SpaceGrant): Promise<void> {
    await this.database.query(
      `INSERT INTO space_grants (id, space_id, subject_type, subject_id, effect, capability)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [grant.spaceId, grant.subjectType, grant.subjectId, grant.effect, grant.capability],
    );
  }

  async removeGrant(grant: SpaceGrant): Promise<void> {
    await this.database.query(
      `DELETE FROM space_grants WHERE space_id=$1 AND subject_type=$2 AND subject_id=$3 AND effect=$4 AND capability=$5`,
      [grant.spaceId, grant.subjectType, grant.subjectId, grant.effect, grant.capability],
    );
  }

  async moveSpace(spaceId: string, parentId: string | null): Promise<void> {
    await this.database.query('UPDATE knowledge_spaces SET parent_id=$2, updated_at=now() WHERE id=$1', [spaceId, parentId]);
  }
}

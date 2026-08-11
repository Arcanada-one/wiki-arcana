import { AccessContextPolicy } from '../../access-context.policy.js';
import type { AccessContext } from '../../ports/access-context.js';
import type { UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import type { VectorHit, VectorPort, VectorQuery } from '../../ports/vector.port.js';
import { validateVectorQuery, validateVectorUpsert } from '../../storage-input.validation.js';
import { QueryExecutor } from '../postgres/query-executor.js';
import {
  accessContextValues,
  assertDatabaseCanWrite,
  assertNodeInSpace,
  READ_ACL_CTE,
  READ_ACL_PREDICATE,
} from '../postgres/storage-acl.sql.js';

const VECTOR_PROJECTION_CANDIDATE_LIMIT = 10;

const VECTOR_SEARCH = `WITH ${READ_ACL_CTE}, hnsw_candidates AS MATERIALIZED (
  SELECT kv.node_id
  FROM knowledge_vectors kv
  WHERE kv.space_id = $1 AND ($5::uuid IS NULL OR kv.node_id <> $5::uuid)
  ORDER BY kv.embedding <=> $4::vector
  LIMIT $6
), projection_candidates AS MATERIALIZED (
  SELECT projection.node_id
  FROM knowledge_vector_projections projection
  WHERE projection.space_id = $1 AND ($5::uuid IS NULL OR projection.node_id <> $5::uuid)
  ORDER BY projection.embedding <=> $4::halfvec(1024)
  LIMIT $7
), candidate_ids AS (
  SELECT node_id FROM hnsw_candidates
  UNION
  SELECT node_id FROM projection_candidates
)
  SELECT kv.node_id AS id, kv.space_id AS "spaceId", 1 - (kv.embedding <=> $4::vector) AS score
  FROM candidate_ids candidate
  JOIN knowledge_vectors kv ON kv.node_id = candidate.node_id
  JOIN knowledge_spaces ks ON ks.id = kv.space_id
  JOIN access_levels access_level ON access_level.slug = ks.required_level
  CROSS JOIN access_context
  WHERE kv.space_id = $1 AND ${READ_ACL_PREDICATE}
  ORDER BY (kv.embedding <=> $4::vector) + 0
  LIMIT $8`;

export const VECTOR_SEARCH_SETTINGS = [
  'SET LOCAL jit = off',
  'SET LOCAL enable_sort = off',
  'SET LOCAL hnsw.ef_search = 1',
  'SET LOCAL ivfflat.probes = 100',
  "SET LOCAL hnsw.iterative_scan = 'strict_order'",
  'SET LOCAL hnsw.max_scan_tuples = 20000',
  'SET LOCAL hnsw.scan_mem_multiplier = 2',
] as const;

export interface ObservedVectorSearchSettings {
  readonly statementTimeout: string; readonly jit: string; readonly enableSort: string; readonly efSearch: string; readonly iterativeScan: string;
  readonly maxScanTuples: string; readonly scanMemMultiplier: string; readonly ivfflatProbes: string;
}

export class PgvectorVectorAdapter implements VectorPort {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly policy: AccessContextPolicy,
    private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async search(context: AccessContext, query: VectorQuery): Promise<readonly VectorHit[]> {
    const validContext = this.policy.validate(context);
    const valid = validateVectorQuery(query);
    return this.unitOfWork.transaction(async () => {
      const result = await this.executor.query<VectorHit>(VECTOR_SEARCH, [
        valid.spaceId,
        ...accessContextValues(validContext),
        vectorLiteral(valid.values),
        valid.excludeNodeId ?? null,
        valid.limit,
        VECTOR_PROJECTION_CANDIDATE_LIMIT,
        valid.limit,
      ]);
      return result.rows;
    }, VECTOR_SEARCH_SETTINGS);
  }

  async explainSearch(context: AccessContext, query: VectorQuery): Promise<unknown> {
    const validContext = this.policy.validate(context);
    const valid = validateVectorQuery(query);
    return this.unitOfWork.transaction(async () => {
      const result = await this.executor.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${VECTOR_SEARCH}`,
        [valid.spaceId, ...accessContextValues(validContext), vectorLiteral(valid.values), valid.excludeNodeId ?? null,
          valid.limit, VECTOR_PROJECTION_CANDIDATE_LIMIT, valid.limit],
      );
      return result.rows[0]?.['QUERY PLAN'];
    }, VECTOR_SEARCH_SETTINGS);
  }

  async observeSearchSettings(): Promise<ObservedVectorSearchSettings> {
    return this.unitOfWork.transaction(async () => {
      const result = await this.executor.query<ObservedVectorSearchSettings>(`SELECT
        current_setting('statement_timeout') AS "statementTimeout",
        current_setting('jit') AS "jit",
        current_setting('enable_sort') AS "enableSort",
        current_setting('hnsw.ef_search') AS "efSearch",
        current_setting('ivfflat.probes') AS "ivfflatProbes",
        current_setting('hnsw.iterative_scan') AS "iterativeScan",
        current_setting('hnsw.max_scan_tuples') AS "maxScanTuples",
        current_setting('hnsw.scan_mem_multiplier') AS "scanMemMultiplier"`);
      if (!result.rows[0]) throw new Error('vector search settings observation returned no row');
      return result.rows[0];
    }, VECTOR_SEARCH_SETTINGS);
  }

  async upsert(
    context: AccessContext,
    id: string,
    spaceId: string,
    values: readonly number[],
  ): Promise<void> {
    const validContext = this.policy.validate(context);
    const valid = validateVectorUpsert(id, spaceId, values);
    await this.unitOfWork.transaction(async () => {
      await assertDatabaseCanWrite(this.executor, this.policy, validContext, valid.spaceId);
      await assertNodeInSpace(this.executor, valid.spaceId, valid.id);
      await this.executor.query(
        `INSERT INTO knowledge_vectors (node_id, space_id, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (node_id) DO UPDATE
         SET space_id = EXCLUDED.space_id, embedding = EXCLUDED.embedding, updated_at = now()`,
        [valid.id, valid.spaceId, vectorLiteral(valid.values)],
      );
    });
  }
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

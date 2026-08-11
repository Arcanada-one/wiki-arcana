import { z } from 'zod';
import type { TraversalSpec } from './ports/graph.port.js';
import type { VectorQuery } from './ports/vector.port.js';
import { AccessDeniedError, InvalidStorageInputError } from './storage.errors.js';

export { InvalidStorageInputError } from './storage.errors.js';

const UuidSchema = z.uuid();
const VectorValuesSchema = z.array(z.number().finite()).length(1_024);
const TraversalSpecSchema = z.object({
  startNodeId: UuidSchema,
  maxDepth: z.number().int().min(1).max(4),
}).strict();
const VectorQuerySchema = z.object({
  spaceId: UuidSchema,
  values: VectorValuesSchema,
  limit: z.number().int().min(1).max(100).default(10),
  excludeNodeId: UuidSchema.optional(),
}).strict();
const VectorUpsertSchema = z.object({
  id: UuidSchema,
  spaceId: UuidSchema,
  values: VectorValuesSchema,
}).strict();

export function validateUuid(value: unknown, field: string): string {
  const result = UuidSchema.safeParse(value);
  if (!result.success) throw new InvalidStorageInputError(field);
  return result.data;
}

export function validateTraversalSpec(specification: TraversalSpec): TraversalSpec {
  const result = TraversalSpecSchema.safeParse(specification);
  if (!result.success) throw new InvalidStorageInputError('traversal');
  return result.data;
}

export interface ValidatedVectorQuery extends VectorQuery {
  limit: number;
}

export function validateVectorQuery(query: VectorQuery): ValidatedVectorQuery {
  const result = VectorQuerySchema.safeParse(query);
  if (!result.success) throw new InvalidStorageInputError('vectorQuery');
  return result.data;
}

export function validateVectorUpsert(
  id: string,
  spaceId: string,
  values: readonly number[],
): { id: string; spaceId: string; values: readonly number[] } {
  const result = VectorUpsertSchema.safeParse({ id, spaceId, values });
  if (!result.success) throw new InvalidStorageInputError('vectorUpsert');
  return result.data;
}

export function assertSameSpace(expectedSpaceId: string, actualSpaceId: string): void {
  const expected = validateUuid(expectedSpaceId, 'expectedSpaceId');
  const actual = validateUuid(actualSpaceId, 'actualSpaceId');
  if (expected !== actual) throw new AccessDeniedError();
}

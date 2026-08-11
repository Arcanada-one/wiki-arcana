import { describe, expect, it, vi } from 'vitest';
import type { AccessContext } from '../../src/storage/ports/access-context.js';
import {
  AccessContextPolicy,
  AccessDeniedError,
  InvalidAccessContextError,
} from '../../src/storage/access-context.policy.js';
import {
  InvalidStorageInputError,
  assertSameSpace,
  validateTraversalSpec,
  validateVectorQuery,
  validateVectorUpsert,
} from '../../src/storage/storage-input.validation.js';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SPACE_ID = '33333333-3333-4333-8333-333333333333';
const NODE_ID = '44444444-4444-4444-8444-444444444444';

function context(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    subjectId: SUBJECT_ID,
    level: 20,
    spaceGrants: { allow: [], deny: [] },
    ...overrides,
  };
}

describe('AccessContextPolicy', () => {
  const policy = new AccessContextPolicy();

  it('allows reads from clearance alone', () => {
    expect(policy.canRead(context({ level: 30 }), SPACE_ID, 30)).toBe(true);
  });

  it.each(['read', 'admin'] as const)('allows reads below clearance with an explicit %s grant', (capability) => {
    const accessContext = context({
      level: 5,
      spaceGrants: { allow: [{ spaceId: SPACE_ID, capability }], deny: [] },
    });
    expect(policy.canRead(accessContext, SPACE_ID, 30)).toBe(true);
  });

  it('makes deny win over both allow and sufficient clearance', () => {
    const accessContext = context({
      level: 100,
      spaceGrants: {
        allow: [{ spaceId: SPACE_ID, capability: 'admin' }],
        deny: [{ spaceId: SPACE_ID, capability: 'read' }],
      },
    });
    expect(policy.canRead(accessContext, SPACE_ID, 10)).toBe(false);
  });

  it('treats an admin deny as a read deny', () => {
    const accessContext = context({
      level: 100,
      spaceGrants: { allow: [], deny: [{ spaceId: SPACE_ID, capability: 'admin' }] },
    });
    expect(policy.canRead(accessContext, SPACE_ID, 10)).toBe(false);
  });

  it('rejects reads with neither an explicit allow nor sufficient clearance', () => {
    expect(policy.canRead(context({ level: 5 }), SPACE_ID, 30)).toBe(false);
  });

  it('requires an explicit write or admin allow for writes regardless of clearance', () => {
    expect(() => policy.assertCanWrite(context({ level: 100 }), SPACE_ID)).toThrow(AccessDeniedError);

    expect(() => policy.assertCanWrite(context({
      level: 0,
      spaceGrants: { allow: [{ spaceId: SPACE_ID, capability: 'write' }], deny: [] },
    }), SPACE_ID)).not.toThrow();
  });

  it('makes a write/admin deny win over a write/admin allow', () => {
    const accessContext = context({
      spaceGrants: {
        allow: [{ spaceId: SPACE_ID, capability: 'admin' }],
        deny: [{ spaceId: SPACE_ID, capability: 'write' }],
      },
    });
    expect(() => policy.assertCanWrite(accessContext, SPACE_ID)).toThrow(AccessDeniedError);
  });

  it('treats an admin deny as a write deny', () => {
    const accessContext = context({
      spaceGrants: {
        allow: [{ spaceId: SPACE_ID, capability: 'write' }],
        deny: [{ spaceId: SPACE_ID, capability: 'admin' }],
      },
    });
    expect(() => policy.assertCanWrite(accessContext, SPACE_ID)).toThrow(AccessDeniedError);
  });

  it.each([
    undefined,
    context({ subjectId: 'not-a-uuid' }),
    context({ level: Number.NaN }),
    context({
      spaceGrants: { allow: [{ spaceId: 'not-a-uuid', capability: 'read' }], deny: [] },
    }),
  ])('fails closed for a malformed or missing context', (accessContext) => {
    expect(() => policy.canRead(accessContext as AccessContext, SPACE_ID, 10))
      .toThrow(InvalidAccessContextError);
  });
});

describe('storage input validation', () => {
  const vector = Object.freeze(Array.from({ length: 1_024 }, (_, index) => index / 1_024));

  it('normalizes a valid vector query and default limit', () => {
    expect(validateVectorQuery({ spaceId: SPACE_ID, values: vector })).toEqual({
      spaceId: SPACE_ID,
      values: vector,
      limit: 10,
    });
  });

  it.each([
    { spaceId: 'not-a-uuid', values: vector, limit: 10 },
    { spaceId: SPACE_ID, values: vector.slice(1), limit: 10 },
    { spaceId: SPACE_ID, values: [...vector.slice(0, -1), Number.NaN], limit: 10 },
    { spaceId: SPACE_ID, values: [...vector.slice(0, -1), Number.POSITIVE_INFINITY], limit: 10 },
    { spaceId: SPACE_ID, values: vector, limit: 0 },
    { spaceId: SPACE_ID, values: vector, limit: 101 },
    { spaceId: SPACE_ID, values: vector, limit: 1.5 },
  ])('rejects an invalid vector query before the database boundary', (query) => {
    const databaseCall = vi.fn();
    expect(() => {
      validateVectorQuery(query);
      databaseCall();
    }).toThrow(InvalidStorageInputError);
    expect(databaseCall).not.toHaveBeenCalled();
  });

  it.each([0, 5, 1.5])('rejects traversal depth %s before the database boundary', (maxDepth) => {
    const databaseCall = vi.fn();
    expect(() => {
      validateTraversalSpec({ startNodeId: NODE_ID, maxDepth });
      databaseCall();
    }).toThrow(InvalidStorageInputError);
    expect(databaseCall).not.toHaveBeenCalled();
  });

  it('rejects invalid vector upsert identifiers and dimensions before the database boundary', () => {
    expect(() => validateVectorUpsert('not-a-uuid', SPACE_ID, vector)).toThrow(InvalidStorageInputError);
    expect(() => validateVectorUpsert(NODE_ID, 'not-a-uuid', vector)).toThrow(InvalidStorageInputError);
    expect(() => validateVectorUpsert(NODE_ID, SPACE_ID, vector.slice(1))).toThrow(InvalidStorageInputError);
  });

  it('rejects mismatched spaces as access denial', () => {
    expect(() => assertSameSpace(SPACE_ID, OTHER_SPACE_ID)).toThrow(AccessDeniedError);
  });
});

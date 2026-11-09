import { describe, expect, it, vi } from 'vitest';
import { AccessContextPolicy, InvalidAccessContextError } from '../../src/storage/access-context.policy.js';
import { InvalidStorageInputError, validateVectorQuery, validateVectorUpsert } from '../../src/storage/storage-input.validation.js';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '44444444-4444-4444-8444-444444444444';

function oversizedArray<T>(length: number, value: T) {
  const values = Array.from({ length }, () => value);
  const readElement = vi.fn(() => value);
  Object.defineProperty(values, 0, { get: readElement });
  return { values, readElement };
}

describe('collection bounds reject before element validation', () => {
  it.each(['allow', 'deny'] as const)('rejects oversized %s grants without reading elements', (kind) => {
    const { values, readElement } = oversizedArray(1_001, { spaceId: SPACE_ID, capability: 'read' });
    const context = {
      subjectId: SUBJECT_ID,
      level: 20,
      spaceGrants: { allow: [], deny: [], [kind]: values },
    };
    expect(() => new AccessContextPolicy().validate(context)).toThrow(InvalidAccessContextError);
    expect(readElement).not.toHaveBeenCalled();
  });

  it('rejects oversized vector queries without reading elements', () => {
    const { values, readElement } = oversizedArray(1_025, 0);
    expect(() => validateVectorQuery({ spaceId: SPACE_ID, values, limit: 10 })).toThrow(InvalidStorageInputError);
    expect(readElement).not.toHaveBeenCalled();
  });

  it('rejects oversized vector upserts without reading elements', () => {
    const { values, readElement } = oversizedArray(1_025, 0);
    expect(() => validateVectorUpsert(NODE_ID, SPACE_ID, values)).toThrow(InvalidStorageInputError);
    expect(readElement).not.toHaveBeenCalled();
  });
});

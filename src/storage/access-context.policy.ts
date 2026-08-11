import { z } from 'zod';
import type { AccessContext, Capability, SpaceGrantRef } from './ports/access-context.js';
import { AccessDeniedError, InvalidAccessContextError, InvalidStorageInputError } from './storage.errors.js';
import { validateUuid } from './storage-input.validation.js';

export { AccessDeniedError, InvalidAccessContextError } from './storage.errors.js';

const CapabilitySchema = z.enum(['read', 'write', 'admin']);
const SpaceGrantRefSchema = z.object({
  spaceId: z.uuid(),
  capability: CapabilitySchema,
}).strict();
const AccessContextSchema = z.object({
  subjectId: z.uuid(),
  level: z.number().int().nonnegative().max(32_767),
  spaceGrants: z.object({
    allow: z.array(SpaceGrantRefSchema).max(1_000),
    deny: z.array(SpaceGrantRefSchema).max(1_000),
  }).strict(),
}).strict();

export class AccessContextPolicy {
  canRead(context: AccessContext, spaceId: string, requiredLevel: number): boolean {
    const validated = this.validate(context);
    const validatedSpaceId = validateUuid(spaceId, 'spaceId');
    if (!Number.isInteger(requiredLevel) || requiredLevel < 0 || requiredLevel > 32_767) {
      throw new InvalidStorageInputError('requiredLevel');
    }

    const denied = hasGrant(validated.spaceGrants.deny, validatedSpaceId, ['read', 'admin']);
    if (denied) return false;

    return hasGrant(validated.spaceGrants.allow, validatedSpaceId, ['read', 'admin'])
      || validated.level >= requiredLevel;
  }

  assertCanWrite(context: AccessContext, spaceId: string): void {
    const validated = this.validate(context);
    const validatedSpaceId = validateUuid(spaceId, 'spaceId');
    const capabilities: readonly Capability[] = ['write', 'admin'];
    const denied = hasGrant(validated.spaceGrants.deny, validatedSpaceId, capabilities);
    const allowed = hasGrant(validated.spaceGrants.allow, validatedSpaceId, capabilities);
    if (denied || !allowed) throw new AccessDeniedError();
  }

  validate(context: unknown): AccessContext {
    const result = AccessContextSchema.safeParse(context);
    if (!result.success) throw new InvalidAccessContextError();
    return result.data;
  }
}

function hasGrant(
  grants: readonly SpaceGrantRef[],
  spaceId: string,
  capabilities: readonly Capability[],
): boolean {
  return grants.some((grant) => grant.spaceId === spaceId && capabilities.includes(grant.capability));
}

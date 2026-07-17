// The initial seed is part of the additive SQL migration so deploy and rollback
// remain one auditable unit. This file documents the Prisma seed entry point.
export const INITIAL_ACCESS_LEVELS = ['public', 'archivist', 'council', 'holocron'] as const;
export const INITIAL_ROOT_SPACE = 'arcanada';


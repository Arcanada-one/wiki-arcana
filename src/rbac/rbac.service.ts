export const ACCESS_LEVELS = {
  public: 0,
  archivist: 10,
  council: 20,
  holocron: 30,
} as const;

export type AccessLevelSlug = keyof typeof ACCESS_LEVELS;

export function levelOrdinal(slug: AccessLevelSlug): number {
  return ACCESS_LEVELS[slug];
}

export interface AccessDecisionInput {
  hasScope: boolean;
  subjectLevel: number;
  requiredLevel: number;
  explicitAllow: boolean;
  explicitDeny: boolean;
}

export function evaluateAccess(input: AccessDecisionInput): boolean {
  if (!input.hasScope || input.explicitDeny) return false;
  return input.explicitAllow || input.subjectLevel >= input.requiredLevel;
}


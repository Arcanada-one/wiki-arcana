export type Capability = 'read' | 'write' | 'admin';

export interface SpaceGrantRef {
  spaceId: string;
  capability: Capability;
}

export interface GrantSet {
  allow: readonly SpaceGrantRef[];
  deny: readonly SpaceGrantRef[];
}

export interface AccessContext {
  subjectId: string;
  level: number;
  spaceGrants: GrantSet;
}


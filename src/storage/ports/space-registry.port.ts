import type { AccessContext, Capability } from './access-context.js';

export interface KnowledgeSpace {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  requiredLevel: string;
}

export interface SpaceGrant {
  spaceId: string;
  subjectType: 'user' | 'role';
  subjectId: string;
  effect: 'allow' | 'deny';
  capability: Capability;
}

export interface SpaceRegistryPort {
  listSpaces(context: AccessContext, capability?: Capability): Promise<readonly KnowledgeSpace[]>;
  getSpace(context: AccessContext, spaceId: string): Promise<KnowledgeSpace | null>;
  addGrant(grant: SpaceGrant): Promise<void>;
  removeGrant(grant: SpaceGrant): Promise<void>;
  moveSpace(spaceId: string, parentId: string | null): Promise<void>;
}


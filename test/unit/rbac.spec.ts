import { describe, expect, it } from 'vitest';
import { evaluateAccess, levelOrdinal } from '../../src/rbac/rbac.service.js';

describe('RBAC evaluation', () => {
  it('resolves stable clearance slugs to spaced ordinals', () => {
    expect(levelOrdinal('public')).toBe(0);
    expect(levelOrdinal('archivist')).toBe(10);
    expect(levelOrdinal('council')).toBe(20);
    expect(levelOrdinal('holocron')).toBe(30);
  });

  it('allows sufficient rank when scope exists', () => {
    expect(evaluateAccess({ hasScope: true, subjectLevel: 20, requiredLevel: 10, explicitAllow: false, explicitDeny: false })).toBe(true);
  });

  it('honors an explicit allow below rank', () => {
    expect(evaluateAccess({ hasScope: true, subjectLevel: 0, requiredLevel: 20, explicitAllow: true, explicitDeny: false })).toBe(true);
  });

  it('makes denial win over rank and allowance', () => {
    expect(evaluateAccess({ hasScope: true, subjectLevel: 30, requiredLevel: 0, explicitAllow: true, explicitDeny: true })).toBe(false);
  });

  it('never grants without the capability scope', () => {
    expect(evaluateAccess({ hasScope: false, subjectLevel: 30, requiredLevel: 0, explicitAllow: true, explicitDeny: false })).toBe(false);
  });
});


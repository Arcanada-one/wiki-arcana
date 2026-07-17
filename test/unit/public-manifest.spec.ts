import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const required = [
  'README.md', 'LICENSE', 'SECURITY.md', 'accepted-risk.yml', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CODEOWNERS', 'auth.dependencies.yaml',
];

describe('public manifest', () => {
  it.each(required)('contains %s', (file) => {
    expect(() => readFileSync(resolve(root, file), 'utf8')).not.toThrow();
  });

  it('does not expose internal task identifiers', () => {
    const text = required.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n');
    expect(text).not.toMatch(/\b(?:WIKI|AUTH|ARCA|INFRA|TUNE)-\d{4}\b/);
  });
});


import { describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT } from '../fixtures/setup.js';

describe('where targeting guardrails', () => {
  it('keeps bulk --where evaluation out of direct expression matching', async () => {
    const filePath = join(PROJECT_ROOT, 'src/lib/bulk/execute.ts');
    const source = await readFile(filePath, 'utf-8');
    expect(source).not.toContain('matchesExpression(');
    expect(source).not.toContain('validateWhereExpressions(');
  });

  it('keeps command-level where filtering routed through shared helper', async () => {
    const targets = [
      'src/commands/search.ts',
      'src/lib/audit/detection.ts',
      'src/lib/targeting.ts',
    ];

    for (const relativePath of targets) {
      const source = await readFile(join(PROJECT_ROOT, relativePath), 'utf-8');
      expect(source).not.toContain('applyFrontmatterFilters(');
      expect(source).not.toContain('matchesExpression(');
      expect(source).not.toContain('validateWhereExpressions(');
    }
  });

  it('keeps direct frontmatter filtering encapsulated in where-targeting', async () => {
    const querySource = await readFile(join(PROJECT_ROOT, 'src/lib/query.ts'), 'utf-8');
    const whereSource = await readFile(join(PROJECT_ROOT, 'src/lib/where-targeting.ts'), 'utf-8');

    expect(whereSource).toContain('applyFrontmatterFilters(');
    expect(querySource).not.toContain('silent: true');
  });
});

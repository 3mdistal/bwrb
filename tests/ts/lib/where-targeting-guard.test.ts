import { describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT } from '../fixtures/setup.js';

describe('where targeting guardrails', () => {
  it('keeps bulk --where evaluation out of direct expression matching', async () => {
    const filePath = join(PROJECT_ROOT, 'src/lib/bulk/execute.ts');
    const source = await readFile(filePath, 'utf-8');
    expect(source).not.toContain('matchesExpression(');
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
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { discoverManagedFiles } from '../../../src/lib/discovery.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { applyWhereExpressions } from '../../../src/lib/where-targeting.js';

describe('where targeting helper', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  async function getFilesWithFrontmatter(typePath?: string): Promise<Array<{ path: string; frontmatter: Record<string, unknown> }>> {
    const schema = await loadSchema(vaultDir);
    const files = await discoverManagedFiles(schema, vaultDir, typePath);

    const parsed: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
    for (const file of files) {
      const { frontmatter } = await parseNote(file.path);
      parsed.push({ path: file.path, frontmatter });
    }
    return parsed;
  }

  it('fails fast for typed unknown fields', async () => {
    const schema = await loadSchema(vaultDir);
    const files = await getFilesWithFrontmatter('idea');

    const result = await applyWhereExpressions(files, {
      schema,
      typePath: 'idea',
      whereExpressions: ["unknown_field == 'x'"],
      vaultDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown field 'unknown_field'");
      expect(result.error).toContain("for type 'idea'");
    }
  });

  it('stays permissive without type', async () => {
    const schema = await loadSchema(vaultDir);
    const files = await getFilesWithFrontmatter();

    const result = await applyWhereExpressions(files, {
      schema,
      whereExpressions: ["unknown_field == 'x'"],
      vaultDir,
    });

    expect(result.ok).toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRawSchemaJson, writeSchema } from '../../../src/lib/schema-writer.js';

const vaults: string[] = [];

afterEach(async () => {
  await Promise.all(vaults.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('schema writer concurrency', () => {
  it('refuses a stale whole-schema write instead of losing a concurrent change', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'bwrb-schema-cas-'));
    vaults.push(vault);
    await mkdir(join(vault, '.bwrb'), { recursive: true });
    const schemaPath = join(vault, '.bwrb/schema.json');
    await writeFile(schemaPath, JSON.stringify({ version: 2, config: {}, types: {} }, null, 2));
    const first = await loadRawSchemaJson(vault);
    const stale = await loadRawSchemaJson(vault);
    first.config = { ...first.config, identity_store: 'frontmatter-v1' };
    await writeSchema(vault, first);
    stale.config = { ...stale.config, link_format: 'markdown' };

    await expect(writeSchema(vault, stale)).rejects.toThrow('Schema changed concurrently');
    expect(JSON.parse(await readFile(schemaPath, 'utf-8')).config.identity_store)
      .toBe('frontmatter-v1');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

describe('schema-derived fields through the public CLI', () => {
  let vaultDir: string;
  let samplePath: string;
  let sampleBefore: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
      types: { idea: { fields: Record<string, unknown> } };
    };
    Object.assign(schema.types.idea.fields, {
      importance: { prompt: 'number' },
      excitement: { prompt: 'number' },
      score: { derived: { expression: 'importance * 4 + excitement', type: 'number' } },
      query_day: { derived: { expression: 'today()', type: 'date' } },
    });
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));

    samplePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
    sampleBefore = (await readFile(samplePath, 'utf8')).replace(
      'status: raw\n',
      'status: raw\nimportance: 4\nexcitement: 3\nscore: 999\n'
    );
    await writeFile(samplePath, sampleBefore);

    const anotherPath = join(vaultDir, 'Ideas', 'Another Idea.md');
    await writeFile(
      anotherPath,
      (await readFile(anotherPath, 'utf8')).replace('status: backlog\n', 'status: backlog\nimportance: 2\n')
    );
  });

  afterAll(async () => cleanupTestVault(vaultDir));

  it('projects values into JSON, overwrites stale stored collisions, and leaves Markdown unchanged', async () => {
    const result = await runCLI(['list', '--type', 'idea', '--output', 'json', '--as-of', '2026-08-10'], vaultDir);
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const sample = rows.find((row) => row._name === 'Sample Idea');
    const another = rows.find((row) => row._name === 'Another Idea');
    expect(sample).toMatchObject({ score: 19, query_day: '2026-08-10' });
    expect(another).toMatchObject({ score: null, query_day: '2026-08-10' });
    expect(await readFile(samplePath, 'utf8')).toBe(sampleBefore);
  });

  it('uses the same virtual values for filtering, sorting, fields, and dashboards', async () => {
    const filtered = await runCLI([
      'list', '--type', 'idea', '--where', 'score > 10', '--sort', 'score', '--fields', 'score',
    ], vaultDir);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain('Sample Idea');
    expect(filtered.stdout).toContain('19');
    expect(filtered.stdout).not.toContain('Another Idea');

    await writeFile(join(vaultDir, '.bwrb', 'dashboards.json'), JSON.stringify({
      dashboards: { ranked: { type: 'idea', where: ['score > 10'], fields: ['score'] } },
    }, null, 2));
    const dashboard = await runCLI(['dashboard', 'ranked', '--as-of', '2026-08-10'], vaultDir);
    expect(dashboard.exitCode).toBe(0);
    expect(dashboard.stdout).toContain('Sample Idea');
    expect(dashboard.stdout).toContain('19');
    expect(dashboard.stdout).not.toContain('Another Idea');
  });

  it('rejects attempts to write or bulk-update a derived field', async () => {
    const edit = await runCLI([
      'edit', 'Sample Idea', '--json', '{"score":20}',
    ], vaultDir);
    expect(edit.exitCode).not.toBe(0);
    expect(`${edit.stdout}${edit.stderr}`.toLowerCase()).toContain('derived field');

    const bulk = await runCLI([
      'bulk', '--type', 'idea', '--set', 'score=20', '--execute',
    ], vaultDir);
    expect(bulk.exitCode).not.toBe(0);
    expect(`${bulk.stdout}${bulk.stderr}`.toLowerCase()).toContain('derived field');
    expect(await readFile(samplePath, 'utf8')).toBe(sampleBefore);
  });

  it('reports invalid query dates and stored derived values', async () => {
    const invalidDate = await runCLI([
      'list', '--type', 'idea', '--output', 'json', '--as-of', '2026-02-30',
    ], vaultDir);
    expect(invalidDate.exitCode).not.toBe(0);
    expect(`${invalidDate.stdout}${invalidDate.stderr}`).toContain('Invalid --as-of');

    const audit = await runCLI(['audit', '--type', 'idea', '--output', 'json'], vaultDir);
    expect(audit.exitCode).not.toBe(0);
    expect(`${audit.stdout}${audit.stderr}`).toContain('derived-field-persisted');
    expect(`${audit.stdout}${audit.stderr}`).toContain('score');
  });
});

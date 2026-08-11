import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { resolveTargets } from '../../../src/lib/targeting.js';
import { listObjects } from '../../../src/commands/list.js';
import * as discovery from '../../../src/lib/discovery.js';

describe('schema-derived fields through the public CLI', () => {
  let vaultDir: string;
  let samplePath: string;
  let sampleBefore: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
      types: {
        idea: { fields: Record<string, unknown> };
        task: { fields: Record<string, unknown> };
      };
    };
    Object.assign(schema.types.idea.fields, {
      importance: { prompt: 'number' },
      excitement: { prompt: 'number' },
      score: { derived: { expression: 'importance * 4 + excitement', type: 'number' } },
      query_day: { derived: { expression: 'today()', type: 'date' } },
      related: { prompt: 'relation', source: 'idea', multiple: true },
      has_active_related: {
        derived: { expression: "any(related, target.status == 'in-flight')", type: 'boolean' },
      },
    });
    Object.assign(schema.types.task.fields, {
      'depends-on': { prompt: 'relation', source: 'task', multiple: true },
      ready: {
        derived: { expression: "all(depends-on, target.status == 'settled')", type: 'boolean' },
      },
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
      (await readFile(anotherPath, 'utf8')).replace('status: backlog\n', 'status: in-flight\nimportance: 2\n')
    );
    await writeFile(samplePath, sampleBefore.replace('score: 999\n', 'score: 999\nrelated:\n  - "[[Another Idea]]"\n'));
    sampleBefore = await readFile(samplePath, 'utf8');

    const tasksDir = join(vaultDir, 'Objectives', 'Tasks');
    await mkdir(tasksDir, { recursive: true });
    await writeFile(join(tasksDir, 'Finished.md'), '---\ntype: task\nstatus: settled\n---\n');
    await writeFile(join(tasksDir, 'Blocked.md'), '---\ntype: task\nstatus: in-flight\ndepends-on:\n  - "[[Finished]]"\n---\n');
    await writeFile(join(tasksDir, 'Empty.md'), '---\ntype: task\nstatus: backlog\ndepends-on: []\n---\n');
    await writeFile(join(tasksDir, 'Waiting.md'), '---\ntype: task\nstatus: backlog\ndepends-on:\n  - "[[Blocked]]"\n---\n');
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

  it('supports direct and schema-derived one-hop relation quantifiers', async () => {
    const ideas = await runCLI([
      'list', '--type', 'idea', '--where', "any(related, target.status == 'in-flight')", '--output', 'json',
    ], vaultDir);
    expect(ideas.exitCode).toBe(0);
    expect((JSON.parse(ideas.stdout) as Array<{ _name: string }>).map(row => row._name)).toEqual(['Sample Idea']);

    const tasks = await runCLI([
      'list', '--type', 'task', '--where', 'ready == true', '--sort', 'ready', '--fields', 'ready', '--output', 'json',
    ], vaultDir);
    expect(tasks.exitCode).toBe(0);
    const rows = JSON.parse(tasks.stdout) as Array<Record<string, unknown>>;
    expect(rows.map(row => row._name).sort()).toEqual(['Blocked', 'Empty', 'Finished', 'Sample Task']);
    expect(rows.map(row => row._name)).not.toContain('Waiting');
    expect(rows.every(row => row.ready === true)).toBe(true);

    await writeFile(join(vaultDir, '.bwrb', 'dashboards.json'), JSON.stringify({
      dashboards: { ready: { type: 'task', where: ['ready == true'], fields: ['ready'] } },
    }, null, 2));
    const dashboard = await runCLI(['dashboard', 'ready'], vaultDir);
    expect(dashboard.exitCode).toBe(0);
    expect(dashboard.stdout).toContain('Blocked');
    expect(dashboard.stdout).not.toContain('Waiting');
  });

  it('shares one relation index across filtering and list projection', async () => {
    const schema = await loadSchema(vaultDir);
    const indexSpy = vi.spyOn(discovery, 'buildVaultNoteIndex');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const targets = await resolveTargets(
        { type: 'task', where: ['ready == true'] }, schema, vaultDir
      );
      expect(targets.error).toBeUndefined();
      await listObjects(schema, vaultDir, 'task', targets.files, {
        outputFormat: 'json',
        queryContext: targets.queryContext,
      });
      expect(indexSpy).toHaveBeenCalledTimes(1);
    } finally {
      indexSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('rejects a non-relation quantifier field without an explicit type filter', async () => {
    const result = await runCLI([
      'list', '--where', "any(status, target.status == 'settled')", '--output', 'json',
    ], vaultDir);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('is not a relation field');
  });

  it('fails closed when a relation target cannot be resolved', async () => {
    const broken = join(vaultDir, 'Objectives', 'Tasks', 'Broken.md');
    await writeFile(broken, '---\ntype: task\nstatus: backlog\ndepends-on:\n  - "[[Missing Task]]"\n---\n');
    const result = await runCLI([
      'list', '--type', 'task', '--where', 'ready == true', '--output', 'json',
    ], vaultDir);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Objectives/Tasks/Broken.md');
    expect(`${result.stdout}${result.stderr}`).toContain('Missing Task');
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

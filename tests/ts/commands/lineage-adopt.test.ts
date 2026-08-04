import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  cleanupTestVault,
  createTestVault,
  runCLI,
} from '../fixtures/setup.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { adoptLineage } from '../../../src/commands/lineage/adopt.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function noteRaw(options: {
  type?: string;
  id?: string;
  parent?: string;
  name?: string;
  extra?: string;
  body?: string;
} = {}): string {
  return `---\n` +
    `${options.type === undefined ? 'type: idea\n' : options.type ? `type: ${options.type}\n` : ''}` +
    `${options.id ? `id: ${options.id}\n` : ''}` +
    `${options.parent ? `forked-from: ${options.parent}\n` : ''}` +
    `${options.name ? `name: ${options.name}\n` : ''}` +
    `status: raw\n${options.extra ?? ''}---\n${options.body ?? ''}`;
}

describe('lineage adopt', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('defaults to a no-write dry run, then applies only IDs and provenance with stable JSON evidence', async () => {
    const parentPath = join(vaultDir, 'Ideas/Archive/Adopt Parent.md');
    const childPath = join(vaultDir, 'Ideas/Adopt Child.md');
    const parentRaw = '\uFEFF---\r\n# provider-safe parent\r\ntype: "idea" # keep quotes\r\nstatus: &raw raw\r\nprovider:\r\n  remote-id: abc-123\r\n---\r\nParent body --- # exact.\r\n';
    const childRaw = '\uFEFF---\r\ntype: "idea"\r\nstatus: raw\r\nprovider:\r\n  nested: [one, two]\r\nsummary: |-\r\n  do not fold me\r\n---\r\nChild prose.\r\n';
    await mkdir(join(vaultDir, 'Ideas/Archive'), { recursive: true });
    await writeFile(parentPath, parentRaw);
    await writeFile(childPath, childRaw);
    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
    const registryBefore = await readFile(registryPath, 'utf-8').catch(() => null);

    const preview = await runCLI([
      'lineage', 'adopt', 'Adopt Child', '--from', 'Adopt Parent', '--output', 'json',
    ], vaultDir);
    expect(preview.exitCode, preview.stderr || preview.stdout).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson).toMatchObject({
      success: true,
      mode: 'dry-run',
      child: { path: 'Ideas/Adopt Child.md', id_generated: true },
      parent: { path: 'Ideas/Archive/Adopt Parent.md', id_generated: true },
      body_invariance: {
        child: { unchanged: true },
        parent: { unchanged: true },
      },
    });
    expect(previewJson.changes.map((change: { field: string; status: string }) => [change.field, change.status]))
      .toEqual([['id', 'planned'], ['id', 'planned'], ['forked-from', 'planned']]);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
    expect(await readFile(childPath, 'utf-8')).toBe(childRaw);
    expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);

    const executed = await runCLI([
      'lineage', 'adopt', 'Adopt Child', '--from', 'Adopt Parent', '--execute', '--output', 'json',
    ], vaultDir);
    expect(executed.exitCode, executed.stderr || executed.stdout).toBe(0);
    const output = JSON.parse(executed.stdout);
    expect(output).toMatchObject({
      success: true,
      mode: 'execute',
      child: { path: 'Ideas/Adopt Child.md', id_generated: true },
      parent: { path: 'Ideas/Archive/Adopt Parent.md', id_generated: true },
      warnings: [],
    });
    expect(output.child.id).not.toBe(output.parent.id);
    expect(output.changes.every((change: { status: string }) => change.status === 'applied')).toBe(true);

    const parentAfter = await readFile(parentPath, 'utf-8');
    const childAfter = await readFile(childPath, 'utf-8');
    expect(parentAfter.replace(`id: ${output.parent.id}\r\n`, '')).toBe(parentRaw);
    expect(
      childAfter
        .replace(`forked-from: ${output.parent.id}\r\n`, '')
        .replace(`id: ${output.child.id}\r\n`, '')
    ).toBe(childRaw);
    expect((await parseNote(parentPath)).body).toBe('Parent body --- # exact.\r\n');
    expect((await parseNote(childPath)).body).toBe('Child prose.\r\n');

    const registry = (await readFile(registryPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
    expect(registry.filter(row => row.path === 'Ideas/Archive/Adopt Parent.md')).toHaveLength(1);
    expect(registry.filter(row => row.path === 'Ideas/Adopt Child.md')).toHaveLength(1);

    const lineage = await runCLI(['list', '--lineage', output.child.id, '--output', 'json'], vaultDir);
    expect(lineage.exitCode, lineage.stderr || lineage.stdout).toBe(0);
    expect(JSON.parse(lineage.stdout).nodes.map((node: { path: string }) => node.path))
      .toEqual(['Ideas/Archive/Adopt Parent.md', 'Ideas/Adopt Child.md']);

    const audit = await runCLI(['audit', '--path', 'Ideas/Adopt Child.md', '--output', 'json'], vaultDir);
    expect(audit.exitCode, audit.stderr || audit.stdout).toBe(0);
    const codes = JSON.parse(audit.stdout).files.flatMap(
      (file: { issues: Array<{ code: string }> }) => file.issues.map(issue => issue.code)
    );
    expect(codes.filter((code: string) => code.includes('fork') || code.includes('lineage') || code.includes('note-id')))
      .toEqual([]);
  });

  it('adopts lineage in frontmatter-v1 without taking custody of the legacy registry', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const rawSchema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    rawSchema.config = { ...rawSchema.config, identity_store: 'frontmatter-v1' };
    await writeFile(schemaPath, JSON.stringify(rawSchema, null, 2));
    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
    const dirtyRegistry = '{"id":"unfinished","path":"Elsewhere.md"}\n';
    await writeFile(registryPath, dirtyRegistry);
    await writeFile(join(vaultDir, 'Ideas/Frontmatter Parent.md'), noteRaw({ id: A }));
    await writeFile(join(vaultDir, 'Ideas/Frontmatter Child.md'), noteRaw({ id: B }));

    const result = await runCLI([
      'lineage', 'adopt', 'Frontmatter Child', '--from', 'Frontmatter Parent',
      '--execute', '--output', 'json',
    ], vaultDir);

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(await readFile(registryPath, 'utf-8')).toBe(dirtyRegistry);
    expect((await parseNote(join(vaultDir, 'Ideas/Frontmatter Child.md'))).frontmatter['forked-from'])
      .toBe(A);
  });

  it('resolves child and parent by exact UUID, path, basename, name, and schema alias', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    schema.types.idea.fields.aliases = { prompt: 'list', alias: true };
    schema.types.idea.field_order.push('aliases');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));

    const selectors = [
      { child: A, parent: B },
      { child: 'Ideas/Resolve Child Path', parent: 'Ideas/Resolve Parent Path.md' },
      { child: 'Resolve Child Basename', parent: 'Resolve Parent Basename' },
      { child: 'Child Frontmatter Name', parent: 'Parent Frontmatter Name' },
      { child: 'Child Alias', parent: 'Parent Alias' },
    ];
    for (let index = 0; index < selectors.length; index++) {
      const childName = index === 1 ? 'Resolve Child Path' : index === 2 ? 'Resolve Child Basename' : `Resolve Child ${index}`;
      const parentName = index === 1 ? 'Resolve Parent Path' : index === 2 ? 'Resolve Parent Basename' : `Resolve Parent ${index}`;
      await writeFile(join(vaultDir, `Ideas/${childName}.md`), noteRaw({
        id: index === 0 ? A : undefined,
        name: index === 3 ? 'Child Frontmatter Name' : undefined,
        extra: index === 4 ? 'aliases: [Child Alias]\n' : undefined,
      }));
      await writeFile(join(vaultDir, `Ideas/${parentName}.md`), noteRaw({
        id: index === 0 ? B : undefined,
        name: index === 3 ? 'Parent Frontmatter Name' : undefined,
        extra: index === 4 ? 'aliases: [Parent Alias]\n' : undefined,
      }));
      const result = await runCLI([
        'lineage', 'adopt', selectors[index]!.child, '--from', selectors[index]!.parent,
        '--dry-run', '--output', 'json',
      ], vaultDir);
      expect(result.exitCode, `${index}: ${result.stderr || result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout).mode).toBe('dry-run');
    }
  });

  it.each([
    { label: 'neither', childId: undefined, parentId: undefined, generated: [true, true] },
    { label: 'child only', childId: A, parentId: undefined, generated: [false, true] },
    { label: 'parent only', childId: undefined, parentId: B, generated: [true, false] },
    { label: 'both', childId: C, parentId: D, generated: [false, false] },
  ])('preserves valid IDs and backfills the $label ID combination', async ({ label, childId, parentId, generated }) => {
    const suffix = label.replace(' ', '-');
    await writeFile(join(vaultDir, `Ideas/Combo Child ${suffix}.md`), noteRaw({ id: childId }));
    await writeFile(join(vaultDir, `Ideas/Combo Parent ${suffix}.md`), noteRaw({ id: parentId }));
    const result = await runCLI([
      'lineage', 'adopt', `Combo Child ${suffix}`, '--from', `Combo Parent ${suffix}`,
      '--execute', '--output', 'json',
    ], vaultDir);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const output = JSON.parse(result.stdout);
    expect([output.child.id_generated, output.parent.id_generated]).toEqual(generated);
    if (childId) expect(output.child.id).toBe(childId);
    if (parentId) expect(output.parent.id).toBe(parentId);
  });

  it('refuses self-edges, type mismatch, existing provenance, invalid IDs, and unsafe graph state without writes', async () => {
    const cases: Array<{ child: string; parent: string; expected: string }> = [];
    await writeFile(join(vaultDir, 'Ideas/Self.md'), noteRaw({ id: A }));
    cases.push({ child: 'Self', parent: A.toLowerCase(), expected: 'under itself' });

    await writeFile(join(vaultDir, 'Ideas/Idea Child.md'), noteRaw());
    cases.push({ child: 'Idea Child', parent: 'Sample Task', expected: 'across note types' });

    await writeFile(join(vaultDir, 'Ideas/Has Parent.md'), noteRaw({ id: B, parent: A }));
    cases.push({ child: 'Has Parent', parent: 'Self', expected: 'already has forked-from' });

    await writeFile(join(vaultDir, 'Ideas/Bad ID.md'), noteRaw({ id: 'not-a-uuid' }));
    cases.push({ child: 'Bad ID', parent: 'Self', expected: 'not a valid UUID' });

    await writeFile(join(vaultDir, 'Ideas/Bad Parent ID.md'), noteRaw({ id: 'still-not-a-uuid' }));
    cases.push({ child: 'Idea Child', parent: 'Bad Parent ID', expected: 'not a valid UUID' });

    for (const testCase of cases) {
      const childPath = testCase.child === 'Sample Task'
        ? join(vaultDir, 'Objectives/Tasks/Sample Task.md')
        : join(vaultDir, `Ideas/${testCase.child}.md`);
      const before = await readFile(childPath, 'utf-8');
      const result = await runCLI([
        'lineage', 'adopt', testCase.child, '--from', testCase.parent,
        '--execute', '--output', 'json',
      ], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toContain(testCase.expected);
      expect(await readFile(childPath, 'utf-8')).toBe(before);
    }

    await writeFile(join(vaultDir, 'Ideas/Duplicate A.md'), noteRaw({ id: C }));
    await writeFile(join(vaultDir, 'Ideas/Duplicate B.md'), noteRaw({ id: C.toLowerCase() }));
    const duplicate = await runCLI([
      'lineage', 'adopt', 'Idea Child', '--from', 'Self', '--execute', '--output', 'json',
    ], vaultDir);
    expect(duplicate.exitCode).toBe(1);
    expect(JSON.parse(duplicate.stdout).error).toContain('duplicate-note-id');

    await writeFile(join(vaultDir, 'Ideas/Duplicate B.md'), noteRaw({ id: D }));
    await writeFile(join(vaultDir, 'Ideas/Dangling.md'), noteRaw({ id: C, parent: '99999999-9999-4999-8999-999999999999' }));
    const dangling = await runCLI([
      'lineage', 'adopt', 'Idea Child', '--from', 'Self', '--output', 'json',
    ], vaultDir);
    expect(dangling.exitCode).toBe(1);
    expect(JSON.parse(dangling.stdout).error).toContain('dangling-forked-from');
  });

  it('refuses missing or invalid resolved types for either target role', async () => {
    await writeFile(join(vaultDir, 'Ideas/Untyped Child.md'), noteRaw({ type: '' }));
    await writeFile(join(vaultDir, 'Ideas/Invalid Child Type.md'), noteRaw({ type: 'not-a-type' }));
    await writeFile(join(vaultDir, 'Ideas/Untyped Parent.md'), noteRaw({ type: '' }));
    await writeFile(join(vaultDir, 'Ideas/Invalid Parent Type.md'), noteRaw({ type: 'not-a-type' }));

    for (const [child, parent, expected] of [
      ['Untyped Child', 'Sample Idea', 'Adoption child source does not have a valid schema type'],
      ['Invalid Child Type', 'Sample Idea', 'Adoption child source does not have a valid schema type'],
      ['Sample Idea', 'Untyped Parent', 'Adoption parent source does not have a valid schema type'],
      ['Sample Idea', 'Invalid Parent Type', 'Adoption parent source does not have a valid schema type'],
    ]) {
      const result = await runCLI([
        'lineage', 'adopt', child!, '--from', parent!, '--execute', '--output', 'json',
      ], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toContain(expected);
    }
  });

  it('rolls both note bytes back when atomic registry registration fails after backfill writes', async () => {
    const childPath = join(vaultDir, 'Ideas/Rollback Child.md');
    const parentPath = join(vaultDir, 'Ideas/Rollback Parent.md');
    const childRaw = noteRaw({ extra: 'provider: { remote: child }\n', body: 'Child bytes\n' });
    const parentRaw = noteRaw({ extra: 'provider: { remote: parent }\n', body: 'Parent bytes\n' });
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
    const registryBefore = await readFile(registryPath, 'utf-8').catch(() => null);
    const schema = await loadSchema(vaultDir);

    await expect(adoptLineage(
      schema,
      vaultDir,
      { child: 'Rollback Child', parent: 'Rollback Parent', execute: true },
      { registerIds: async () => { throw new Error('injected registry failure'); } }
    )).rejects.toThrow('injected registry failure');

    expect(await readFile(childPath, 'utf-8')).toBe(childRaw);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
    expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);
  });

  it('never rolls adoption back over bytes written after its own child write', async () => {
    const childPath = join(vaultDir, 'Ideas/Rollback Race Child.md');
    const parentPath = join(vaultDir, 'Ideas/Rollback Race Parent.md');
    const childRaw = noteRaw({ body: 'Original child bytes\n' });
    const parentRaw = noteRaw({ body: 'Original parent bytes\n' });
    const newerChildRaw = noteRaw({
      id: C,
      extra: 'provider: { newer: true }\n',
      body: 'Newer child bytes\n',
    });
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const schema = await loadSchema(vaultDir);

    await expect(adoptLineage(
      schema,
      vaultDir,
      { child: 'Rollback Race Child', parent: 'Rollback Race Parent', execute: true },
      {
        registerIds: async () => {
          await writeFile(childPath, newerChildRaw);
          throw new Error('injected registry failure after a newer writer');
        },
      }
    )).rejects.toThrow('newer bytes left as-is');

    expect(await readFile(childPath, 'utf-8')).toBe(newerChildRaw);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
  });

  it('refuses cycles and ambiguous or missing exact targets', async () => {
    await writeFile(join(vaultDir, 'Ideas/Cycle Root.md'), noteRaw({ id: A }));
    await writeFile(join(vaultDir, 'Ideas/Cycle Child.md'), noteRaw({ id: B, parent: A }));
    const cycle = await runCLI([
      'lineage', 'adopt', 'Cycle Root', '--from', 'Cycle Child', '--execute', '--output', 'json',
    ], vaultDir);
    expect(cycle.exitCode).toBe(1);
    expect(JSON.parse(cycle.stdout).error).toContain('would create a cycle');

    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
    await writeFile(join(vaultDir, 'Ideas/Ambiguous.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Nested/Ambiguous.md'), noteRaw());
    for (const [child, parent, noun] of [
      ['Ambiguous', 'Cycle Child', 'Ambiguous adoption child target'],
      ['Sample Idea', 'Ambiguous', 'Ambiguous adoption parent target'],
      ['Missing child', 'Cycle Child', 'No exact note found for adoption child target'],
      ['Sample Idea', 'Missing parent', 'No exact note found for adoption parent target'],
    ]) {
      const result = await runCLI([
        'lineage', 'adopt', child!, '--from', parent!, '--output', 'json',
      ], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toContain(noun);
    }
  });

  it('serializes competing adoptions so exactly one parent wins', async () => {
    await writeFile(join(vaultDir, 'Ideas/Race Child.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Race Parent A.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Race Parent B.md'), noteRaw());
    const results = await Promise.all([
      runCLI(['lineage', 'adopt', 'Race Child', '--from', 'Race Parent A', '--execute', '--output', 'json'], vaultDir),
      runCLI(['lineage', 'adopt', 'Race Child', '--from', 'Race Parent B', '--execute', '--output', 'json'], vaultDir),
    ]);
    expect(results.map(result => result.exitCode).sort()).toEqual([0, 1]);
    expect(JSON.parse(results.find(result => result.exitCode === 1)!.stdout).error)
      .toContain('already has forked-from');
    const child = await parseNote(join(vaultDir, 'Ideas/Race Child.md'));
    expect(child.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(child.frontmatter['forked-from']).toMatch(/^[0-9a-f-]{36}$/i);
    const parentIds = await Promise.all([
      parseNote(join(vaultDir, 'Ideas/Race Parent A.md')),
      parseNote(join(vaultDir, 'Ideas/Race Parent B.md')),
    ]).then(notes => notes.map(note => note.frontmatter.id).filter(Boolean));
    expect(parentIds).toContain(child.frontmatter['forked-from']);
    const registry = (await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf-8'))
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(registry.filter(row => row.path === 'Ideas/Race Child.md')).toHaveLength(1);
  });

  it('stays consistent when adoption races fork and non-force deletion', async () => {
    await writeFile(join(vaultDir, 'Ideas/Shared Parent.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Existing Child.md'), noteRaw());
    const [adopt, fork] = await Promise.all([
      runCLI(['lineage', 'adopt', 'Existing Child', '--from', 'Shared Parent', '--execute', '--output', 'json'], vaultDir),
      runCLI(['new', '--fork', 'Shared Parent', '--name', 'New Fork Child', '--output', 'json'], vaultDir),
    ]);
    expect(adopt.exitCode, adopt.stderr || adopt.stdout).toBe(0);
    expect(fork.exitCode, fork.stderr || fork.stdout).toBe(0);
    expect(JSON.parse(adopt.stdout).parent.id).toBe(JSON.parse(fork.stdout).forked_from);

    await writeFile(join(vaultDir, 'Ideas/Delete Race Parent.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Delete Race Child.md'), noteRaw());
    const [raceAdopt, raceDelete] = await Promise.all([
      runCLI(['lineage', 'adopt', 'Delete Race Child', '--from', 'Delete Race Parent', '--execute', '--output', 'json'], vaultDir),
      runCLI(['delete', '--path', 'Ideas/Delete Race Parent.md', '--execute', '--output', 'json'], vaultDir),
    ]);
    expect([0, 1]).toContain(raceAdopt.exitCode);
    expect([0, 1]).toContain(raceDelete.exitCode);
    expect(raceAdopt.exitCode === 0 || raceDelete.exitCode === 0).toBe(true);

    const audit = await runCLI(['audit', 'idea', '--output', 'json'], vaultDir);
    const issues = JSON.parse(audit.stdout).files.flatMap(
      (file: { issues: Array<{ code: string }> }) => file.issues
    );
    expect(issues.filter((issue: { code: string }) => issue.code === 'dangling-forked-from')).toEqual([]);
  });

  it('rejects conflicting execution flags and unsupported output formats', async () => {
    const conflict = await runCLI([
      'lineage', 'adopt', 'Sample Idea', '--from', 'Another Idea',
      '--dry-run', '--execute', '--output', 'json',
    ], vaultDir);
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout).error).toContain('cannot be combined');

    const output = await runCLI([
      'lineage', 'adopt', 'Sample Idea', '--from', 'Another Idea', '--output', 'yaml',
    ], vaultDir);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('--output must be text or json');

    const missingFrom = await runCLI([
      'lineage', 'adopt', 'Sample Idea', '--output', 'json',
    ], vaultDir);
    expect(missingFrom.exitCode).toBe(1);
    expect(JSON.parse(missingFrom.stdout).error).toContain('--from <parent> is required');
  });
});

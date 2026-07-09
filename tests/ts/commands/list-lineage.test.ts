import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  cleanupTestVault,
  createTestVault,
  runCLI,
} from '../fixtures/setup.js';

const A = 'ABCDEF12-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = 'CCCCCCCC-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = 'EEEEEEEE-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
const BRANCHED_PATHS = [
  'Ideas/Lineage A.md',
  'Ideas/Lineage B.md',
  'Ideas/Lineage C.md',
  'Ideas/Lineage D.md',
  'Ideas/Lineage E.md',
  'Ideas/Lineage F.md',
];
const BRANCHED_TARGETS = ['Lineage A', 'Lineage B', 'Lineage C', 'Lineage F'];

function raw(id: unknown, parent?: unknown, body = ''): string {
  return `---\ntype: idea\n${id !== undefined ? `id: ${String(id)}\n` : ''}${parent !== undefined ? `forked-from: ${String(parent)}\n` : ''}status: raw\n---\n${body}`;
}

async function addCollateralBranch(vaultDir: string): Promise<void> {
  await writeFile(join(vaultDir, 'Ideas/Lineage E.md'), raw(E, A, 'E body\n'));
  await writeFile(join(vaultDir, 'Ideas/Lineage F.md'), raw(F, E, 'F body\n'));
}

describe('list --lineage', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    await writeFile(join(vaultDir, 'Ideas/Lineage A.md'), `---
type: idea
id: ${A}
name: Original Name
status: raw
---
A body
`);
    await writeFile(join(vaultDir, 'Ideas/Lineage B.md'), raw(B, A.toLowerCase(), 'B body\n'));
    await writeFile(join(vaultDir, 'Ideas/Lineage C.md'), raw(C, B, 'C body\n'));
    await writeFile(join(vaultDir, 'Ideas/Lineage D.md'), raw(D, B, 'D body\n'));
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('returns the stable JSON graph by exact path, basename, name, alias, and UUID', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    schema.types.idea.fields.aliases = { prompt: 'list', alias: true };
    schema.types.idea.field_order.push('aliases');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));
    await writeFile(join(vaultDir, 'Ideas/Lineage B.md'), `---
type: idea
id: ${B}
name: Middle Name
aliases: [Middle Alias]
forked-from: ${A.toLowerCase()}
status: raw
---
B body
`);

    for (const target of [
      'Ideas/Lineage B',
      join(vaultDir, 'Ideas/Lineage B.md'),
      'Lineage B',
      'Middle Name',
      'Middle Alias',
      B.toLowerCase(),
    ]) {
      const result = await runCLI(['list', '--lineage', target, '--output', 'json'], vaultDir);
      expect(result.exitCode, `${target}: ${result.stderr || result.stdout}`).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(result.stdout);
      expect(output).toEqual({
        target: { path: 'Ideas/Lineage B.md', id: B },
        nodes: [
          { path: 'Ideas/Lineage A.md', id: A, forked_from: null, depth: -1, relationship: 'ancestor' },
          { path: 'Ideas/Lineage B.md', id: B, forked_from: A.toLowerCase(), depth: 0, relationship: 'target' },
          { path: 'Ideas/Lineage C.md', id: C, forked_from: B, depth: 1, relationship: 'descendant' },
          { path: 'Ideas/Lineage D.md', id: D, forked_from: B, depth: 1, relationship: 'descendant' },
        ],
        warnings: [],
      });
    }
  });

  it('returns one identical JSON family from root, middle, and leaves', async () => {
    await addCollateralBranch(vaultDir);
    const jsonByTarget = new Map<string, any>();

    for (const target of BRANCHED_TARGETS) {
      const json = await runCLI(['list', '--lineage', target, '--output', 'json'], vaultDir);
      expect(json.exitCode, json.stderr || json.stdout).toBe(0);
      const output = JSON.parse(json.stdout);
      jsonByTarget.set(target, output);
      expect(output.nodes.map((node: any) => node.path)).toEqual(BRANCHED_PATHS);
    }

    expect(jsonByTarget.get('Lineage B').nodes).toMatchObject([
      { path: 'Ideas/Lineage A.md', depth: -1, relationship: 'ancestor' },
      { path: 'Ideas/Lineage B.md', depth: 0, relationship: 'target' },
      { path: 'Ideas/Lineage C.md', depth: 1, relationship: 'descendant' },
      { path: 'Ideas/Lineage D.md', depth: 1, relationship: 'descendant' },
      { path: 'Ideas/Lineage E.md', depth: 0, relationship: 'related' },
      { path: 'Ideas/Lineage F.md', depth: 1, relationship: 'related' },
    ]);
    expect(jsonByTarget.get('Lineage C').nodes).toMatchObject([
      { path: 'Ideas/Lineage A.md', depth: -2, relationship: 'ancestor' },
      { path: 'Ideas/Lineage B.md', depth: -1, relationship: 'ancestor' },
      { path: 'Ideas/Lineage C.md', depth: 0, relationship: 'target' },
      { path: 'Ideas/Lineage D.md', depth: 0, relationship: 'related' },
      { path: 'Ideas/Lineage E.md', depth: -1, relationship: 'related' },
      { path: 'Ideas/Lineage F.md', depth: 0, relationship: 'related' },
    ]);
    expect(jsonByTarget.get('Lineage F').nodes).toMatchObject([
      { path: 'Ideas/Lineage A.md', depth: -2, relationship: 'ancestor' },
      { path: 'Ideas/Lineage B.md', depth: -1, relationship: 'related' },
      { path: 'Ideas/Lineage C.md', depth: 0, relationship: 'related' },
      { path: 'Ideas/Lineage D.md', depth: 0, relationship: 'related' },
      { path: 'Ideas/Lineage E.md', depth: -1, relationship: 'ancestor' },
      { path: 'Ideas/Lineage F.md', depth: 0, relationship: 'target' },
    ]);
  });

  it.each(['paths', 'link', 'content'] as const)(
    'returns identical %s output from root, middle, and leaves',
    async outputFormat => {
      await addCollateralBranch(vaultDir);
      const outputs: string[] = [];
      for (const target of BRANCHED_TARGETS) {
        const result = await runCLI(
          ['list', '--lineage', target, '--output', outputFormat],
          vaultDir
        );
        expect(result.exitCode, result.stderr || result.stdout).toBe(0);
        outputs.push(result.stdout);
      }
      expect(new Set(outputs).size).toBe(1);

      if (outputFormat === 'paths') {
        expect(outputs[0]!.trim().split('\n')).toEqual(BRANCHED_PATHS);
      } else if (outputFormat === 'link') {
        expect(outputs[0]!.trim().split('\n')).toEqual(
          BRANCHED_PATHS.map(path => `[[${path.slice('Ideas/'.length, -3)}]]`)
        );
      } else {
        for (const body of ['A body', 'B body', 'C body', 'D body', 'E body', 'F body']) {
          expect(outputs[0]).toContain(body);
        }
      }
    }
  );

  it('renders one identical tree from root, middle, and leaves', async () => {
    await addCollateralBranch(vaultDir);
    const trees: string[] = [];
    for (const target of BRANCHED_TARGETS) {
      const tree = await runCLI(['list', '--lineage', target, '--output', 'tree'], vaultDir);
      expect(tree.exitCode, tree.stderr || tree.stdout).toBe(0);
      trees.push(tree.stdout.replace(' (target)', ''));
    }
    expect(new Set(trees).size).toBe(1);
  });

  it('renders default and explicit tree output with target markers at root, middle, and leaf', async () => {
    for (const [target, marker] of [
      ['Lineage A', 'Ideas/Lineage A.md (target)'],
      ['Lineage B', 'Ideas/Lineage B.md (target)'],
      ['Lineage C', 'Ideas/Lineage C.md (target)'],
    ]) {
      for (const suffix of [[], ['--output', 'default'], ['--output', 'tree']]) {
        const result = await runCLI(['list', '--lineage', target, ...suffix], vaultDir);
        expect(result.exitCode, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain(marker);
        expect((result.stdout.match(/\(target\)/g) ?? [])).toHaveLength(1);
      }
    }
  });

  it('supports paths, link, and content output in lineage order', async () => {
    const paths = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'paths'], vaultDir);
    expect(paths.stdout.trim().split('\n')).toEqual([
      'Ideas/Lineage A.md',
      'Ideas/Lineage B.md',
      'Ideas/Lineage C.md',
      'Ideas/Lineage D.md',
    ]);

    const links = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'link'], vaultDir);
    expect(links.stdout.trim().split('\n')).toEqual([
      '[[Lineage A]]', '[[Lineage B]]', '[[Lineage C]]', '[[Lineage D]]',
    ]);

    const content = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'content'], vaultDir);
    expect(content.stdout.indexOf('A body')).toBeLessThan(content.stdout.indexOf('B body'));
    expect(content.stdout.indexOf('B body')).toBeLessThan(content.stdout.indexOf('C body'));
    expect(content.stdout).toContain('D body');
  });

  it('renders a single un-forked target', async () => {
    const result = await runCLI(['list', '--lineage', A, '--output', 'json'], vaultDir);
    const output = JSON.parse(result.stdout);
    expect(output.nodes).toHaveLength(4);

    await writeFile(join(vaultDir, 'Ideas/Isolated.md'), raw('55555555-5555-4555-8555-555555555555'));
    const isolated = await runCLI(['list', '--lineage', 'Isolated', '--output', 'json'], vaultDir);
    expect(JSON.parse(isolated.stdout).nodes).toEqual([
      {
        path: 'Ideas/Isolated.md',
        id: '55555555-5555-4555-8555-555555555555',
        forked_from: null,
        depth: 0,
        relationship: 'target',
      },
    ]);
  });

  it('includes malformed-id children as terminals and reports warnings by channel', async () => {
    await writeFile(join(vaultDir, 'Ideas/No ID child.md'), raw(undefined, B));
    await writeFile(join(vaultDir, 'Ideas/Bad ID child.md'), raw('nope', B));

    const json = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'json'], vaultDir);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe('');
    const output = JSON.parse(json.stdout);
    expect(output.nodes.filter((node: any) => node.id === null).map((node: any) => node.path)).toEqual([
      'Ideas/Bad ID child.md', 'Ideas/No ID child.md',
    ]);
    expect(output.warnings.filter((warning: any) => warning.code === 'missing-lineage-id')).toHaveLength(2);

    const text = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'paths'], vaultDir);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain('Warning [missing-lineage-id]');
    expect(text.stdout).toContain('Ideas/No ID child.md');
  });

  it('bounds cycles and warns without duplicating a physical note', async () => {
    await writeFile(join(vaultDir, 'Ideas/Lineage A.md'), raw(A, C));
    const result = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'json'], vaultDir);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.warnings.some((warning: any) => warning.code === 'fork-cycle')).toBe(true);
    expect(new Set(output.nodes.map((node: any) => node.path)).size).toBe(output.nodes.length);
  });

  it('warns on dangling and invalid source metadata with exit zero', async () => {
    await writeFile(join(vaultDir, 'Ideas/Dangling.md'), raw('66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'));
    await writeFile(join(vaultDir, 'Ideas/Invalid parent.md'), raw('88888888-8888-4888-8888-888888888888', 'wat'));

    for (const [target, code] of [['Dangling', 'dangling-forked-from'], ['Invalid parent', 'invalid-forked-from']]) {
      const result = await runCLI(['list', '--lineage', target, '--output', 'json'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).warnings).toMatchObject([{ code }]);
    }
  });

  it('hard-errors on reached duplicate IDs but ignores unrelated duplicate identities', async () => {
    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
    await writeFile(join(vaultDir, 'Ideas/Nested/Duplicate C.md'), raw(C.toLowerCase(), D));
    let result = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'json'], vaultDir);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('note id');
    expect(JSON.parse(result.stdout).error).toContain('Ideas/Lineage C.md');
    expect(JSON.parse(result.stdout).error).toContain('Ideas/Nested/Duplicate C.md');

    await writeFile(join(vaultDir, 'Ideas/Nested/Duplicate C.md'), raw('99999999-9999-4999-8999-999999999999'));
    await writeFile(join(vaultDir, 'Ideas/Nested/Unrelated duplicate.md'), raw('99999999-9999-4999-8999-999999999999'));
    result = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'json'], vaultDir);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  });

  it('rejects targets with missing or malformed IDs and never fuzzy-substitutes', async () => {
    await writeFile(join(vaultDir, 'Ideas/No target ID.md'), raw(undefined));
    await writeFile(join(vaultDir, 'Ideas/Bad target ID.md'), raw('nope'));
    for (const target of ['No target ID', 'Bad target ID']) {
      const result = await runCLI(['list', '--lineage', target, '--output', 'json'], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, code: 1 });
      expect(JSON.parse(result.stdout).error).toContain('valid UUID id');
    }

    const fuzzy = await runCLI(['list', '--lineage', 'Lineag B', '--output', 'json'], vaultDir);
    expect(fuzzy.exitCode).toBe(1);
    expect(JSON.parse(fuzzy.stdout).error).toContain('No exact note found for lineage target');
  });

  it('reports ambiguous exact targets with all candidate paths', async () => {
    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
    await writeFile(join(vaultDir, 'Ideas/Nested/Lineage B.md'), raw('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'));
    const result = await runCLI(['list', '--lineage', 'Lineage B', '--output', 'json'], vaultDir);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stdout).error;
    expect(error).toContain('Ambiguous lineage target');
    expect(error).toContain('Ideas/Lineage B.md');
    expect(error).toContain('Ideas/Nested/Lineage B.md');
  });

  it.each([
    ['idea'],
    ['idea', 'print'],
    ['--type', 'idea'], ['--path', 'Ideas/**'], ['--where', 'status=raw'],
    ['--body', 'body'], ['--text', 'body'], ['--name', 'Lineage B'],
    ['--fuzzy', 'Lineage'], ['--matches'], ['--threshold', '0.5'],
    ['--context', '0'], ['--no-context'], ['--case-sensitive'], ['--regex'],
    ['--id', A], ['--fields', 'status'], ['--sort', 'name'], ['--desc'],
    ['--limit', '1'], ['--count'], ['--roots'], ['--children-of', 'Lineage A'],
    ['--descendants-of', 'Lineage A'], ['--tree'], ['--depth', '1'],
    ['--open'], ['--app', 'print'], ['--picker', 'none'], ['--preview'],
    ['--save-as', 'x'], ['--force'], ['--json'], ['--paths'],
    ['--output', 'text'], ['--output', 'bogus'],
  ])('rejects conflicting or noncanonical lineage arguments: %s', async (...conflict) => {
    const args = ['list', '--lineage', 'Lineage B', ...conflict];
    // Canonical JSON is allowed solely to verify JSON-aware validation.
    if (!conflict.includes('--json') && conflict[0] !== '--output') args.push('--output', 'json');
    const result = await runCLI(args, vaultDir);
    expect(result.exitCode).toBe(1);
    if (args.includes('--json') || (args.includes('--output') && args[args.indexOf('--output') + 1] === 'json')) {
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, code: 1 });
    } else {
      expect(result.stderr).toContain('--lineage');
    }
  });

  it.each([1, 2, 3, 4])(
    'rejects %i extra positional argument(s) through JSON and text channels',
    async count => {
      const extras = Array.from({ length: count }, (_, index) => `extra-${index + 1}`);
      const json = await runCLI(
        ['list', '--lineage', 'Lineage B', ...extras, '--output', 'json'],
        vaultDir
      );
      expect(json.exitCode).toBe(1);
      expect(json.stderr).toBe('');
      expect(JSON.parse(json.stdout)).toMatchObject({ success: false, code: 1 });

      const text = await runCLI(['list', '--lineage', 'Lineage B', ...extras], vaultDir);
      expect(text.exitCode).toBe(1);
      expect(text.stdout).toBe('');
      expect(text.stderr).toMatch(/--lineage|too many arguments/);
    }
  );

  it('creates a disposable chain through new --fork and reads it through lineage and audit', async () => {
    const first = await runCLI(['new', '--fork', 'Lineage A', '--name', 'Actual Fork 1', '--output', 'json'], vaultDir);
    expect(first.exitCode, first.stderr || first.stdout).toBe(0);
    const second = await runCLI(['new', '--fork', 'Actual Fork 1', '--name', 'Actual Fork 2', '--output', 'json'], vaultDir);
    expect(second.exitCode, second.stderr || second.stdout).toBe(0);

    const lineage = await runCLI(['list', '--lineage', 'Actual Fork 1', '--output', 'json'], vaultDir);
    const output = JSON.parse(lineage.stdout);
    expect(output.nodes.map((node: any) => node.path)).toContain('Ideas/Actual Fork 2.md');
    const audit = await runCLI(['audit', '--path', 'Ideas/Actual Fork 2.md', '--output', 'json'], vaultDir);
    expect(audit.exitCode, audit.stderr || audit.stdout).toBe(0);
    expect(JSON.parse(audit.stdout).files.flatMap((file: any) => file.issues).map((issue: any) => issue.code))
      .not.toContain('dangling-forked-from');
  });

  it('documents lineage on list help without adding a top-level command', async () => {
    const listHelp = await runCLI(['list', '--help'], vaultDir);
    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain('--lineage <target>');

    const topHelp = await runCLI(['--help'], vaultDir);
    expect(topHelp.exitCode).toBe(0);
    expect(topHelp.stdout).not.toMatch(/^\s+lineage(?:\s|$)/m);
  });
});

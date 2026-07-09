import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  cleanupTestVault,
  createTestVault,
  runCLI,
} from '../fixtures/setup.js';
import { parseNote } from '../../../src/lib/frontmatter.js';

const SOURCE_ID = 'ABCDEF12-3456-4789-ABCD-EF1234567890';

describe('new --fork', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('forks by case-insensitive UUID, copies content, resets state and aliases, and reports drift', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    schema.types.idea.fields.status.reset_on_fork = true;
    schema.types.idea.fields.status.default = 'raw';
    schema.types.idea.fields.aliases = { prompt: 'list', alias: true };
    schema.types.idea.field_order.push('aliases');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));

    const sourcePath = join(vaultDir, 'Ideas/Source.md');
    await writeFile(sourcePath, `---
type: idea
id: ${SOURCE_ID}
name: A Different Name
status: settled
priority: high
aliases:
  - Source Alias
prev: Old
next: New
legacy-field: keep me
---
## Draft

Words worth keeping.
`);

    const result = await runCLI([
      'new', '--fork', SOURCE_ID.toLowerCase(), '--name', 'Forked Draft', '--output', 'json',
    ], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      success: true,
      path: 'Ideas/Forked Draft.md',
      forked_from: SOURCE_ID,
    });
    expect(output.id).not.toBe(SOURCE_ID);
    expect(output).not.toHaveProperty('root_id');
    expect(output.warnings).toEqual([
      'Copied schema-drift field unchanged: legacy-field',
    ]);

    const fork = await parseNote(join(vaultDir, output.path));
    expect(fork.frontmatter).toMatchObject({
      type: 'idea',
      id: output.id,
      name: 'Forked Draft',
      status: 'raw',
      priority: 'high',
      'forked-from': SOURCE_ID,
      'legacy-field': 'keep me',
    });
    expect(fork.frontmatter).not.toHaveProperty('aliases');
    expect(fork.frontmatter).not.toHaveProperty('prev');
    expect(fork.frontmatter).not.toHaveProperty('next');
    expect(fork.body).toBe('## Draft\n\nWords worth keeping.\n');
  });

  it('resolves exact relative and absolute paths, frontmatter names, and aliases', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    schema.types.idea.fields.aliases = { prompt: 'list', alias: true };
    schema.types.idea.field_order.push('aliases');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));
    const sourcePath = join(vaultDir, 'Ideas/Path Source.md');
    await writeFile(sourcePath, `---
type: idea
id: ${SOURCE_ID}
name: Frontmatter Source
status: raw
aliases: [Alternate Source]
---
Body
`);

    const targets = [
      'Ideas/Path Source',
      sourcePath,
      'Frontmatter Source',
      'Alternate Source',
    ];
    for (let index = 0; index < targets.length; index++) {
      const result = await runCLI([
        'new', '--fork', targets[index]!, '--name', `Resolved ${index}`, '--output', 'json',
      ], vaultDir);
      expect(result.exitCode, `${targets[index]}: ${result.stderr || result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout).forked_from).toBe(SOURCE_ID);
    }
  });

  it('never fuzzy-substitutes and reports ambiguous exact basenames', async () => {
    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
    await writeFile(join(vaultDir, 'Ideas/Duplicate.md'), `---\ntype: idea\nstatus: raw\n---\n`);
    await writeFile(join(vaultDir, 'Ideas/Nested/Duplicate.md'), `---\ntype: idea\nstatus: raw\n---\n`);

    const ambiguous = await runCLI([
      'new', '--fork', 'Duplicate', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.stdout).error).toContain('Ambiguous fork target');
    expect(JSON.parse(ambiguous.stdout).error).toContain('Ideas/Duplicate.md');

    const fuzzy = await runCLI([
      'new', '--fork', 'Sample Ide', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(fuzzy.exitCode).toBe(1);
    expect(JSON.parse(fuzzy.stdout).error).toContain('No exact note found');
  });

  it('backfills a missing source ID once across concurrent forks', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Sample Idea.md');
    const [first, second] = await Promise.all([
      runCLI(['new', '--fork', 'Sample Idea', '--name', 'Concurrent A', '--output', 'json'], vaultDir),
      runCLI(['new', '--fork', 'Sample Idea', '--name', 'Concurrent B', '--output', 'json'], vaultDir),
    ]);
    expect(first.exitCode, first.stderr || first.stdout).toBe(0);
    expect(second.exitCode, second.stderr || second.stdout).toBe(0);

    const source = await parseNote(sourcePath);
    const firstOutput = JSON.parse(first.stdout);
    const secondOutput = JSON.parse(second.stdout);
    expect(source.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstOutput.forked_from).toBe(source.frontmatter.id);
    expect(secondOutput.forked_from).toBe(source.frontmatter.id);

    const registry = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf-8');
    const sourceRows = registry
      .trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.path === 'Ideas/Sample Idea.md');
    expect(sourceRows).toHaveLength(1);
  });

  it('rejects a malformed source ID without changing the source', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Bad ID.md');
    const original = `---\ntype: idea\nid: not-a-uuid\nstatus: raw\n---\nBody\n`;
    await writeFile(sourcePath, original);
    const result = await runCLI([
      'new', '--fork', 'Bad ID', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('invalid id');
    expect(await readFile(sourcePath, 'utf-8')).toBe(original);
  });

  it('uses exclusive child creation for repeated and concurrent names', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Collision Source.md');
    await writeFile(sourcePath, `---\ntype: idea\nid: ${SOURCE_ID}\nstatus: raw\n---\n`);
    const results = await Promise.all([
      runCLI(['new', '--fork', 'Collision Source', '--name', 'Same Child', '--output', 'json'], vaultDir),
      runCLI(['new', '--fork', 'Collision Source', '--name', 'Same Child', '--output', 'json'], vaultDir),
    ]);
    expect(results.map(result => result.exitCode).sort()).toEqual([0, 1]);
    const loser = results.find(result => result.exitCode !== 0)!;
    expect(JSON.parse(loser.stdout).error).toContain('File already exists');

    const registry = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf-8');
    const childRows = registry
      .trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.path === 'Ideas/Same Child.md');
    expect(childRows).toHaveLength(1);
  });

  it('requires explicit naming in non-interactive and JSON output modes', async () => {
    const json = await runCLI([
      'new', '--fork', 'Sample Idea', '--output', 'json',
    ], vaultDir);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout).error).toContain('requires --name <name> or --label <label>');

    const nonInteractive = await runCLI([
      '--non-interactive', 'new', '--fork', 'Sample Idea',
    ], vaultDir);
    expect(nonInteractive.exitCode).toBe(1);
    expect(nonInteractive.stderr).toContain('requires --name <name> or --label <label>');
  });

  it.each([
    ['idea'],
    ['--type', 'idea'],
    ['--template', 'default'],
    ['--no-template'],
    ['--no-instances'],
    ['--json', '{"name":"No"}'],
    ['--owner', '[[Owner]]'],
    ['--standalone'],
  ])('rejects incompatible fork arguments: %s', async (...conflict) => {
    const result = await runCLI([
      'new', ...conflict, '--fork', 'Sample Idea', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('--fork cannot be combined');
  });

  it('rejects fork-only options outside fork mode', async () => {
    for (const option of [['--label', 'x'], ['--name', 'x'], ['--output', 'json']]) {
      const result = await runCLI(['new', 'idea', ...option], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('can only be used with --fork');
    }
  });

  it('blocks single-valued owned forks and permits multiple-owned siblings', async () => {
    const schemaPath = join(vaultDir, '.bwrb/schema.json');
    const sourcePath = join(vaultDir, 'Projects/My Project/research/Owned.md');
    await mkdir(join(vaultDir, 'Projects/My Project/research'), { recursive: true });
    await writeFile(join(vaultDir, 'Projects/My Project/My Project.md'), `---\ntype: project\nstatus: raw\n---\n`);
    await writeFile(sourcePath, `---\ntype: research\nid: ${SOURCE_ID}\nname: Owned\nowner: "[[My Project]]"\n---\n`);

    const blocked = await runCLI([
      'new', '--fork', 'Projects/My Project/research/Owned', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout).error).toContain('single-valued');

    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
    schema.types.project.fields.research.multiple = true;
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));
    const allowed = await runCLI([
      'new', '--fork', 'Projects/My Project/research/Owned', '--label', 'v2', '--output', 'json',
    ], vaultDir);
    expect(allowed.exitCode, allowed.stderr || allowed.stdout).toBe(0);
    expect(JSON.parse(allowed.stdout).path).toBe('Projects/My Project/research/Owned — v2.md');
  });

  it('prints useful text output and honors --open', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Open Source.md');
    await writeFile(sourcePath, `---\ntype: idea\nid: ${SOURCE_ID}\nname: Open Source\nstatus: raw\n---\n`);
    const result = await runCLI([
      'new', '--fork', 'Open Source', '--label', 'review', '--open',
    ], vaultDir, undefined, { env: { BWRB_DEFAULT_APP: 'print' } });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Created fork: Ideas/Open Source — review.md');
    expect(result.stdout).toContain(join(vaultDir, 'Ideas/Open Source — review.md'));
  });

  it('creates lineage that passes the lineage audit checks', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Audit Source.md');
    await writeFile(sourcePath, `---\ntype: idea\nid: ${SOURCE_ID}\nname: Audit Source\nstatus: raw\n---\n`);
    const created = await runCLI([
      'new', '--fork', 'Audit Source', '--label', 'clean', '--output', 'json',
    ], vaultDir);
    expect(created.exitCode, created.stderr || created.stdout).toBe(0);

    const audit = await runCLI([
      'audit', '--path', 'Ideas/Audit Source — clean.md', '--output', 'json',
    ], vaultDir);
    expect(audit.exitCode, audit.stderr || audit.stdout).toBe(0);
    const lineageCodes = (JSON.parse(audit.stdout).files as Array<{ issues: Array<{ code: string }> }>)
      .flatMap(file => file.issues)
      .map(issue => issue.code)
      .filter(code => code.includes('fork') || code.includes('lineage') || code.includes('note-id'));
    expect(lineageCodes).toEqual([]);
  });
});

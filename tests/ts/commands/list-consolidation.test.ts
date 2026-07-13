import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';
import { extractHelpCommands } from '../helpers/help.js';

describe('list as the canonical query/search/open surface', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as {
      types: { idea: { fields: Record<string, unknown> } };
    };
    schema.types.idea.fields.aliases = {
      prompt: 'list',
      list_format: 'yaml-array',
      alias: true,
    };
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));

    const samplePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
    const sample = await readFile(samplePath, 'utf-8');
    await writeFile(
      samplePath,
      sample.replace(
        '---\n',
        '---\nid: 11111111-1111-4111-8111-111111111111\naliases:\n  - Seed Thought\n'
      ) + '\nBody status raw marker.\nShared body marker.\n'
    );

    const anotherPath = join(vaultDir, 'Ideas', 'Another Idea.md');
    const another = await readFile(anotherPath, 'utf-8');
    await writeFile(
      anotherPath,
      another + '\nBody status backlog marker.\nShared body marker.\n'
    );

    const writeRegressionNote = async (
      relativePath: string,
      status: string,
      aliases: string[] = [],
      name?: string
    ): Promise<void> => {
      const path = join(vaultDir, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      const aliasYaml = aliases.length > 0
        ? `aliases:\n${aliases.map(alias => `  - ${alias}`).join('\n')}\n`
        : '';
      const nameYaml = name ? `name: ${name}\n` : '';
      await writeFile(path, `---\ntype: idea\nstatus: ${status}\n${nameYaml}${aliasYaml}---\n`);
    };

    await Promise.all([
      writeRegressionNote('Regression/Path Target.md', 'raw'),
      writeRegressionNote('Regression/Basename Target.md', 'raw'),
      writeRegressionNote('Regression/Alias Owner.md', 'raw', ['Hidden Alias']),
      writeRegressionNote('Other/Path Target Neighbor.md', 'backlog'),
      writeRegressionNote('Other/Basename Target Neighbor.md', 'backlog'),
      writeRegressionNote('Other/Hidden Alias Neighbor.md', 'backlog'),
      writeRegressionNote('Duplicates/One/Duplicate.md', 'raw'),
      writeRegressionNote('Duplicates/Two/Duplicate.md', 'raw'),
      writeRegressionNote('Regression/machine-slug.md', 'raw', [], 'Human Facing Name'),
      writeRegressionNote('Duplicates/One/named-one.md', 'raw', [], 'Shared Frontmatter Name'),
      writeRegressionNote('Duplicates/Two/named-two.md', 'raw', [], 'Shared Frontmatter Name'),
    ]);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('resolves names, paths, and aliases through --name', async () => {
    const byName = await runCLI(['list', '--name', 'sample idea', '--picker', 'none'], vaultDir);
    const byPath = await runCLI(['list', '--name', 'Ideas/Sample Idea.md', '--output', 'paths', '--picker', 'none'], vaultDir);
    const byAlias = await runCLI(['list', '--name', 'Seed Thought', '--picker', 'none'], vaultDir);

    expect(byName.exitCode).toBe(0);
    expect(byName.stdout.trim()).toBe('Sample Idea');
    expect(byPath.exitCode).toBe(0);
    expect(byPath.stdout.trim()).toBe('Ideas/Sample Idea.md');
    expect(byAlias.exitCode).toBe(0);
    expect(byAlias.stdout.trim()).toBe('Sample Idea');
  });

  it('resolves a unique frontmatter name without invoking a picker', async () => {
    const paths = await runCLI([
      'list', '--name', 'human facing name', '--output', 'paths',
    ], vaultDir);
    const opened = await runCLI([
      'list', '--name', 'Human Facing Name', '--open', '--app', 'print',
    ], vaultDir);

    expect(paths.exitCode).toBe(0);
    expect(paths.stdout.trim()).toBe('Regression/machine-slug.md');
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout.trim()).toBe(join(vaultDir, 'Regression/machine-slug.md'));
  });

  it('preserves ambiguity for duplicate frontmatter names', async () => {
    const result = await runCLI([
      'list', '--name', 'Shared Frontmatter Name', '--open', '--app', 'print',
      '--picker', 'none',
    ], vaultDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Ambiguous query: 2 matches found');
    expect(result.stderr).toContain('Duplicates/One/named-one.md');
    expect(result.stderr).toContain('Duplicates/Two/named-two.md');
  });

  it('composes type and where targeting with name and fuzzy modes', async () => {
    const byName = await runCLI([
      'list', '--name', 'Sample', '--type', 'idea', '--where', "status == 'raw'", '--picker', 'none',
    ], vaultDir);
    const fuzzy = await runCLI([
      'list', '--fuzzy', 'Sample', '--type', 'idea', '--where', "status == 'raw'", '--output', 'json',
    ], vaultDir);

    expect(byName.exitCode).toBe(0);
    expect(byName.stdout.trim()).toBe('Sample Idea');
    expect(fuzzy.exitCode).toBe(0);
    const json = JSON.parse(fuzzy.stdout) as { data: Array<{ path: string }> };
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.every(result => result.path.startsWith('Ideas/'))).toBe(true);
  });

  it('does not replace filtered-out exact paths, basenames, or aliases with fuzzy notes', async () => {
    const cases = [
      {
        query: 'Regression/Path Target.md',
        scope: ['--where', "status == 'backlog'"],
        replacement: 'Path Target Neighbor',
      },
      {
        query: 'Basename Target',
        scope: ['--path', 'Other/**'],
        replacement: 'Basename Target Neighbor',
      },
      {
        query: 'Hidden Alias',
        scope: ['--where', "status == 'backlog'"],
        replacement: 'Hidden Alias Neighbor',
      },
    ];

    for (const { query, scope, replacement } of cases) {
      const output = await runCLI([
        'list', '--name', query, ...scope, '--output', 'paths', '--picker', 'none',
      ], vaultDir);
      const opened = await runCLI([
        'list', '--name', query, ...scope, '--open', '--app', 'print', '--picker', 'none',
      ], vaultDir);

      for (const result of [output, opened]) {
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain(replacement);
        expect(result.stderr).toContain('exact target does not match the requested filters');
      }
    }
  });

  it('applies name-mode limits to ambiguous displayed results', async () => {
    const paths = await runCLI([
      'list', '--name', 'Duplicate', '--limit', '1', '--output', 'paths', '--picker', 'none',
    ], vaultDir);
    const jsonResult = await runCLI([
      'list', '--name', 'Duplicate', '--limit', '1', '--output', 'json', '--picker', 'none',
    ], vaultDir);

    expect(paths.exitCode).toBe(0);
    expect(paths.stdout.trim().split('\n')).toHaveLength(1);
    expect(paths.stdout).toMatch(/Duplicates\/(One|Two)\/Duplicate\.md/);

    expect(jsonResult.exitCode).toBe(0);
    const json = JSON.parse(jsonResult.stdout) as { data: Array<{ path: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.path).toMatch(/^Duplicates\/(One|Two)\/Duplicate\.md$/);
  });

  it('never turns a name-mode display limit into an arbitrary open selection', async () => {
    for (const outputArgs of [[], ['--output', 'paths']]) {
      const result = await runCLI([
        'list', '--name', 'Duplicate', '--limit', '1', ...outputArgs,
        '--open', '--app', 'print', '--picker', 'none',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Ambiguous query: 2 matches found');
      expect(result.stderr).toContain('Duplicates/One/Duplicate.md');
      expect(result.stderr).toContain('Duplicates/Two/Duplicate.md');
    }
  });

  it('returns ranked fuzzy matches and scores through --fuzzy', async () => {
    const result = await runCLI([
      'list', '--fuzzy', 'Sample Ide', '--threshold', '0.5', '--limit', '2', '--output', 'json',
    ], vaultDir);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      success: boolean;
      data: Array<{ name: string; score: number; path: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.data[0]?.name).toBe('Sample Idea');
    expect(json.data[0]?.score).toBeGreaterThan(0.5);
    expect(json.data[0]?.path).toMatch(/^Ideas\//);
  });

  it('shows detailed regex body matches with context controls', async () => {
    const result = await runCLI([
      'list', '--body', 'status|raw', '--matches', '--regex', '--no-context', '--path', 'Ideas/**',
    ], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Body status raw marker.');
    expect(result.stdout).not.toContain('Objectives/');
  });

  it('honors paths and link output for detailed body matches', async () => {
    const paths = await runCLI([
      'list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'paths',
    ], vaultDir);
    const links = await runCLI([
      'list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'link',
    ], vaultDir);

    expect(paths.exitCode).toBe(0);
    const pathLines = paths.stdout.trim().split('\n');
    expect(pathLines).toEqual(['Ideas/Another Idea.md', 'Ideas/Sample Idea.md']);
    expect(new Set(pathLines).size).toBe(pathLines.length);
    expect(paths.stdout).not.toMatch(/:\d+:/);

    expect(links.exitCode).toBe(0);
    const linkLines = links.stdout.trim().split('\n');
    expect(linkLines).toEqual(['[[Another Idea]]', '[[Sample Idea]]']);
    expect(new Set(linkLines).size).toBe(linkLines.length);
    expect(links.stdout).not.toMatch(/:\d+:/);
  });

  it('keeps text, content, and JSON detailed-match output coherent', async () => {
    const text = await runCLI([
      'list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--no-context',
    ], vaultDir);
    const content = await runCLI([
      'list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'content',
    ], vaultDir);
    const jsonResult = await runCLI([
      'list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'json',
    ], vaultDir);

    expect(text.stdout).toMatch(/Ideas\/Sample Idea\.md:\d+:Body status raw marker\./);
    expect(content.stdout).toContain('type: idea');
    expect(content.stdout).toContain('status: raw');
    expect(content.stdout).not.toMatch(/Ideas\/Sample Idea\.md:\d+:/);
    const json = JSON.parse(jsonResult.stdout) as {
      data: Array<{ path: string; matches: Array<{ line: number; text: string }> }>;
    };
    expect(json.data.every(result => result.matches.length > 0)).toBe(true);
    expect(json.data.some(result => result.path === 'Ideas/Sample Idea.md')).toBe(true);
  });

  it('excludes frontmatter-only terms in list rows and detailed match reports', async () => {
    const filtered = await runCLI([
      'list', '--body', '11111111-1111-4111-8111-111111111111', '--output', 'json',
    ], vaultDir);
    const canonical = await runCLI([
      'list', '--body', '11111111-1111-4111-8111-111111111111', '--matches', '--output', 'json',
    ], vaultDir);
    expect(filtered.exitCode).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual([]);
    expect(canonical.exitCode).toBe(0);
    expect(JSON.parse(canonical.stdout)).toMatchObject({ success: true, data: [], totalMatches: 0 });
  });

  it('prints full Markdown content through list output', async () => {
    const result = await runCLI([
      'list', '--name', 'Sample Idea', '--output', 'content', '--picker', 'none',
    ], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('---');
    expect(result.stdout).toContain('type: idea');
  });

  it('opens a directly resolved name through list', async () => {
    const result = await runCLI([
      'list', '--name', 'Sample Idea', '--open', '--app', 'print', '--picker', 'none',
    ], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ideas/Sample Idea.md');
  });

  it('keeps stable-id targeting composable with list open', async () => {
    const opened = await runCLI([
      'list', '--id', '11111111-1111-4111-8111-111111111111', '--open', '--app', 'print', '--picker', 'none',
    ], vaultDir);
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout).toContain('Sample Idea.md');
  });

  it('removes search and open from root help and rejects them', async () => {
    const root = await runCLI(['--help']);
    const search = await runCLI(['search', 'Sample Idea'], vaultDir);
    const open = await runCLI(['open', 'Sample Idea'], vaultDir);

    expect(extractHelpCommands(root.stdout)).not.toContain('search');
    expect(extractHelpCommands(root.stdout)).not.toContain('open');
    expect(search.exitCode).not.toBe(0);
    expect(open.exitCode).not.toBe(0);
  });

  it('rejects mode-specific flags instead of silently ignoring them', async () => {
    const contextWithoutMatches = await runCLI([
      'list', '--body', 'sample', '--context', '0',
    ], vaultDir);
    const treeWithFuzzy = await runCLI([
      'list', '--fuzzy', 'sample', '--output', 'tree',
    ], vaultDir);
    const invalidNameLimit = await runCLI([
      'list', '--name', 'sample', '--limit', '0', '--output', 'paths',
    ], vaultDir);

    expect(contextWithoutMatches.exitCode).toBe(1);
    expect(contextWithoutMatches.stderr).toContain('require --matches');
    expect(treeWithFuzzy.exitCode).toBe(1);
    expect(treeWithFuzzy.stderr).toContain('--output tree is not available');
    expect(invalidNameLimit.exitCode).toBe(1);
    expect(invalidNameLimit.stderr).toContain('must be a positive integer');
  });
});

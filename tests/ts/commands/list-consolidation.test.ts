import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
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
      )
    );
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
    expect(result.stdout.toLowerCase()).toContain('status');
    expect(result.stdout).not.toContain('Objectives/');
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

  it('keeps search and open callable with their established stdout contracts', async () => {
    const canonicalSearch = await runCLI([
      'list', '--name', 'Sample Idea', '--output', 'link', '--picker', 'none',
    ], vaultDir);
    const compatibilitySearch = await runCLI([
      'search', 'Sample Idea', '--output', 'link', '--picker', 'none',
    ], vaultDir);
    const canonicalOpen = await runCLI([
      'list', '--name', 'Sample Idea', '--open', '--app', 'print', '--picker', 'none',
    ], vaultDir);
    const compatibilityOpen = await runCLI([
      'open', 'Sample Idea', '--app', 'print', '--picker', 'none',
    ], vaultDir);

    expect(compatibilitySearch.exitCode).toBe(canonicalSearch.exitCode);
    expect(compatibilitySearch.stdout).toBe(canonicalSearch.stdout);
    expect(compatibilityOpen.exitCode).toBe(canonicalOpen.exitCode);
    expect(compatibilityOpen.stdout).toBe(canonicalOpen.stdout);
  });

  it('hides compatibility commands from root help but labels their own help', async () => {
    const root = await runCLI(['--help']);
    const searchHelp = await runCLI(['search', '--help']);
    const openHelp = await runCLI(['open', '--help']);

    expect(extractHelpCommands(root.stdout)).not.toContain('search');
    expect(extractHelpCommands(root.stdout)).not.toContain('open');
    expect(searchHelp.stdout).toContain('compatibility command; use list');
    expect(openHelp.stdout).toContain('compatibility command; use list --open');
  });

  it('rejects mode-specific flags instead of silently ignoring them', async () => {
    const contextWithoutMatches = await runCLI([
      'list', '--body', 'sample', '--context', '0',
    ], vaultDir);
    const treeWithFuzzy = await runCLI([
      'list', '--fuzzy', 'sample', '--output', 'tree',
    ], vaultDir);

    expect(contextWithoutMatches.exitCode).toBe(1);
    expect(contextWithoutMatches.stderr).toContain('require --matches');
    expect(treeWithFuzzy.exitCode).toBe(1);
    expect(treeWithFuzzy.stderr).toContain('--output tree is not available');
  });
});

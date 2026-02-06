import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';
import { normalizeCliHelpForSnapshot, runHelp } from '../fixtures/help.js';

function extractCommandNames(helpOutput: string): string[] {
  const lines = helpOutput.split('\n');
  const commandsHeaderIndex = lines.findIndex((line) => line.trim() === 'Commands:');
  if (commandsHeaderIndex < 0) return [];

  const commandNames: string[] = [];
  let commandIndent: number | null = null;
  for (let i = commandsHeaderIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      break;
    }

    const match = line.match(/^(\s+)([a-z][a-z-]*)\b/i);
    if (!match) {
      continue;
    }

    const indent = match[1]!.length;
    if (commandIndent === null) {
      commandIndent = indent;
    }

    if (indent === commandIndent) {
      commandNames.push(match[2]!);
    }
  }

  return commandNames;
}

describe('help output contract snapshots', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('captures top-level help output contract', async () => {
    const result = await runHelp([]);
    const normalized = normalizeCliHelpForSnapshot(result.stdout);
    const commandNames = extractCommandNames(normalized);

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Usage: bwrb [options] [command]');
    expect(normalized).toContain('Commands:');
    expect(commandNames).toEqual([
      'new',
      'edit',
      'delete',
      'list',
      'open',
      'search',
      'schema',
      'audit',
      'bulk',
      'template',
      'dashboard',
      'init',
      'config',
      'completion',
      'help',
    ]);
  });

  it('captures new command help output contract', async () => {
    const result = await runHelp(['new'], vaultDir);
    const normalized = normalizeCliHelpForSnapshot(result.stdout, { vaultDir });

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Create a new note');
    expect(normalized).toContain('--template <name>');
    expect(normalized).toContain('Templates:');
    expect(normalized).toContain('Ownership:');
    expect(normalized).toContain('Instance scaffolding:');
    expect(normalized).toContain('Non-interactive (JSON) mode:');
    expect(normalized).toContain('Body sections (JSON mode):');
    expect(normalized).toContain("Templates are managed with 'bwrb template'");
    expect(normalized).toMatch(/--owner <wikilink>[\s\S]*\[\[My Novel\]\]/);
    expect(normalized).toMatch(/bwrb new task --template bug-report/);
    expect(normalized).toMatch(/bwrb new task --json '\{"name": "Bug"\}' --template bug-report/);
  });

  it('captures schema command help output contract', async () => {
    const result = await runHelp(['schema'], vaultDir);
    const normalized = normalizeCliHelpForSnapshot(result.stdout, { vaultDir });
    const commandNames = extractCommandNames(normalized);

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Schema introspection commands');
    expect(normalized).toContain('Commands:');
    expect(commandNames).toEqual([
      'validate',
      'new',
      'edit',
      'delete',
      'list',
      'diff',
      'migrate',
      'history',
      'help',
    ]);
    expect(normalized).toContain('bwrb schema list objective/task');
    expect(normalized).toContain('bwrb schema list task --output json');
  });

  it('keeps normalized help deterministic with and without explicit terminal width hints', async () => {
    const narrow = await runCLI(['new', '--help'], vaultDir, undefined, {
      trimOutput: false,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', COLUMNS: '80', LINES: '40' },
    });
    const defaultWidth = await runCLI(['new', '--help'], vaultDir, undefined, {
      trimOutput: false,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
    });

    expect(narrow.exitCode).toBe(0);
    expect(defaultWidth.exitCode).toBe(0);

    const narrowNormalized = normalizeCliHelpForSnapshot(narrow.stdout, { vaultDir });
    const defaultNormalized = normalizeCliHelpForSnapshot(defaultWidth.stdout, { vaultDir });

    expect(narrowNormalized).toContain('Usage: bwrb new [options] [type]');
    expect(defaultNormalized).toContain('Usage: bwrb new [options] [type]');
  });
});

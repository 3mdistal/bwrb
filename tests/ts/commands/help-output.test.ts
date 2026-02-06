import { describe, expect, it } from 'vitest';
import { runCLI } from '../fixtures/setup.js';
import { extractHelpCommands } from '../helpers/help.js';

describe('bwrb --help command list', () => {
  it('matches expected top-level command order', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const commands = extractHelpCommands(result.stdout);
    const expectedCore = [
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
    ];

    if (commands.includes('help')) {
      expect(commands).toEqual([...expectedCore, 'help']);
      expect(commands[commands.length - 1]).toBe('help');
      return;
    }

    expect(commands).toEqual(expectedCore);
  });
});

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

import { CLI_PATH, runCLI } from '../fixtures/setup';
import { extractHelpCommands } from '../helpers/help';

const VAULT_DIR = path.join(__dirname, '../../fixtures/vault');

async function runCliOutput(
  args: string[],
  options: { cwd?: string; vault?: string } = {}
): Promise<string> {
  const cwd = options.cwd ?? VAULT_DIR;
  const env = {
    ...process.env,
    NO_COLOR: '1',
    ...(options.vault ? { BWRB_VAULT: options.vault } : {}),
  };

  const result = await runCLI(args, undefined, undefined, { cwd, env });
  return result.stdout;
}

function runBuiltCliOutput(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: VAULT_DIR,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', BWRB_VAULT: VAULT_DIR },
  }).trim();
}

function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.trim());
}

function extractHelpOptionFlags(helpOutput: string): string[] {
  const optionLines = helpOutput
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => /^  -/.test(line));

  return optionLines.flatMap((line) => {
    const signature = line.trim().split(/\s{2,}/, 1)[0] ?? '';
    return signature.match(/-{1,2}[a-z][a-z0-9-]*/gi) ?? [];
  });
}

describe('bwrb completion command', () => {
  describe('completion bash', () => {
    it('should output a valid bash completion script', async () => {
      const output = await runCliOutput(['completion', 'bash'], {
        vault: VAULT_DIR,
      });

      // Should contain bash-specific completion setup
      expect(output).toContain('_bwrb_completions()');
      expect(output).toContain('complete -F _bwrb_completions bwrb');
      expect(output).toContain('COMPREPLY');
      expect(output).toContain('--completions');
    });

    it('should be valid bash syntax', async () => {
      const script = await runCliOutput(['completion', 'bash'], {
        vault: VAULT_DIR,
      });
      // Use bash -n to check syntax without executing
      expect(() => {
        execFileSync('bash', ['-n'], { input: script, encoding: 'utf-8' });
      }).not.toThrow();
    });
  });

  describe('completion zsh', () => {
    it('should output a valid zsh completion script', async () => {
      const output = await runCliOutput(['completion', 'zsh'], {
        vault: VAULT_DIR,
      });

      // Should contain zsh-specific completion setup
      expect(output).toContain('#compdef bwrb');
      expect(output).toContain('_bwrb()');
      expect(output).toContain('compdef _bwrb bwrb');
      expect(output).toContain('--completions');
    });
  });

  describe('completion fish', () => {
    it('should output a valid fish completion script', async () => {
      const output = await runCliOutput(['completion', 'fish'], {
        vault: VAULT_DIR,
      });

      // Should contain fish-specific completion setup
      expect(output).toContain('complete -c bwrb');
      expect(output).toContain('--completions');
    });
  });

  describe('--completions flag', () => {
    it('matches the visible built root command surface exactly', () => {
      const helpCommands = extractHelpCommands(runBuiltCliOutput(['--help']))
        .filter((command) => command !== 'help');
      const completions = lines(runBuiltCliOutput(['--completions', 'bwrb', '']));

      expect(completions).toEqual(helpCommands);
      expect(completions).not.toContain('open');
      expect(completions).not.toContain('search');
    });

    it.each(['schema', 'template'])('matches the visible built %s subcommand surface exactly', (command) => {
      const helpCommands = extractHelpCommands(runBuiltCliOutput([command, '--help']))
        .filter((candidate) => candidate !== 'help');
      const completions = lines(runBuiltCliOutput(['--completions', 'bwrb', command, '']));

      expect(completions).toEqual(helpCommands);
    });

    it('includes every built recent option except the generic help short flag', () => {
      const helpOptions = extractHelpOptionFlags(runBuiltCliOutput(['recent', '--help']))
        .filter((option) => option !== '-h');
      const completions = lines(runBuiltCliOutput(['--completions', 'bwrb', 'recent', '-']));
      const expectedOptions = [...helpOptions, '--vault', '-v', '--non-interactive'];

      expect(completions).toHaveLength(new Set(completions).size);
      expect(new Set(completions)).toEqual(new Set(expectedOptions));
    });

    it('should return type completions after --type', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', 'list', '--type', ''], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      // Should include types from the test vault schema
      expect(completions).toContain('task');
      expect(completions).toContain('idea');
    });

    it('should respect the short -v vault option', async () => {
      const output = await runCliOutput(
        ['--completions', 'bwrb', '-v', VAULT_DIR, 'list', '--type', ''],
        { cwd: '/tmp' }
      );
      const completions = output.split('\n').filter((l) => l.trim());

      expect(completions).toContain('task');
      expect(completions).toContain('idea');
    });

    it('should complete commands after the short -v vault option', async () => {
      const output = await runCliOutput(
        ['--completions', 'bwrb', '-v', VAULT_DIR, 'li'],
        { cwd: '/tmp' }
      );
      const completions = output.split('\n').filter((l) => l.trim());

      expect(completions).toContain('list');
      expect(completions).not.toContain('new');
    });

    it('should return top-level option completions for bwrb dash', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', '-']);
      const completions = output.split('\n').filter((l) => l.trim());

      expect(completions).toContain('--vault');
      expect(completions).toContain('-v');
    });

    it('should filter type completions by prefix', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', 'list', '--type', 'ta'], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      expect(completions).toContain('task');
      expect(completions).not.toContain('idea');
    });

    it('should return path completions after --path', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', 'list', '--path', ''], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      // Should include directories from the test vault
      expect(completions.some((c) => c.includes('Ideas'))).toBe(true);
      expect(completions.some((c) => c.includes('Objectives'))).toBe(true);
    });

    it('should return command completions for bare bwrb', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', ''], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      // Should include available commands
      expect(completions).toContain('list');
      expect(completions).toContain('new');
      expect(completions).toContain('edit');
      expect(completions).toContain('completion');
      expect(completions).toContain('lineage');
      expect(completions).not.toContain('search');
      expect(completions).not.toContain('open');
    });

    it('completes lineage adopt and its guarded mutation options', async () => {
      const subcommands = (await runCliOutput([
        '--completions', 'bwrb', 'lineage', '',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(subcommands).toContain('adopt');

      const options = (await runCliOutput([
        '--completions', 'bwrb', 'lineage', 'adopt', '--',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(options).toEqual(expect.arrayContaining([
        '--from', '--dry-run', '--execute', '--output', '--vault', '--help',
      ]));
      expect(options).not.toContain('--force');

      const backfillOptions = (await runCliOutput([
        '--completions', 'bwrb', 'identity', 'backfill', '--',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(backfillOptions).toEqual(expect.arrayContaining([
        '--type', '--path', '--dry-run', '--execute', '--output', '--vault', '--help',
      ]));
    });

    it('completes identity migrate and its guarded migration options', async () => {
      const subcommands = (await runCliOutput([
        '--completions', 'bwrb', 'identity', '',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(subcommands).toEqual(['migrate', 'backfill']);

      const options = (await runCliOutput([
        '--completions', 'bwrb', 'identity', 'migrate', '--',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(options).toEqual(expect.arrayContaining([
        '--to', '--dry-run', '--execute', '--output', '--vault', '--help',
      ]));
      expect(options).not.toContain('--force');
    });

    it('completes priority subcommands and approval-only mutation options', async () => {
      const subcommands = (await runCliOutput([
        '--completions', 'bwrb', 'priority', '',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(subcommands).toEqual(['suggest', 'validate', 'approve']);

      const options = (await runCliOutput([
        '--completions', 'bwrb', 'priority', 'approve', '--',
      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
      expect(options).toEqual(expect.arrayContaining([
        '--json-file', '--approval-id', '--execute', '--output', '--vault', '--help',
      ]));
    });

    it('should return option completions when current word starts with -', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', 'list', '--'], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      // Should include targeting options for list command
      expect(completions).toContain('--type');
      expect(completions).toContain('--path');
      expect(completions).toContain('--where');
    });

    it('should fail silently outside a vault', async () => {
      // Run from a non-vault directory
      const output = await runCliOutput(
        ['--completions', 'bwrb', 'list', '--type', ''],
        { cwd: '/tmp' }
      );

      // Should return empty or just not crash
      expect(output).toBeDefined();
    });
  });
});

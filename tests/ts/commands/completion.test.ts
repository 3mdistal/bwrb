import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

import { runCLI } from '../fixtures/setup';

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
    it('should return type completions after --type', async () => {
      const output = await runCliOutput(['--completions', 'bwrb', 'list', '--type', ''], {
        vault: VAULT_DIR,
      });
      const completions = output.split('\n').filter((l) => l.trim());

      // Should include types from the test vault schema
      expect(completions).toContain('task');
      expect(completions).toContain('idea');
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

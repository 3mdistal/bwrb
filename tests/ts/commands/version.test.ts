import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { runCLI, PROJECT_ROOT } from '../fixtures/setup.js';

describe('version flag', () => {
  it('should report the packaged version', async () => {
    const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8');
    const packageJson = JSON.parse(raw) as { version?: string };

    const result = await runCLI(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(packageJson.version);
  });

  it('should report the packaged version with -V', async () => {
    const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8');
    const packageJson = JSON.parse(raw) as { version?: string };

    const result = await runCLI(['-V']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(packageJson.version);
  });
});

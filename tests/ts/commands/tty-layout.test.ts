import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

function hasAnsi(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[[0-9;]*[A-Za-z]/.test(value);
}

describe('tty layout non-tty behavior', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  it('does not truncate or colorize dashboard/template/list outputs', async () => {
    const vaultDir = await createTestVault();
    cleanup.push(() => cleanupTestVault(vaultDir));

    const longStatus = 'status-value-that-is-intentionally-very-long-for-non-tty-preservation-check';
    const longDescription = 'This is an intentionally long template description to verify non-tty mode remains data-complete without truncation';
    const longPath = 'Projects/Very/Long/Path/That/Should/Not/Be/Truncated/In/NonTTY/Mode/**';

    await writeFile(
      join(vaultDir, 'Ideas', 'TTY NonTTY Preservation.md'),
      `---
type: idea
status: ${longStatus}
priority: medium
---

Body
`
    );

    await writeFile(
      join(vaultDir, '.bwrb', 'dashboards.json'),
      JSON.stringify(
        {
          dashboards: {
            'long-dashboard': {
              type: 'idea',
              path: longPath,
              body: 'non tty body search term',
            },
          },
        },
        null,
        2
      )
    );

    await writeFile(
      join(vaultDir, '.bwrb', 'templates', 'idea', 'tty-long.md'),
      `---
type: template
template-for: idea
description: ${longDescription}
---

# {title}
`
    );

    const dashboard = await runCLI(['dashboard', 'list'], vaultDir);
    expect(dashboard.exitCode).toBe(0);
    expect(dashboard.stdout).toContain(longPath);
    expect(dashboard.stdout).not.toContain('...');
    expect(hasAnsi(dashboard.stdout)).toBe(false);

    const templates = await runCLI(['template', 'list'], vaultDir);
    expect(templates.exitCode).toBe(0);
    expect(templates.stdout).toContain(longDescription);
    expect(templates.stdout).not.toContain('...');
    expect(hasAnsi(templates.stdout)).toBe(false);

    const listing = await runCLI(['list', '--type', 'idea', '--fields', 'status,priority'], vaultDir);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain(longStatus);
    expect(listing.stdout).not.toContain('...');
    expect(hasAnsi(listing.stdout)).toBe(false);
  });

  it('does not truncate schema list fields output in non-tty mode', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-schema-layout-'));
    cleanup.push(() => rm(vaultDir, { recursive: true, force: true }));

    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(
        {
          version: 2,
          types: {
            meta: {},
            objective: {
              output_dir: 'Objectives',
              fields: {
                state: {
                  prompt: 'select',
                  options: ['raw', 'active', 'blocked', 'done', 'deferred', 'someday-maybe'],
                  required: true,
                },
              },
            },
          },
        },
        null,
        2
      )
    );

    const result = await runCLI(['schema', 'list', 'fields'], vaultDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('someday-maybe');
    expect(result.stdout).not.toContain('...');
    expect(hasAnsi(result.stdout)).toBe(false);
  });
});

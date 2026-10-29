import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

describe('edit --patches', () => {
  let vaultDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    manifestPath = join(vaultDir, 'plan.json');
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  const writeManifest = (notes: unknown[]) => writeFile(manifestPath, JSON.stringify({ notes }));
  const readNote = (path: string) => readFile(join(vaultDir, path), 'utf-8');

  it('previews as JSON by default and executes only with --execute', async () => {
    await writeManifest([
      { path: 'Ideas/Sample Idea.md', patch: { status: 'backlog' } },
      { path: 'Ideas/Another Idea.md', patch: { priority: 'medium' } },
    ]);
    const before = await readNote('Ideas/Sample Idea.md');

    const preview = await runCLI(['edit', '--patches', manifestPath], vaultDir);
    expect(preview.exitCode).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson).toMatchObject({
      success: true,
      data: { mode: 'preview', counts: { notes: 2, planned: 2 } },
    });
    expect(previewJson.data.notes[0]).toMatchObject({
      path: 'Ideas/Sample Idea.md',
      status: 'planned',
      updated: ['status'],
      revision: null,
    });
    expect(await readNote('Ideas/Sample Idea.md')).toBe(before);

    const executed = await runCLI(['edit', '--patches', manifestPath, '--execute', '--output', 'text'], vaultDir);
    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain('applied       Ideas/Sample Idea.md (status)');
    expect(executed.stdout).toContain('Execute: 2 notes; 2 applied.');
    expect(await readNote('Ideas/Sample Idea.md')).toContain('status: backlog');
    expect(await readNote('Ideas/Another Idea.md')).toContain('priority: medium');
  });

  it('reports a blocked batch with its notes and writes nothing', async () => {
    await writeManifest([
      { path: 'Ideas/Sample Idea.md', patch: { status: 'backlog' } },
      { path: 'Ideas/Missing.md', patch: { status: 'backlog' } },
    ]);
    const before = await readNote('Ideas/Sample Idea.md');

    const result = await runCLI(['edit', '--patches', manifestPath, '--execute'], vaultDir);

    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      success: false,
      error: '1 of 2 notes is blocked, so nothing was written.',
      data: { mode: 'execute', counts: { blocked: 1, 'not-attempted': 1 } },
    });
    expect(json.data.notes[1].errors[0].code).toBe('TARGET_NOT_FOUND');
    expect(await readNote('Ideas/Sample Idea.md')).toBe(before);
  });

  it('rejects a query, targeting or --json alongside --patches', async () => {
    await writeManifest([{ path: 'Ideas/Sample Idea.md', patch: { status: 'backlog' } }]);

    const result = await runCLI(
      ['edit', 'Sample Idea', '--patches', manifestPath, '--type', 'idea', '--json', '{}'],
      vaultDir
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      success: false,
      error: '--patches names its notes in the manifest and cannot be combined with a note query, --type, --json.',
    });
  });

  it('requires --patches for --execute', async () => {
    const result = await runCLI(['edit', '--execute'], vaultDir);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe('--execute requires --patches <file>.');
  });

  it('separates an unreadable manifest from a malformed one', async () => {
    const missing = await runCLI(['edit', '--patches', join(vaultDir, 'nope.json')], vaultDir);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error).toContain('Could not read patch manifest');

    await writeFile(manifestPath, '{"notes": {}}');
    const malformed = await runCLI(['edit', '--patches', manifestPath], vaultDir);
    expect(malformed.exitCode).toBe(1);
    expect(JSON.parse(malformed.stdout).error).toBe('A patch manifest must be an object with a "notes" array.');
  });
});

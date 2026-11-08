import { existsSync } from 'fs';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

const ON_WINDOWS = process.platform === 'win32';
const BROKEN_NOTE = 'Objectives/Tasks/Broken.md';
const BROKEN_NOTE_BACKSLASHES = 'Objectives\\Tasks\\Broken.md';

describe('vault path spelling', () => {
  let vaultDir: string;

  /** The paths audit reports for these arguments. It exits 1 when it finds errors. */
  const auditedPaths = async (...args: string[]) => {
    const result = await runCLI(['audit', ...args, '--output', 'json'], vaultDir);
    const report = JSON.parse(result.stdout) as { files: { path: string }[] };
    return report.files.map(file => file.path);
  };

  beforeEach(async () => {
    vaultDir = await createTestVault();
    await writeFile(
      join(vaultDir, 'Objectives', 'Tasks', 'Broken.md'),
      '---\ntype: task\nid: 11111111-2222-4333-8444-555555555555\nname: Broken\nstatus: nope\n---\n'
    );
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('output', () => {
    it('prints a created note with forward slashes, and audit accepts that path', async () => {
      const created = await runCLI(
        ['new', 'task', '--no-template', '--json', JSON.stringify({ name: 'Example' })],
        vaultDir
      );
      const { path } = JSON.parse(created.stdout) as { path: string };

      expect(path).toBe('Objectives/Tasks/Example.md');
      const audit = await runCLI(['audit', path], vaultDir);
      expect(audit.exitCode, audit.stderr).toBe(0);
    });

    it('lists notes with forward slashes in JSON and path output', async () => {
      const json = await runCLI(['list', '--type', 'task', '--output', 'json'], vaultDir);
      const notes = JSON.parse(json.stdout) as { _path: string }[];
      expect(notes.map(note => note._path)).toContain(BROKEN_NOTE);

      const paths = await runCLI(['list', '--type', 'task', '--output', 'paths'], vaultDir);
      expect(paths.stdout.split('\n')).toContain(BROKEN_NOTE);
    });

    it('nests folders in tree output', async () => {
      const result = await runCLI(['list', '--type', 'task', '--output', 'tree'], vaultDir);

      expect(result.stdout).toMatch(/Objectives\/\n.*Tasks\//);
      expect(result.stdout).not.toContain('Objectives\\Tasks');
    });

    it('prints recent notes with forward slashes', async () => {
      const result = await runCLI(['recent', '--output', 'paths'], vaultDir);

      expect(result.stdout.split('\n')).toContain(BROKEN_NOTE);
    });

    it('prints template paths with forward slashes', async () => {
      const result = await runCLI(['template', 'list', '--output', 'json'], vaultDir);

      expect(result.stdout).toContain('.bwrb/templates/task/bug-report.md');
    });

    it('records backed-up files with forward slashes', async () => {
      const result = await runCLI(
        ['bulk', '--type', 'task', '--path', 'Objectives/Tasks', '--set', 'status=backlog', '--all', '--execute', '--backup'],
        vaultDir
      );
      expect(result.exitCode, result.stderr).toBe(0);

      const backups = join(vaultDir, '.bwrb', 'backups');
      const [backup] = await readdir(backups);
      const manifest = JSON.parse(await readFile(join(backups, backup!, 'manifest.json'), 'utf-8')) as { files: string[] };
      expect(manifest.files).toContain(BROKEN_NOTE);
    });
  });

  describe('--where', () => {
    it('sees file.path and file.folder with forward slashes', async () => {
      const byPath = await runCLI(['list', '--where', `file.path == '${BROKEN_NOTE}'`, '--output', 'paths'], vaultDir);
      expect(byPath.stdout.trim()).toBe(BROKEN_NOTE);

      const byFolder = await runCLI(['list', '--where', "file.folder == 'Objectives/Tasks'", '--output', 'paths'], vaultDir);
      expect(byFolder.stdout.split('\n')).toContain(BROKEN_NOTE);
    });
  });

  describe('forward-slash input', () => {
    it('finds a note by its path in audit and --path', async () => {
      expect(await auditedPaths(BROKEN_NOTE)).toEqual([BROKEN_NOTE]);
      expect(await auditedPaths('--path', 'Objectives/Tasks/*')).toContain(BROKEN_NOTE);
    });

    it('keeps glob escapes in --path', async () => {
      await writeFile(join(vaultDir, 'Ideas', '[draft].md'), '---\ntype: idea\nstatus: nope\n---\n');
      const pattern = 'Ideas/\\[draft\\].md';

      const list = await runCLI(['list', '--path', pattern, '--output', 'paths'], vaultDir);
      expect(list.stdout.trim()).toBe('Ideas/[draft].md');
      expect(await auditedPaths('--path', pattern)).toEqual(['Ideas/[draft].md']);
    });

    it('finds a note by a name with a backslash', async () => {
      await writeFile(
        join(vaultDir, 'Ideas', 'Band.md'),
        '---\ntype: idea\nid: 11111111-2222-4333-8444-666666666666\nname: AC\\DC\nstatus: raw\n---\n'
      );

      const result = await runCLI(['list', '--lineage', 'AC\\DC', '--output', 'paths'], vaultDir);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('Ideas/Band.md');
    });

    it('finds a note by its absolute path', async () => {
      const result = await runCLI(
        ['edit', join(vaultDir, 'Objectives', 'Tasks', 'Broken.md'), '--json', '{"status":"backlog"}'],
        vaultDir
      );

      expect(result.exitCode, result.stderr).toBe(0);
    });
  });

  describe.runIf(ON_WINDOWS)('backslash input on Windows', () => {
    it('finds a note in audit and --path', async () => {
      expect(await auditedPaths(BROKEN_NOTE_BACKSLASHES)).toEqual([BROKEN_NOTE]);
      expect(await auditedPaths('--path', 'Objectives\\Tasks\\*')).toContain(BROKEN_NOTE);
    });

    it('filters list and bulk by --path', async () => {
      const list = await runCLI(['list', '--path', 'Objectives\\Tasks', '--output', 'paths'], vaultDir);
      expect(list.stdout.split('\n')).toContain(BROKEN_NOTE);

      const bulk = await runCLI(
        ['bulk', '--type', 'task', '--path', 'Objectives\\Tasks', '--set', 'status=backlog', '--all', '--execute'],
        vaultDir
      );
      expect(bulk.exitCode, bulk.stderr).toBe(0);
      expect(await readFile(join(vaultDir, 'Objectives', 'Tasks', 'Broken.md'), 'utf-8')).toContain('status: backlog');
    });

    it('edits and deletes a note by path', async () => {
      const edit = await runCLI(['edit', BROKEN_NOTE_BACKSLASHES, '--json', '{"status":"backlog"}'], vaultDir);
      expect(edit.exitCode, edit.stderr).toBe(0);

      const remove = await runCLI(['delete', BROKEN_NOTE_BACKSLASHES, '--force'], vaultDir);
      expect(remove.exitCode, remove.stderr).toBe(0);
      expect(existsSync(join(vaultDir, 'Objectives', 'Tasks', 'Broken.md'))).toBe(false);
    });
  });
});

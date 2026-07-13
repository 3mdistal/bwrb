import { spawn } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_PATH,
  PROJECT_ROOT,
  cleanupTestVault,
  createTestVault,
  runCLI,
  waitForFile,
  withTestCliNodeOptions,
} from '../fixtures/setup.js';
import { insertFrontmatterScalarPreservingBytes, parseNote } from '../../../src/lib/frontmatter.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { editNoteInteractive } from '../../../src/lib/edit.js';
import { ConcurrentNoteModificationError } from '../../../src/lib/errors.js';
import { noteRevision } from '../../../src/lib/note-revision.js';

const CLI_SRC_PATH = join(PROJECT_ROOT, 'src/index.ts');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const USE_DIST = process.env.BWRB_TEST_DIST === '1';
const CHILD_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

interface RunningCli {
  completion: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  kill: () => void;
}

function spawnCli(args: string[], cwd: string, barrierDir: string): RunningCli {
  const command = process.execPath;
  const cliArgs = USE_DIST
    ? [CLI_PATH, '--vault', cwd, ...args]
    : [TSX_CLI, CLI_SRC_PATH, '--vault', cwd, ...args];
  const child = spawn(command, cliArgs, {
    cwd,
    env: withTestCliNodeOptions({
      ...process.env,
      NO_COLOR: '1',
      BWRB_TEST_EDIT_BARRIER_ENABLED: '1',
      BWRB_TEST_EDIT_BARRIER_DIR: barrierDir,
    }, { useDist: USE_DIST }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      }));
    }
  );
  return { completion, kill: () => child.kill('SIGKILL') };
}

async function releaseAttempt(barrierDir: string, attempt: number): Promise<void> {
  await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
  await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
}

describe('edit versus lineage identity writes', () => {
  let vaultDir: string;
  const running: RunningCli[] = [];

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    for (const process of running) process.kill();
    await cleanupTestVault(vaultDir);
  });

  it('replays a JSON edit after new --fork backfills the source ID', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Fork Race Source.md');
    const sourceRaw = '\uFEFF---\r\ntype: "idea" # quoted\r\nstatus: raw\r\npriority: medium\r\nprovider: { remote: keep-me }\r\n---\r\nBody bytes.\r\n';
    await writeFile(sourcePath, sourceRaw);
    const barrierDir = join(vaultDir, '.barrier-fork');
    const edit = spawnCli([
      'edit', sourcePath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir, barrierDir);
    running.push(edit);

    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
    const fork = await runCLI([
      'new', '--fork', sourcePath, '--name', 'Fork Race Child', '--output', 'json',
    ], vaultDir);
    expect(fork.exitCode, fork.stderr || fork.stdout).toBe(0);
    const forkJson = JSON.parse(fork.stdout) as { id: string; forked_from: string; path: string };
    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
    await releaseAttempt(barrierDir, 2);

    const edited = await edit.completion;
    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({ success: true, updated: ['priority'] });
    const source = await parseNote(sourcePath);
    expect(source.frontmatter).toMatchObject({
      id: forkJson.forked_from,
      priority: 'high',
      provider: { remote: 'keep-me' },
    });
    expect(source.body).toBe('Body bytes.\r\n');
    expect((await parseNote(join(vaultDir, forkJson.path))).frontmatter['forked-from'])
      .toBe(forkJson.forked_from);

    const expectedPath = join(vaultDir, 'Ideas/Fork Race Expected.md');
    await writeFile(
      expectedPath,
      insertFrontmatterScalarPreservingBytes(sourceRaw, 'id', forkJson.forked_from)
    );
    const sequential = await runCLI([
      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir);
    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
    expect(await readFile(sourcePath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
  });

  it('does not replay a stale revision-guarded JSON edit', async () => {
    const notePath = join(vaultDir, 'Ideas/Guarded Race.md');
    const originalRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nOriginal body.\n';
    const newerRaw = `${originalRaw}\nExternal body edit.\n`;
    await writeFile(notePath, originalRaw);
    const barrierDir = join(vaultDir, '.barrier-guarded');
    const edit = spawnCli([
      'edit', notePath, '--json', '{"priority":"high"}',
      '--expected-revision', noteRevision(originalRaw), '--output', 'json',
    ], vaultDir, barrierDir);
    running.push(edit);

    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
    await writeFile(notePath, newerRaw);
    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');

    const result = await edit.completion;
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      code: 'REVISION_MISMATCH',
      expectedRevision: noteRevision(originalRaw),
      currentRevision: noteRevision(newerRaw),
    });
    expect(await readFile(notePath, 'utf-8')).toBe(newerRaw);
  });

  it('replays a JSON edit after lineage adopt writes immutable provenance', async () => {
    const childPath = join(vaultDir, 'Ideas/Adopt Race Child.md');
    const parentPath = join(vaultDir, 'Ideas/Adopt Race Parent.md');
    const childRaw = `---\ntype: idea\nid: ${CHILD_ID}\nstatus: raw\npriority: medium\nprovider: { remote: child }\n---\nChild body.\n`;
    const parentRaw = `---\ntype: idea\nid: ${PARENT_ID}\nstatus: raw\npriority: medium\n---\nParent body.\n`;
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const barrierDir = join(vaultDir, '.barrier-adopt');
    const edit = spawnCli([
      'edit', childPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir, barrierDir);
    running.push(edit);

    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
    const adopted = await runCLI([
      'lineage', 'adopt', childPath, '--from', parentPath, '--execute', '--output', 'json',
    ], vaultDir);
    expect(adopted.exitCode, adopted.stderr || adopted.stdout).toBe(0);
    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
    await releaseAttempt(barrierDir, 2);

    const edited = await edit.completion;
    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
    const child = await parseNote(childPath);
    expect(child.frontmatter).toMatchObject({
      id: CHILD_ID,
      'forked-from': PARENT_ID,
      priority: 'high',
      provider: { remote: 'child' },
    });
    expect(child.body).toBe('Child body.\n');

    const expectedPath = join(vaultDir, 'Ideas/Adopt Race Expected.md');
    await writeFile(
      expectedPath,
      insertFrontmatterScalarPreservingBytes(childRaw, 'forked-from', PARENT_ID)
    );
    const sequential = await runCLI([
      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir);
    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
    expect(await readFile(childPath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
  });

  it.each(['json', 'text'] as const)(
    'preserves the newest bytes and emits a stable retryable %s error after retry exhaustion',
    async (output) => {
      const notePath = join(vaultDir, `Ideas/Retry Exhaustion ${output}.md`);
      let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nOriginal body.\n';
      await writeFile(notePath, currentRaw);
      const barrierDir = join(vaultDir, `.barrier-${output}`);
      const edit = spawnCli([
        'edit', notePath, '--json', '{"priority":"high"}', '--output', output,
      ], vaultDir, barrierDir);
      running.push(edit);

      for (let attempt = 1; attempt <= 3; attempt++) {
        await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
        currentRaw = currentRaw.replace('Original body.', `Original body. external-${attempt}`);
        await writeFile(notePath, currentRaw);
        await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
      }

      const result = await edit.completion;
      expect(result.exitCode).toBe(2);
      expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
      if (output === 'json') {
        expect(JSON.parse(result.stdout)).toEqual({
          success: false,
          error: 'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.',
          code: 2,
          data: {
            reason: 'note-modified-concurrently',
            retryable: true,
            path: `Ideas/Retry Exhaustion ${output}.md`,
            attempts: 3,
          },
        });
      } else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.'
        );
      }
    }
  );

  it('does not replay interactive answers or write when its snapshot is stale', async () => {
    const notePath = join(vaultDir, 'Ideas/Interactive Stale.md');
    const originalRaw = '---\ntype: idea\nstatus: raw\n---\nOriginal body.\n';
    const newerRaw = '---\ntype: idea\nid: 33333333-3333-4333-8333-333333333333\nstatus: raw\n---\nOriginal body.\n';
    await writeFile(notePath, originalRaw);
    const schema = await loadSchema(vaultDir);
    const idea = schema.types.get('idea')!;
    idea.fields = { type: { value: 'idea' } };
    idea.fieldOrder = ['type'];

    await expect(editNoteInteractive(schema, vaultDir, notePath, {
      checkSections: false,
      beforeCommit: async () => { await writeFile(notePath, newerRaw); },
    })).rejects.toBeInstanceOf(ConcurrentNoteModificationError);
    expect(await readFile(notePath, 'utf-8')).toBe(newerRaw);
  });

  it('maps stale edit JSON through the same numeric retryable contract', async () => {
    const notePath = join(vaultDir, 'Ideas/Search Retry Exhaustion.md');
    let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nSearch body.\n';
    await writeFile(notePath, currentRaw);
    const barrierDir = join(vaultDir, '.barrier-search');
    const edit = spawnCli([
      'edit', 'Search Retry Exhaustion', '--json', '{"priority":"high"}',
      '--output', 'json', '--picker', 'none',
    ], vaultDir, barrierDir);
    running.push(edit);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
      currentRaw = currentRaw.replace('Search body.', `Search body. external-${attempt}`);
      await writeFile(notePath, currentRaw);
      await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
    }

    const result = await edit.completion;
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      code: 2,
      data: {
        reason: 'note-modified-concurrently',
        retryable: true,
        path: 'Ideas/Search Retry Exhaustion.md',
        attempts: 3,
      },
    });
    expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
  });
});

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { readdir, readFile, mkdir, writeFile, utimes } from 'fs/promises';
import { join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestVault, createTestVault, PROJECT_ROOT } from '../fixtures/setup.js';

interface VaultFile {
  path: string;
  sha256: string;
}

interface RawCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DIST_CLI = join(PROJECT_ROOT, 'dist/index.js');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SOURCE_CLI = join(PROJECT_ROOT, 'src/index.ts');

async function runRawCli(args: string[], vaultDir: string): Promise<RawCliResult> {
  const useDist = process.env.BWRB_TEST_DIST === '1';
  const cliArgs = useDist
    ? [DIST_CLI, '--vault', vaultDir, ...args]
    : [TSX_CLI, SOURCE_CLI, '--vault', vaultDir, ...args];

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0205']
          .filter(Boolean)
          .join(' '),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

async function vaultFileHashes(root: string, directory = root): Promise<VaultFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: VaultFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await vaultFileHashes(root, absolutePath));
    } else if (entry.isFile()) {
      files.push({
        path: relative(root, absolutePath),
        sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function expectReadOnlyBytes(
  vaultDir: string,
  args: string[],
  stdout: string
): Promise<void> {
  const before = await vaultFileHashes(vaultDir);
  const result = await runRawCli(args, vaultDir);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(stdout);
  expect(await vaultFileHashes(vaultDir)).toEqual(before);
}

describe('flat list/recent presentation byte contracts', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    for (const name of ['Sample Idea.md', 'Another Idea.md']) {
      const path = join(vaultDir, 'Ideas', name);
      await writeFile(path, `${await readFile(path, 'utf8')}\nBody status marker.\n`);
    }
    const epoch = new Date('2024-01-01T00:00:00.000Z');
    await utimes(join(vaultDir, 'Ideas', 'Sample Idea.md'), epoch, epoch);
    await utimes(join(vaultDir, 'Ideas', 'Another Idea.md'), new Date(epoch.getTime() + 1000), new Date(epoch.getTime() + 1000));
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('freezes list paths/link ordering, newline, empty-state output, and vault bytes', async () => {
    await expectReadOnlyBytes(
      vaultDir,
      ['list', 'idea', '--sort', '_path', '--output', 'paths'],
      'Ideas/Another Idea.md\nIdeas/Sample Idea.md\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['list', 'idea', '--sort', '_path', '--output', 'link'],
      '[[Another Idea]]\n[[Sample Idea]]\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['list', 'idea', '--where', "status == 'settled'", '--output', 'paths'],
      "No notes found matching: type=idea AND where=(status == 'settled')\n"
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['list', 'idea', '--where', "status == 'settled'", '--output', 'link'],
      "No notes found matching: type=idea AND where=(status == 'settled')\n"
    );
  });

  it('freezes recent paths/link recency ordering, newline, empty output, and vault bytes', async () => {
    await expectReadOnlyBytes(
      vaultDir,
      ['recent', '--type', 'idea', '--output', 'paths'],
      'Ideas/Another Idea.md\nIdeas/Sample Idea.md\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['recent', '--type', 'idea', '--output', 'link'],
      '[[Another Idea]]\n[[Sample Idea]]\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['recent', '--path', 'DoesNotExist/**', '--output', 'paths'],
      ''
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['recent', '--path', 'DoesNotExist/**', '--output', 'link'],
      ''
    );
  });

  it('preserves duplicate-basename links without folding them into presentation', async () => {
    await mkdir(join(vaultDir, 'Duplicates', 'One'), { recursive: true });
    await mkdir(join(vaultDir, 'Duplicates', 'Two'), { recursive: true });
    const note = '---\ntype: idea\nstatus: raw\n---\n';
    await writeFile(join(vaultDir, 'Duplicates', 'One', 'Duplicate.md'), note);
    await writeFile(join(vaultDir, 'Duplicates', 'Two', 'Duplicate.md'), note);

    await expectReadOnlyBytes(
      vaultDir,
      ['list', '--path', 'Duplicates/**', '--sort', '_path', '--output', 'paths'],
      'Duplicates/One/Duplicate.md\nDuplicates/Two/Duplicate.md\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['list', '--path', 'Duplicates/**', '--sort', '_path', '--output', 'link'],
      '[[Duplicate]]\n[[Duplicate]]\n'
    );
  });

  it('keeps detailed body-search compatibility on its separate rendering path', async () => {
    await expectReadOnlyBytes(
      vaultDir,
      ['list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'paths'],
      'Ideas/Another Idea.md\nIdeas/Sample Idea.md\n'
    );
    await expectReadOnlyBytes(
      vaultDir,
      ['list', '--body', 'status', '--matches', '--path', 'Ideas/**', '--output', 'link'],
      '[[Another Idea]]\n[[Sample Idea]]\n'
    );
  });
});

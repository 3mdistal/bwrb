import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestVault, createTestVault, PROJECT_ROOT } from '../fixtures/setup.js';

type RawCliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type VaultFile = { path: string; sha256: string };

const DIST_CLI = join(PROJECT_ROOT, 'dist/index.js');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SOURCE_CLI = join(PROJECT_ROOT, 'src/index.ts');

/**
 * Deliberately retry-zero: contract tests must expose a failed process rather
 * than masking it with a second invocation that may have different effects.
 */
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
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
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

function expectOneJsonValue(result: RawCliResult, { stderr = '' }: { stderr?: string } = {}): unknown {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe(stderr);
  expect(result.stdout).toMatch(/\n$/);
  return JSON.parse(result.stdout);
}

describe('P1 command contracts: JSON output and vault-byte invariance', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  const readOnlyCases = [
    { tier: 'P1 JSON and exits', name: 'list JSON', args: ['list', 'idea', '--output', 'json'] },
    { tier: 'P1 JSON and exits', name: 'list count JSON', args: ['list', 'idea', '--count', '--output', 'json'] },
    { tier: 'P1 audit parity', name: 'audit JSON', args: ['audit', '--output', 'json'] },
    { tier: 'P1 JSON and exits', name: 'schema list type JSON', args: ['schema', 'list', 'type', 'idea', '--output', 'json'] },
    { tier: 'P1 configuration', name: 'config list JSON', args: ['config', 'list', '--output', 'json'] },
  ] as const;

  for (const commandCase of readOnlyCases) {
    it(`${commandCase.tier}: ${commandCase.name} is one deterministic JSON value and preserves every vault byte`, async () => {
      const before = await vaultFileHashes(vaultDir);
      const first = await runRawCli([...commandCase.args], vaultDir);
      const firstJson = expectOneJsonValue(first);
      const afterFirst = await vaultFileHashes(vaultDir);
      const second = await runRawCli([...commandCase.args], vaultDir);
      const secondJson = expectOneJsonValue(second);
      const afterSecond = await vaultFileHashes(vaultDir);

      expect(firstJson).toBeDefined();
      expect(secondJson).toEqual(firstJson);
      expect(second.stdout).toBe(first.stdout);
      expect(afterFirst).toEqual(before);
      expect(afterSecond).toEqual(before);
    });
  }

  it('P1 destructive safety: bulk preview has no filesystem delta', async () => {
    const before = await vaultFileHashes(vaultDir);
    const result = await runRawCli(['bulk', '--type', 'idea', '--set', 'status=settled'], vaultDir);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(await vaultFileHashes(vaultDir)).toEqual(before);
  });

  it('P1 write validation: a successful new operation has only its allowlisted note delta', async () => {
    const before = await vaultFileHashes(vaultDir);
    const result = await runRawCli([
      'new', 'idea', '--json', '{"name":"Contract Created","status":"raw"}',
    ], vaultDir);
    const json = expectOneJsonValue(result) as { path: string; success: boolean };
    const after = await vaultFileHashes(vaultDir);
    const added = after.filter((file) => !before.some((prior) => prior.path === file.path));
    const changed = after.filter((file) => {
      const prior = before.find((candidate) => candidate.path === file.path);
      return prior !== undefined && prior.sha256 !== file.sha256;
    });
    const removed = before.filter((file) => !after.some((later) => later.path === file.path));

    expect(json.success).toBe(true);
    // New notes receive a stable ID, whose registry is the other documented
    // write owned by this operation; no unrelated vault file may appear.
    expect(added.map((file) => file.path)).toEqual([
      '.bwrb/ids.jsonl',
      'Ideas/Contract Created.md',
    ]);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('P1 write validation: failed and idempotent writes create no extra byte delta', async () => {
    const before = await vaultFileHashes(vaultDir);
    const invalid = await runRawCli([
      'new', 'idea', '--json', '{"name":"Rejected Contract","status":"not-a-status"}',
    ], vaultDir);

    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toBe('');
    expect(invalid.stdout).toMatch(/\n$/);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ success: false });
    expect(await vaultFileHashes(vaultDir)).toEqual(before);

    const idempotent = await runRawCli([
      'edit', 'Ideas/Sample Idea.md', '--json', '{"status":"raw"}', '--output', 'json',
    ], vaultDir);
    expectOneJsonValue(idempotent);
    expect(await vaultFileHashes(vaultDir)).toEqual(before);
  });

  it('P3 removed public commands and deprecated flags reject without changing vault bytes', async () => {
    const rejectedCases = [
      ['search', 'Sample Idea'],
      ['open', 'Sample Idea'],
      ['list', '--text', 'sample'],
      ['list', '--paths'],
      ['list', '--tree'],
      ['list', '--json'],
      ['list', '--roots'],
      ['list', '--children-of', 'Sample Idea'],
      ['list', '--descendants-of', 'Sample Idea'],
      ['audit', '--text', 'sample'],
      ['bulk', '--text', 'sample', '--set', 'status=raw'],
      ['delete', '--text', 'sample'],
    ];

    for (const args of rejectedCases) {
      const before = await vaultFileHashes(vaultDir);
      const result = await runRawCli(args, vaultDir);
      expect(result.exitCode, `${args.join(' ')}: ${result.stderr}`).not.toBe(0);
      expect(await vaultFileHashes(vaultDir)).toEqual(before);
    }

    expectOneJsonValue(await runRawCli(['list', '--body', 'sample', '--output', 'json'], vaultDir));
    const paths = await runRawCli(['list', '--output', 'paths'], vaultDir);
    expect(paths.exitCode, paths.stderr).toBe(0);
    expect(paths.stdout).toContain('Ideas/Sample Idea.md');
  });
});

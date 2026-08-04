import { execFile as execFileCallback } from 'child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCLI } from '../fixtures/setup.js';

const execFile = promisify(execFileCallback);
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

const createdVaults: string[] = [];

afterEach(async () => {
  await Promise.all(createdVaults.splice(0).map(vault => rm(vault, { recursive: true, force: true })));
});

describe('identity migrate', () => {
  it('defaults old vaults to registry-v1 and forward migration changes only schema mode', async () => {
    const vault = await makeVault();
    const registryPath = join(vault, '.bwrb/ids.jsonl');
    const dirtyRegistry = `${JSON.stringify({ id: IDS[0], createdAt: '2026-01-01T00:00:00.000Z', path: 'Notes/One.md' })}\n` +
      '{ deliberately malformed unfinished row\n';
    await writeFile(registryPath, dirtyRegistry);

    const preview = await runCLI([
      'identity', 'migrate', '--to', 'frontmatter-v1', '--output', 'json',
    ], vault);
    expect(preview.exitCode, preview.stderr || preview.stdout).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      success: true,
      mode: 'dry-run',
      from: 'registry-v1',
      to: 'frontmatter-v1',
      blockers: [],
    });
    expect(await readFile(registryPath, 'utf-8')).toBe(dirtyRegistry);
    expect(JSON.parse(await readFile(join(vault, '.bwrb/schema.json'), 'utf-8')).config.identity_store)
      .toBeUndefined();

    const execute = await runCLI([
      'identity', 'migrate', '--to', 'frontmatter-v1', '--execute', '--output', 'json',
    ], vault);
    expect(execute.exitCode, execute.stderr || execute.stdout).toBe(0);
    expect(JSON.parse(execute.stdout).mode).toBe('execute');
    expect(await readFile(registryPath, 'utf-8')).toBe(dirtyRegistry);
    expect(JSON.parse(await readFile(join(vault, '.bwrb/schema.json'), 'utf-8')).config.identity_store)
      .toBe('frontmatter-v1');
  });

  it('fails closed on missing, invalid, and duplicate frontmatter identity', async () => {
    const vault = await makeVault({
      notes: [
        { name: 'Missing' },
        { name: 'Invalid', id: 'not-a-uuid' },
        { name: 'Duplicate A', id: IDS[0] },
        { name: 'Duplicate B', id: IDS[0].toUpperCase() },
      ],
    });
    const schemaBefore = await readFile(join(vault, '.bwrb/schema.json'), 'utf-8');

    const preview = await runCLI([
      'identity', 'migrate', '--to', 'frontmatter-v1', '--output', 'json',
    ], vault);
    expect(preview.exitCode).toBe(0);
    const previewJson = JSON.parse(preview.stdout);
    expect(previewJson.blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
      'duplicate-note-id',
      'duplicate-note-id',
      'invalid-note-id',
      'missing-note-id',
    ]);

    const execute = await runCLI([
      'identity', 'migrate', '--to', 'frontmatter-v1', '--execute', '--output', 'json',
    ], vault);
    expect(execute.exitCode).toBe(1);
    expect(JSON.parse(execute.stdout).data.blockers).toHaveLength(4);
    expect(await readFile(join(vault, '.bwrb/schema.json'), 'utf-8')).toBe(schemaBefore);
  });

  it('rebuilds the legacy registry before reverse migration and preserves known timestamps', async () => {
    const vault = await makeVault({ identityStore: 'frontmatter-v1' });
    const registryPath = join(vault, '.bwrb/ids.jsonl');
    await writeFile(
      registryPath,
      `${JSON.stringify({ id: IDS[0], createdAt: '2025-05-04T03:02:01.000Z', path: 'Old/Path.md' })}\n`
    );

    const result = await runCLI([
      'identity', 'migrate', '--to', 'registry-v1', '--execute', '--output', 'json',
    ], vault);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const rows = (await readFile(registryPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: IDS[0],
      createdAt: '2025-05-04T03:02:01.000Z',
      path: 'Notes/One.md',
    });
    expect(JSON.parse(await readFile(join(vault, '.bwrb/schema.json'), 'utf-8')).config.identity_store)
      .toBe('registry-v1');
  });

  it('reproduces the Plaud dirty-registry collision without taking registry custody', async () => {
    const vault = await makeVault({ notes: [] });
    await execFile('git', ['init', '-q'], { cwd: vault });
    await execFile('git', ['config', 'user.email', 'fixture@example.com'], { cwd: vault });
    await execFile('git', ['config', 'user.name', 'Bowerbird Fixture'], { cwd: vault });
    await execFile('git', ['add', '.'], { cwd: vault });
    await execFile('git', ['commit', '-qm', 'fixture baseline'], { cwd: vault });

    const registryPath = join(vault, '.bwrb/ids.jsonl');
    const dirtyRows: string[] = [];
    for (let index = 0; index < 4; index++) {
      const path = `Notes/Unfinished ${index + 1}.md`;
      await writeFile(join(vault, path), note(`Unfinished ${index + 1}`, IDS[index]!));
      dirtyRows.push(JSON.stringify({
        id: IDS[index],
        createdAt: '2026-08-03T12:00:00.000Z',
        path,
      }));
    }
    await writeFile(registryPath, `${dirtyRows.join('\n')}\n`);

    const migrate = await runCLI([
      'identity', 'migrate', '--to', 'frontmatter-v1', '--execute', '--output', 'json',
    ], vault);
    expect(migrate.exitCode, migrate.stderr || migrate.stdout).toBe(0);
    const registryBeforeImport = await readFile(registryPath, 'utf-8');

    const created: Array<{ path: string; id: string }> = [];
    for (let index = 0; index < 11; index++) {
      const result = await runCLI([
        'new', 'note', '--json', JSON.stringify({ name: `Plaud Transcript ${index + 1}` }),
      ], vault);
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      const output = JSON.parse(result.stdout) as { path: string };
      const raw = await readFile(join(vault, output.path), 'utf-8');
      created.push({ path: output.path, id: raw.match(/^id:\s*([^\s]+)$/m)![1]! });
    }

    expect(new Set(created.map(item => item.id)).size).toBe(11);
    expect(await readFile(registryPath, 'utf-8')).toBe(registryBeforeImport);

    const moved = created[0]!;
    const movedPath = 'Notes/Renamed Plaud Transcript.md';
    await execFile('git', ['add', moved.path], { cwd: vault });
    await execFile('git', ['mv', moved.path, movedPath], { cwd: vault });
    const resolved = await runCLI(['list', '--id', moved.id, '--output', 'json'], vault);
    expect(resolved.exitCode, resolved.stderr || resolved.stdout).toBe(0);
    expect(resolved.stdout).toContain(movedPath);

    const copiedPath = join(vault, 'Notes/Copied Plaud Transcript.md');
    await copyFile(join(vault, movedPath), copiedPath);
    const duplicate = await runCLI([
      'audit', '--only', 'duplicate-note-id', '--output', 'json',
    ], vault);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stdout).toContain('duplicate-note-id');
    expect(duplicate.stdout).toContain('Copied Plaud Transcript.md');
    expect(duplicate.stdout).toContain('Renamed Plaud Transcript.md');
    expect(await readFile(registryPath, 'utf-8')).toBe(registryBeforeImport);
  });

  it('lets unrelated frontmatter-v1 creates complete concurrently without registry custody', async () => {
    const vault = await makeVault({ identityStore: 'frontmatter-v1', notes: [] });
    const registryPath = join(vault, '.bwrb/ids.jsonl');
    const dirtyRegistry = '{"unfinished":"belongs-to-another-transaction"}\n';
    await writeFile(registryPath, dirtyRegistry);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => runCLI([
        'new', 'note', '--json', JSON.stringify({ name: `Concurrent ${index + 1}` }),
      ], vault))
    );

    for (const result of results) {
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    }
    const paths = results.map(result => (JSON.parse(result.stdout) as { path: string }).path);
    const ids = await Promise.all(paths.map(async path => {
      const raw = await readFile(join(vault, path), 'utf-8');
      return raw.match(/^id:\s*([^\s]+)$/m)![1]!;
    }));
    expect(new Set(ids).size).toBe(8);
    expect(await readFile(registryPath, 'utf-8')).toBe(dirtyRegistry);
  });
});

async function makeVault(options: {
  identityStore?: 'registry-v1' | 'frontmatter-v1';
  notes?: Array<{ name: string; id?: string }>;
} = {}): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-identity-'));
  createdVaults.push(vault);
  await mkdir(join(vault, '.bwrb'), { recursive: true });
  await mkdir(join(vault, 'Notes'), { recursive: true });
  const config = options.identityStore ? { identity_store: options.identityStore } : {};
  await writeFile(join(vault, '.bwrb/schema.json'), JSON.stringify({
    version: 2,
    config,
    types: {
      note: {
        fields: {},
        output_dir: 'Notes',
      },
    },
  }, null, 2));
  const notes = options.notes ?? [{ name: 'One', id: IDS[0] }];
  for (const entry of notes) {
    await writeFile(join(vault, `Notes/${entry.name}.md`), note(entry.name, entry.id));
  }
  return vault;
}

function note(name: string, id?: string): string {
  return `---\ntype: note\n${id === undefined ? '' : `id: ${id}\n`}name: ${name}\n---\n`;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { parseDocument } from 'yaml';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import { loadSchema, resolveTypeFromFrontmatter } from '../../../src/lib/schema.js';
import { parseNoteContent } from '../../../src/lib/frontmatter.js';
import {
  buildVaultNoteSnapshotFromFiles,
  deriveNotePathMap,
  deriveNoteTypeMap,
  deriveNoteTargetIndex,
  type ManagedFile,
  type VaultNoteSnapshot,
  type VaultNoteSnapshotEntry,
} from '../../../src/lib/discovery.js';
import type { LoadedSchema } from '../../../src/types/schema.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const actualFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');
const read = vi.mocked(readFile);

// Frozen serial behavior from before bounded reads. Keep this independent of
// the production worker loop so equivalence covers every returned field.
async function serialSnapshot(schema: LoadedSchema, files: ManagedFile[]): Promise<VaultNoteSnapshot> {
  const notes: VaultNoteSnapshotEntry[] = [];
  for (const file of files) {
    const entry: VaultNoteSnapshotEntry = {
      path: file.path,
      relativePath: file.relativePath,
      ...(file.expectedType ? { directoryType: file.expectedType } : {}),
    };
    try {
      const raw = await readFile(file.path, 'utf-8');
      const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
      if (match && parseDocument(match[1]!).errors.length > 0) throw new Error('Malformed frontmatter');
      const { frontmatter } = parseNoteContent(raw);
      entry.frontmatter = frontmatter;
      const resolvedType = resolveTypeFromFrontmatter(schema, frontmatter);
      if (resolvedType) entry.resolvedType = resolvedType;
    } catch {
      // Existing behavior keeps unreadable/malformed notes in the inventory.
    }
    notes.push(entry);
  }
  return { notes };
}

describe('bounded snapshot reads', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    read.mockReset().mockImplementation(actualFs.readFile);
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
    read.mockClear();
  });

  afterEach(async () => {
    read.mockReset().mockImplementation(actualFs.readFile);
    await cleanupTestVault(vaultDir);
  });

  it('matches the serial snapshot and derived indexes across metadata and read failures', async () => {
    const cases = [
      ['First/Shared.md', '---\ntype: idea\naliases: [Shared Alias]\nname: First\n---\nBody\n'],
      ['Second/Shared.md', '---\ntype: idea\naliases: [Shared Alias]\nname: Second\n---\n'],
      ['CRLF.md', '---\r\ntype: idea\r\ndeadline: 2026-07-12\r\nmeta:\r\n  labels: [one, two]\r\n---\r\n'],
      ['BOM.md', '\uFEFF---\ntype: idea\nname: Unicode 雀\n---\n'],
      ['No metadata.md', 'Just a body with an example:\n```yaml\ntype: idea\n```\n'],
      ['Typeless.md', '---\nname: Untyped\n---\n'],
      ['Unknown type.md', '---\ntype: unknown-type\n---\n'],
      ['Malformed.md', '---\ntype: [\n---\n'],
      ['Duplicate keys.md', '---\ntype: idea\ntype: task\n---\n'],
      ['Unclosed.md', '---\ntype: idea\n'],
      ['Unreadable.md', '---\ntype: idea\n---\n'],
    ];
    const files: ManagedFile[] = [];
    for (const [relativePath, raw] of cases) {
      const path = join(vaultDir, relativePath!);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw!);
      files.push({ path, relativePath: relativePath!, expectedType: 'idea' });
    }
    files.push({ path: join(vaultDir, 'Deleted.md'), relativePath: 'Deleted.md' });
    // A repeated entry must still be read, with its own directory metadata.
    files.push({ ...files[0]!, expectedType: 'task' });
    const denied = files.find(file => file.relativePath === 'Unreadable.md')!.path;
    read.mockImplementation(async (path, options) => {
      if (path === denied) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
      return actualFs.readFile(path, options);
    });

    const expected = await serialSnapshot(schema, files);
    read.mockClear();
    const actual = await buildVaultNoteSnapshotFromFiles(schema, files);

    expect(actual).toEqual(expected);
    expect(read).toHaveBeenCalledTimes(files.length);
    expect(actual.notes[2]!.frontmatter).toEqual({
      type: 'idea', deadline: '2026-07-12', meta: { labels: ['one', 'two'] },
    });
    for (const name of ['Malformed.md', 'Duplicate keys.md', 'Unreadable.md', 'Deleted.md']) {
      expect(actual.notes.find(note => note.relativePath === name)!.frontmatter).toBeUndefined();
    }
    expect(actual.notes.at(-1)!.directoryType).toBe('task');
    expect(deriveNotePathMap(actual, schema)).toEqual(deriveNotePathMap(expected, schema));
    expect(deriveNoteTypeMap(actual)).toEqual(deriveNoteTypeMap(expected));
    expect(deriveNoteTargetIndex(actual, schema)).toEqual(deriveNoteTargetIndex(expected, schema));
  });

  it('limits in-flight reads to 16 and preserves discovery order under reversed completion', async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: join(vaultDir, `${index}.md`), relativePath: `${index}.md`, expectedType: 'idea',
    }));
    const pending: Array<{ index: number; resolve: (raw: string) => void; reject: (error: Error) => void }> = [];
    const completed: number[] = [];
    let active = 0;
    let peak = 0;
    read.mockImplementation(async (path) => {
      const index = files.findIndex(file => file.path === path);
      active++;
      peak = Math.max(peak, active);
      try {
        return await new Promise<string>((resolve, reject) => { pending.push({ index, resolve, reject }); });
      } finally {
        active--;
        completed.push(index);
      }
    });
    const releaseWave = () => {
      for (const item of pending.splice(0).reverse()) {
        if (item.index === 15) item.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
        else item.resolve(`---\ntype: idea\nrank: ${item.index}\n---\n`);
      }
    };

    const snapshot = buildVaultNoteSnapshotFromFiles(schema, files);
    expect(read).toHaveBeenCalledTimes(16);
    expect(active).toBe(16);
    releaseWave();
    await vi.waitFor(() => expect(pending).toHaveLength(16));
    expect(read).toHaveBeenCalledTimes(32);
    releaseWave();
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    releaseWave();
    const result = await snapshot;

    expect(peak).toBe(16);
    expect(active).toBe(0);
    expect(completed.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, index) => 15 - index));
    expect(result.notes).toEqual(files.map((file, index) => ({
      path: file.path, relativePath: file.relativePath, directoryType: 'idea',
      ...(index === 15 ? {} : { frontmatter: { type: 'idea', rank: index }, resolvedType: 'idea' }),
    })));
  });

  it('does no reads for an empty inventory', async () => {
    expect(await buildVaultNoteSnapshotFromFiles(schema, [])).toEqual({ notes: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads once per entry on every invocation without reusing prior metadata', async () => {
    const file = { path: join(vaultDir, 'Changed.md'), relativePath: 'Changed.md' };
    read.mockResolvedValueOnce('---\ntype: idea\nname: First\n---\n');
    read.mockResolvedValueOnce('---\ntype: idea\nname: Changed\n---\n');

    const first = await buildVaultNoteSnapshotFromFiles(schema, [file]);
    const second = await buildVaultNoteSnapshotFromFiles(schema, [file]);
    expect(first.notes[0]!.frontmatter?.name).toBe('First');
    expect(second.notes[0]!.frontmatter?.name).toBe('Changed');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSnapshotParseCache } from '../../../src/lib/snapshot-parse-cache.js';
import { buildVaultNoteSnapshot, buildVaultNoteSnapshotFromFiles } from '../../../src/lib/discovery.js';
import { parseNoteContent } from '../../../src/lib/frontmatter.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { cleanupTestVault, createTestVault } from '../fixtures/setup.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const read = vi.mocked(readFile);
const readsOf = (path: string) => read.mock.calls.filter(([file]) => file === path).length;
let root: string;
let vault: string;
let note: string;

// Notes written by a test are seconds old at most; moving the clock ahead
// makes them settled, as notes untouched for a while are on a real vault.
function settleWrites() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_000);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bwrb-parse-stamps-'));
  vault = await createTestVault();
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  note = join(vault, 'Ideas', 'Stamped.md');
  await writeFile(note, '---\ntype: idea\nname: One\n---\nBody\n');
  read.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await cleanupTestVault(vault);
  await rm(root, { recursive: true, force: true });
});

const nameIn = async () => (await buildVaultNoteSnapshot(await loadSchema(vault), vault))
  .notes.find(entry => entry.path === note)?.frontmatter?.name;

describe('snapshot parsing by file stamp', () => {
  it('skips reading a settled, unchanged note and reads it again after any edit', async () => {
    // Whole-millisecond times, so putting them back below restores them exactly.
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(note, aligned, aligned);
    settleWrites();
    expect(await nameIn()).toBe('One');
    expect(readsOf(note)).toBe(1);
    expect(await nameIn()).toBe('One');
    expect(readsOf(note)).toBe(1);

    // Same size, with access and modification times put back: ctime still moves.
    const before = await stat(note, { bigint: true });
    await writeFile(note, '---\ntype: idea\nname: Two\n---\nBody\n');
    await utimes(note, aligned, aligned);
    const after = await stat(note, { bigint: true });
    expect([after.size, after.mtimeNs, after.ino]).toEqual([before.size, before.mtimeNs, before.ino]);
    expect(await nameIn()).toBe('Two');
    expect(readsOf(note)).toBe(2);

    // An editor's atomic save replaces the file, so its file ID changes too.
    const replacement = join(vault, 'Ideas', 'Stamped.md.tmp');
    await writeFile(replacement, '---\ntype: idea\nname: Six\n---\nBody\n');
    await rename(replacement, note);
    expect(await nameIn()).toBe('Six');
    expect(readsOf(note)).toBe(3);
  });

  it('keeps reading a note that changed within the settle window', async () => {
    expect(await nameIn()).toBe('One');
    expect(await nameIn()).toBe('One');
    expect(readsOf(note)).toBe(2);
  });

  it('matches an uncached snapshot on cold, warm and stamp-hit runs, including malformed and deleted notes', async () => {
    const malformed = join(vault, 'Ideas', 'Malformed.md');
    await writeFile(malformed, '---\ntype: [\n---\n');
    const files = [{ path: note, relativePath: 'Ideas/Stamped.md', expectedType: 'idea' },
      { path: malformed, relativePath: 'Ideas/Malformed.md', expectedType: 'idea' }];
    const schema = await loadSchema(vault);
    const expected = await buildVaultNoteSnapshotFromFiles(schema, files);
    settleWrites();
    const cold = await openSnapshotParseCache(vault);
    expect(await buildVaultNoteSnapshotFromFiles(schema, files, cold)).toEqual(expected);
    await cold.flush();
    read.mockClear();
    const warm = await openSnapshotParseCache(vault);
    expect(await buildVaultNoteSnapshotFromFiles(schema, files, warm)).toEqual(expected);
    // The malformed note is never cached, so only it is read again.
    expect(readsOf(note)).toBe(0);
    expect(readsOf(malformed)).toBe(1);
    await rm(note);
    const missing = await buildVaultNoteSnapshotFromFiles(schema, files, warm);
    expect(missing.notes).toHaveLength(2);
    expect(missing.notes[0]?.frontmatter).toBeUndefined();
  });

  it('ignores damaged stamps but keeps the parsed entries they point to', async () => {
    settleWrites();
    const first = await openSnapshotParseCache(vault);
    const parse = (raw: string) => parseNoteContent(raw).frontmatter;
    await first.read(note, parse);
    await first.flush();
    const file = join(root, 'cache', 'bwrb', 'snapshot-parsing', `node-${process.versions.node.split('.')[0]}`, 'snapshot.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    expect(data.stamps).toHaveLength(1);
    data.stamps[0][2] = '0'.repeat(64);
    await writeFile(file, JSON.stringify(data));
    read.mockClear();
    const reopened = await openSnapshotParseCache(vault);
    const parser = vi.fn(parse);
    expect(await reopened.read(note, parser)).toEqual({ type: 'idea', name: 'One' });
    expect(readsOf(note)).toBe(1);
    expect(parser).not.toHaveBeenCalled();
  });
});

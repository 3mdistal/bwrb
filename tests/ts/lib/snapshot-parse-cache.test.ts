import { existsSync } from 'fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSnapshotParseCache } from '../../../src/lib/snapshot-parse-cache.js';
import { parseNoteContent } from '../../../src/lib/frontmatter.js';
import { buildVaultNoteSnapshot, buildVaultNoteSnapshotFromFiles, deriveNotePathMap, deriveNoteTargetIndex } from '../../../src/lib/discovery.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { cleanupTestVault, createTestVault } from '../fixtures/setup.js';

let root: string;
let vault: string;
let home: string;
const raw = '---\ntype: idea\nname: Original\ndate: 2026-10-29\ntags: [one, two]\n---\nBody\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bwrb-parse-cache-'));
  vault = await createTestVault();
  home = join(root, 'cache');
  vi.stubEnv('XDG_CACHE_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTestVault(vault);
  await rm(root, { recursive: true, force: true });
});
async function cacheFile() {
  return join(home, 'bwrb', 'snapshot-parsing', `node-${process.versions.node.split('.')[0]}`, 'snapshot.json');
}

describe('persistent snapshot parsing', () => {
  it('reuses normalized metadata after reopening, without sharing mutable snapshot values', async () => {
    const first = await openSnapshotParseCache(vault);
    const parsed = first.parse(raw, () => parseNoteContent(raw).frontmatter);
    (parsed.tags as string[]).push('caller mutation');
    await first.flush();
    const second = await openSnapshotParseCache(vault);
    const parser = vi.fn(() => { throw new Error('cache miss'); });
    expect(second.parse(raw, parser)).toEqual(parseNoteContent(raw).frontmatter);
    expect(parser).not.toHaveBeenCalled();
    expect((await stat(await cacheFile())).size).toBeLessThan(32 * 1024 * 1024);
  });

  it('observes same-size edits with restored mtimes, renames, additions and new ignore rules', async () => {
    const source = join(vault, 'Ideas', 'CacheProof.md');
    const initial = '---\ntype: idea\nname: One\n---\n';
    await writeFile(source, initial);
    const schema = await loadSchema(vault);
    await buildVaultNoteSnapshot(schema, vault);
    const previous = await stat(source);
    await writeFile(source, initial.replace('One', 'Two'));
    await utimes(source, previous.atime, previous.mtime);
    const changed = await buildVaultNoteSnapshot(schema, vault);
    expect(changed.notes.find(note => note.path === source)?.frontmatter?.name).toBe('Two');
    const renamed = join(vault, 'Ideas', 'Renamed.md');
    await rename(source, renamed);
    const moved = await buildVaultNoteSnapshot(schema, vault);
    expect(moved.notes.some(note => note.path === source)).toBe(false);
    expect(moved.notes.find(note => note.path === renamed)?.frontmatter?.name).toBe('Two');
    await rm(renamed);
    const added = join(vault, 'Ideas', 'Added.md');
    await writeFile(added, initial);
    expect((await buildVaultNoteSnapshot(schema, vault)).notes.some(note => note.path === added)).toBe(true);
    await writeFile(join(vault, '.bwrbignore'), 'Ideas/Added.md\n');
    expect((await buildVaultNoteSnapshot(schema, vault)).notes.some(note => note.path === added)).toBe(false);
  });

  it('shares only content-derived parsing across different vault/worktree paths', async () => {
    const cache = await openSnapshotParseCache(vault);
    cache.parse(raw, () => parseNoteContent(raw).frontmatter);
    await cache.flush();
    const other = join(root, 'another-worktree');
    await mkdir(other);
    const reopened = await openSnapshotParseCache(other);
    const parser = vi.fn(() => { throw new Error('should reuse identical bytes'); });
    expect(reopened.parse(raw, parser)).toEqual(parseNoteContent(raw).frontmatter);
    expect(parser).not.toHaveBeenCalled();
  });

  it('matches the uncached snapshot/indexes, including malformed and now-deleted notes', async () => {
    const path = join(vault, 'Ideas', 'CacheProof.md');
    const malformed = join(vault, 'Ideas', 'Malformed.md');
    await writeFile(path, raw);
    await writeFile(malformed, '---\ntype: [\n---\n');
    const files = [{ path, relativePath: 'Ideas/CacheProof.md', expectedType: 'idea' },
      { path: malformed, relativePath: 'Ideas/Malformed.md', expectedType: 'idea' }];
    const schema = await loadSchema(vault);
    const first = await openSnapshotParseCache(vault);
    await buildVaultNoteSnapshotFromFiles(schema, files, first);
    await first.flush();
    const second = await openSnapshotParseCache(vault);
    const expected = await buildVaultNoteSnapshotFromFiles(schema, files);
    const actual = await buildVaultNoteSnapshotFromFiles(schema, files, second);
    expect(actual).toEqual(expected);
    expect(deriveNotePathMap(actual, schema)).toEqual(deriveNotePathMap(expected, schema));
    expect(deriveNoteTargetIndex(actual, schema)).toEqual(deriveNoteTargetIndex(expected, schema));
    const changedSchema = { ...schema, types: new Map(schema.types) };
    changedSchema.types.delete('idea');
    expect(await buildVaultNoteSnapshotFromFiles(changedSchema, files, second))
      .toEqual(await buildVaultNoteSnapshotFromFiles(changedSchema, files));
    await rm(path);
    const missing = await buildVaultNoteSnapshotFromFiles(schema, files, second);
    expect(missing.notes[0]?.frontmatter).toBeUndefined();
    expect(missing.notes).toHaveLength(2);
  });

  it.each(['truncated', 'checksum', 'parser', 'format'])('ignores %s cache corruption', async damage => {
    const cache = await openSnapshotParseCache(vault);
    cache.parse(raw, () => ({ name: 'Original' }));
    await cache.flush();
    const file = await cacheFile();
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (damage === 'checksum') data.entries[0][1] = '{"name":"Poisoned"}';
    else if (damage !== 'truncated') data[damage] = 'unknown';
    await writeFile(file, damage === 'truncated' ? '{' : JSON.stringify(data));
    const reopened = await openSnapshotParseCache(vault);
    const parser = vi.fn(() => ({ name: 'Fresh' }));
    expect(reopened.parse(raw, parser)).toEqual({ name: 'Fresh' });
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it('does not cache lossy JSON values or parsing failures', async () => {
    const values = [NaN, Infinity, -0, undefined, new Array(2)];
    const cache = await openSnapshotParseCache(vault);
    values.forEach((value, index) => cache.parse(String(index), () => ({ value })));
    expect(() => cache.parse('bad', () => { throw new Error('parse failed'); })).toThrow('parse failed');
    await cache.flush();
    const reopened = await openSnapshotParseCache(vault);
    values.forEach((value, index) => {
      const parser = vi.fn(() => ({ value }));
      expect(reopened.parse(String(index), parser).value).toBe(value);
      expect(parser).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back cleanly on an unusable cache path and never caches inside the vault', async () => {
    const fileHome = join(root, 'not-a-directory');
    await writeFile(fileHome, 'preserve');
    const unwritable = await openSnapshotParseCache(vault, fileHome);
    expect(unwritable.parse(raw, () => ({ name: 'Fresh' }))).toEqual({ name: 'Fresh' });
    await expect(unwritable.flush()).resolves.toBeUndefined();
    expect(await readFile(fileHome, 'utf8')).toBe('preserve');
    const inside = join(vault, '..cache');
    const disabled = await openSnapshotParseCache(vault, inside);
    disabled.parse(raw, () => ({}));
    await disabled.flush();
    expect(existsSync(inside)).toBe(false);
  });

  it('keeps concurrent cache writers advisory and publishes only complete cache files', async () => {
    const left = await openSnapshotParseCache(vault);
    const right = await openSnapshotParseCache(vault);
    left.parse('left', () => ({ name: 'Left' }));
    right.parse('right', () => ({ name: 'Right' }));
    await Promise.all([left.flush(), right.flush()]);
    const reopened = await openSnapshotParseCache(vault);
    expect(reopened.parse('left', () => ({ name: 'Left' }))).toEqual({ name: 'Left' });
    expect(reopened.parse('right', () => ({ name: 'Right' }))).toEqual({ name: 'Right' });
    const requireContent = await readFile(await cacheFile(), 'utf8');
    expect(() => JSON.parse(requireContent)).not.toThrow();
    expect((await readdir(join(await cacheFile(), '..'))).filter(file => file.endsWith('.tmp'))).toEqual([]);
  });

  it('does not persist through a cache-directory link into the vault', async context => {
    const target = join(vault, 'cache-target');
    const link = join(root, 'cache-link');
    await mkdir(target);
    try { await symlink(target, link, 'junction'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    const cache = await openSnapshotParseCache(vault, link);
    cache.parse(raw, () => ({}));
    await cache.flush();
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects an oversized cache before loading its payload', async () => {
    const cache = await openSnapshotParseCache(vault);
    cache.parse(raw, () => ({ name: 'Original' }));
    await cache.flush();
    const handle = await open(await cacheFile(), 'r+');
    try { await handle.truncate(32 * 1024 * 1024 + 1); }
    finally { await handle.close(); }
    const reopened = await openSnapshotParseCache(vault);
    const parser = vi.fn(() => ({ name: 'Fresh' }));
    expect(reopened.parse(raw, parser)).toEqual({ name: 'Fresh' });
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it('evicts during parsing when the aggregate byte budget is reached', async () => {
    const cache = await openSnapshotParseCache(vault);
    const value = { text: 'x'.repeat(60 * 1024) };
    for (let index = 0; index < 600; index++) cache.parse(String(index), () => value);
    // Check eviction before flush: limiting only the file would retain all 600.
    const oldest = vi.fn(() => value);
    expect(cache.parse('0', oldest)).toEqual(value);
    expect(oldest).toHaveBeenCalledTimes(1);
    const newest = vi.fn(() => { throw new Error('newest entry must remain'); });
    expect(cache.parse('599', newest)).toEqual(value);
    expect(newest).not.toHaveBeenCalled();
    await cache.flush();
    const data = JSON.parse(await readFile(await cacheFile(), 'utf8'));
    expect(data.entries.length).toBeLessThan(600);
    expect((await stat(await cacheFile())).size).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('bounds entry count and treats evicted content as a fresh parse', async () => {
    const cache = await openSnapshotParseCache(vault);
    for (let index = 0; index <= 16_384; index++) cache.parse(String(index), () => ({ index }));
    await cache.flush();
    const data = JSON.parse(await readFile(await cacheFile(), 'utf8'));
    expect(data.entries).toHaveLength(16_384);
    const reopened = await openSnapshotParseCache(vault);
    const parser = vi.fn(() => ({ index: 0 }));
    expect(reopened.parse('0', parser)).toEqual({ index: 0 });
    expect(parser).toHaveBeenCalledTimes(1);
  });
});

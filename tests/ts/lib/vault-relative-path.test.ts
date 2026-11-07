import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unregisterIssuedNotePath } from '../../../src/lib/note-id.js';
import { vaultRelativePath, withForwardSlashes } from '../../../src/lib/vault-relative-path.js';

const ON_WINDOWS = process.platform === 'win32';

describe('withForwardSlashes', () => {
  it('leaves forward slashes alone', () => {
    expect(withForwardSlashes('Ideas/Sub/Example.md')).toBe('Ideas/Sub/Example.md');
  });

  it.runIf(ON_WINDOWS)('turns Windows separators into forward slashes', () => {
    expect(withForwardSlashes('Ideas\\Sub\\Example.md')).toBe('Ideas/Sub/Example.md');
  });

  it.skipIf(ON_WINDOWS)('keeps a backslash, which is a filename character here', () => {
    expect(withForwardSlashes('Ideas/odd\\name.md')).toBe('Ideas/odd\\name.md');
  });
});

describe('vaultRelativePath', () => {
  it('spells a nested note with forward slashes', () => {
    const vaultDir = join(tmpdir(), 'vault');

    expect(vaultRelativePath(vaultDir, join(vaultDir, 'Ideas', 'Sub', 'Example.md')))
      .toBe('Ideas/Sub/Example.md');
  });
});

describe('unregisterIssuedNotePath', () => {
  const row = (id: string, path: string) => JSON.stringify({ id, createdAt: '2026-01-01T00:00:00.000Z', path });
  let vaultDir: string;

  const writeRegistry = async (...rows: string[]) => {
    await writeFile(join(vaultDir, '.bwrb', 'ids.jsonl'), `${rows.join('\n')}\n`);
  };
  const readRegistry = () => readFile(join(vaultDir, '.bwrb', 'ids.jsonl'), 'utf-8');

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-registry-'));
    await mkdir(join(vaultDir, '.bwrb'));
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('removes the row for a forward-slash path and keeps the others', async () => {
    await writeRegistry(row('kept', 'Ideas/Kept.md'), row('gone', 'Ideas/Sub/Gone.md'));

    await unregisterIssuedNotePath(vaultDir, 'Ideas/Sub/Gone.md');

    expect(await readRegistry()).toBe(`${row('kept', 'Ideas/Kept.md')}\n`);
  });

  it.runIf(ON_WINDOWS)('removes a row written with backslashes before paths were normalized', async () => {
    await writeRegistry(row('kept', 'Ideas\\Kept.md'), row('gone', 'Ideas\\Sub\\Gone.md'));

    await unregisterIssuedNotePath(vaultDir, 'Ideas/Sub/Gone.md');

    expect(await readRegistry()).toBe(`${row('kept', 'Ideas\\Kept.md')}\n`);
  });

  it.skipIf(ON_WINDOWS)('treats a backslash in a stored path as part of the filename', async () => {
    await writeRegistry(row('kept', 'Ideas\\Gone.md'));

    await unregisterIssuedNotePath(vaultDir, 'Ideas/Gone.md');

    expect(await readRegistry()).toBe(`${row('kept', 'Ideas\\Gone.md')}\n`);
  });
});

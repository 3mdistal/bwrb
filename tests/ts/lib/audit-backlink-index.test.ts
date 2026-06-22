/**
 * Tests for the per-run backlink scanner used by `audit --fix` (#500).
 *
 * These verify that:
 * - The cached scanner produces results identical to `findWikilinksToFile`.
 * - File contents are read at most once per run (the scan is reused, not
 *   repeated, across multiple delete-safety / move lookups).
 * - Mutation hooks keep the index correct as the graph changes during a run:
 *   `noteDeleted` drops a deleted source; `invalidate` forces a re-read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, unlink, rename } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { BacklinkScanner } from '../../../src/lib/audit/backlink-index.js';
import {
  findAllMarkdownFiles,
  findWikilinksToFile,
} from '../../../src/lib/bulk/move.js';

describe('BacklinkScanner (#500)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bwrb-backlink-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedVault(): Promise<{ target: string }> {
    await mkdir(join(tempDir, 'Notes'));
    const target = join(tempDir, 'Notes', 'Target.md');
    await writeFile(target, '---\ntype: note\n---\n\nThe target note.\n');
    await writeFile(
      join(tempDir, 'Notes', 'A.md'),
      '---\ntype: note\n---\n\nLinks to [[Target]] here.\n'
    );
    await writeFile(
      join(tempDir, 'Notes', 'B.md'),
      '---\nrel: "[[Target]]"\n---\n\nAlso mentions [[Target]] twice [[Target]].\n'
    );
    await writeFile(
      join(tempDir, 'Notes', 'C.md'),
      '---\ntype: note\n---\n\nNo links at all.\n'
    );
    return { target };
  }

  it('produces results identical to findWikilinksToFile', async () => {
    const { target } = await seedVault();

    const allFiles = await findAllMarkdownFiles(tempDir);
    const expected = await findWikilinksToFile(tempDir, target, allFiles);

    const scanner = new BacklinkScanner(tempDir);
    const actual = await scanner.findReferences(target);

    expect(actual).toEqual(expected);
    // Sanity: A (1) + B (3) = 4 references, none from the target itself or C.
    expect(actual).toHaveLength(4);
  });

  it('reuses cached content across repeated lookups (no re-read)', async () => {
    const { target } = await seedVault();
    const bPath = join(tempDir, 'Notes', 'B.md');

    const scanner = new BacklinkScanner(tempDir);
    const before = await scanner.findReferences(target);
    expect(before).toHaveLength(4);

    // Mutate B's content on disk WITHOUT notifying the scanner. A cached scanner
    // must NOT observe this change on a subsequent lookup — proving it did not
    // re-read the file. (A naive per-lookup re-scan would see only 1 ref.)
    await writeFile(bPath, '---\ntype: note\n---\n\nNo more links.\n');

    const after = await scanner.findReferences(target);
    expect(after).toEqual(before);
    expect(after).toHaveLength(4);
  });

  it('noteDeleted removes a deleted source from later scans (matches live FS)', async () => {
    const { target } = await seedVault();
    const aPath = join(tempDir, 'Notes', 'A.md');

    const scanner = new BacklinkScanner(tempDir);
    const before = await scanner.findReferences(target);
    expect(before.some((r) => r.sourceFile === aPath)).toBe(true);

    // Delete A from disk AND from the index, mirroring deleteNoteWithSafety.
    await unlink(aPath);
    scanner.noteDeleted(aPath);

    const after = await scanner.findReferences(target);
    expect(after.some((r) => r.sourceFile === aPath)).toBe(false);

    // Result still matches a fresh, uncached scan of the mutated vault.
    const allFiles = await findAllMarkdownFiles(tempDir);
    const fresh = await findWikilinksToFile(tempDir, target, allFiles);
    expect(after).toEqual(fresh);
  });

  it('invalidate re-reads after a source file is rewritten/moved', async () => {
    const { target } = await seedVault();
    const bPath = join(tempDir, 'Notes', 'B.md');

    const scanner = new BacklinkScanner(tempDir);
    const before = await scanner.findReferences(target);
    expect(before).toHaveLength(4);

    // Rewrite B so it no longer links to Target, then invalidate (as a move
    // would, since it rewrites source files and renames the moved file).
    await writeFile(bPath, '---\ntype: note\n---\n\nNo more links.\n');
    scanner.invalidate();

    const after = await scanner.findReferences(target);
    // Only A's single link remains.
    expect(after).toHaveLength(1);

    const allFiles = await findAllMarkdownFiles(tempDir);
    const fresh = await findWikilinksToFile(tempDir, target, allFiles);
    expect(after).toEqual(fresh);
  });

  it('invalidate picks up newly added files', async () => {
    const { target } = await seedVault();

    const scanner = new BacklinkScanner(tempDir);
    await scanner.findReferences(target);

    await writeFile(
      join(tempDir, 'Notes', 'D.md'),
      '---\ntype: note\n---\n\nLate link to [[Target]].\n'
    );
    scanner.invalidate();

    const after = await scanner.findReferences(target);
    expect(after.some((r) => r.sourceFile.endsWith('D.md'))).toBe(true);
    expect(after).toHaveLength(5);
  });

  it('stays correct as the moved file itself is renamed', async () => {
    const { target } = await seedVault();
    const aPath = join(tempDir, 'Notes', 'A.md');

    const scanner = new BacklinkScanner(tempDir);
    await scanner.findReferences(target);

    // Rename A into an Archive folder (a move).
    await mkdir(join(tempDir, 'Archive'));
    const newAPath = join(tempDir, 'Archive', 'A.md');
    await rename(aPath, newAPath);
    scanner.invalidate();

    const after = await scanner.findReferences(target);
    const allFiles = await findAllMarkdownFiles(tempDir);
    const fresh = await findWikilinksToFile(tempDir, target, allFiles);
    expect(after).toEqual(fresh);
    expect(after.some((r) => r.sourceFile === newAPath)).toBe(true);
    expect(after.some((r) => r.sourceFile === aPath)).toBe(false);
  });
});

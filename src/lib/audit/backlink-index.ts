/**
 * Backlink index for audit `--fix` runs.
 *
 * Delete-safety and move handlers in `fix.ts` need to know which notes link to a
 * given file. The naive approach calls {@link findWikilinksToFile} per operation,
 * and that function re-reads and re-regex-scans EVERY markdown file in the vault
 * every time — so a run with D delete/move operations does O(D x N) file reads
 * over N vault files.
 *
 * {@link BacklinkScanner} reads each file at most once per run and caches its
 * content, so repeated reference lookups cost O(N) regex passes over cached
 * strings instead of O(N) fresh disk reads. The cache is kept correct as the
 * graph mutates during a run:
 *
 * - {@link BacklinkScanner.noteDeleted} drops a deleted note from the scan set
 *   (it can no longer be a backlink source, matching the live filesystem after
 *   `unlink`).
 * - {@link BacklinkScanner.invalidate} drops cached content for files a move
 *   rewrote/renamed, so the next lookup re-reads them fresh.
 *
 * The reference computation reuses the exact same file list, regex, and
 * {@link wikilinkMatchesFile} logic as {@link findWikilinksToFile}, so the
 * results are byte-for-byte identical to the unoptimized path for a given
 * on-disk state.
 */

import { readFile } from 'fs/promises';
import { relative } from 'path';
import {
  findAllMarkdownFiles,
  scanWikilinkReferencesInContent,
  type WikilinkReference,
} from '../bulk/move.js';

export class BacklinkScanner {
  private readonly vaultDir: string;
  /** Ordered list of source files to scan. Mirrors `findAllMarkdownFiles`. */
  private files: string[] | null = null;
  /** Cached file contents, keyed by absolute path. */
  private readonly contentCache = new Map<string, string>();

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
  }

  private async ensureFiles(): Promise<string[]> {
    if (this.files === null) {
      this.files = await findAllMarkdownFiles(this.vaultDir);
    }
    return this.files;
  }

  private async getContent(filePath: string): Promise<string> {
    const cached = this.contentCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }
    const content = await readFile(filePath, 'utf-8');
    this.contentCache.set(filePath, content);
    return content;
  }

  /**
   * Find all wikilink references to `targetFilePath` across the vault.
   *
   * Output is identical to {@link findWikilinksToFile} for the current on-disk
   * state, but reuses cached file contents instead of re-reading every file.
   */
  async findReferences(targetFilePath: string): Promise<WikilinkReference[]> {
    const files = await this.ensureFiles();
    const references: WikilinkReference[] = [];

    for (const sourceFile of files) {
      if (sourceFile === targetFilePath) {
        continue;
      }
      const content = await this.getContent(sourceFile);
      const sourceRelativePath = relative(this.vaultDir, sourceFile);
      references.push(
        ...scanWikilinkReferencesInContent(
          content,
          sourceFile,
          sourceRelativePath,
          targetFilePath,
          this.vaultDir
        )
      );
    }

    return references;
  }

  /**
   * Mark a note as deleted: remove it from the scan set and drop its cached
   * content, matching the live filesystem after `unlink`.
   */
  noteDeleted(filePath: string): void {
    if (this.files !== null) {
      this.files = this.files.filter((f) => f !== filePath);
    }
    this.contentCache.delete(filePath);
  }

  /**
   * Invalidate the file list and any cached content for the given paths.
   *
   * Used after a move/rename mutates the vault (source files rewritten, target
   * renamed): the file list is rebuilt and affected contents are re-read on the
   * next lookup, keeping results correct.
   */
  invalidate(paths?: Iterable<string>): void {
    this.files = null;
    if (paths) {
      for (const p of paths) {
        this.contentCache.delete(p);
      }
    } else {
      this.contentCache.clear();
    }
  }
}

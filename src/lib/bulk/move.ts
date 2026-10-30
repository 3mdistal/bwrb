/**
 * Move operation with wikilink auto-update.
 * 
 * This module handles:
 * - Moving files to a new directory
 * - Scanning the vault for wikilinks to moved files
 * - Updating wikilinks to point to new locations
 */

import { readFile, writeFile, link, unlink, mkdir, readdir, stat } from 'fs/promises';
import { join, relative, basename, extname, isAbsolute, resolve, sep } from 'path';
import { getLineageMutationLockPath, withLineageMutationLocks } from '../lineage-lock.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A wikilink reference found in a file.
 */
export interface WikilinkReference {
  /** The file containing the wikilink */
  sourceFile: string;
  /** Relative path of the source file */
  sourceRelativePath: string;
  /** The full match string (e.g., [[Target|Alias]]) */
  match: string;
  /** The link target (without brackets, heading, or alias) */
  linkTarget: string;
  /** Position in the file content */
  position: number;
  /** Line number (1-based) */
  lineNumber: number;
  /** Whether this is in frontmatter or body */
  inFrontmatter: boolean;
}

/**
 * Result of a file move operation.
 */
interface MoveResult {
  /** Original file path */
  oldPath: string;
  /** New file path */
  newPath: string;
  /** Relative paths for display */
  oldRelativePath: string;
  newRelativePath: string;
  /** Whether the move was applied */
  applied: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of a wikilink update operation.
 */
export interface WikilinkUpdateResult {
  /** File that was updated */
  filePath: string;
  relativePath: string;
  /** Number of wikilinks updated */
  linksUpdated: number;
  /** Whether the update was applied */
  applied: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Overall result of a move operation.
 */
export interface BulkMoveResult {
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Files that were moved */
  moveResults: MoveResult[];
  /** Files that had wikilinks updated */
  wikilinkUpdates: WikilinkUpdateResult[];
  /** Total wikilinks updated across all files */
  totalLinksUpdated: number;
  /** Errors encountered */
  errors: string[];
}

// ============================================================================
// Wikilink Pattern
// ============================================================================

/**
 * Wikilink regex pattern that captures the full match and components.
 * Matches: [[Target]], [[Target|Alias]], [[Target#Heading]], [[Target#Heading|Alias]]
 * Also handles path prefixes: [[Folder/Target]], [[Folder/Target|Alias]]
 */
const WIKILINK_REGEX = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]+)?\]\]/g;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Find all markdown files in a directory recursively.
 */
export async function findAllMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  async function scan(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip hidden directories and .bwrb
        if (!entry.name.startsWith('.')) {
          await scan(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  
  await scan(dir);
  return files;
}

/**
 * Get the basename of a file without extension.
 */
function getFileBasename(filePath: string): string {
  return basename(filePath, extname(filePath));
}

/**
 * Check if a wikilink target matches a file.
 * 
 * Handles various link formats:
 * - [[Filename]] - matches by basename
 * - [[Folder/Filename]] - matches by path
 */
export function wikilinkMatchesFile(
  linkTarget: string,
  filePath: string,
  vaultDir: string
): boolean {
  const fileBasename = getFileBasename(filePath);
  const fileRelPath = relative(vaultDir, filePath);
  const fileRelPathNoExt = fileRelPath.replace(/\.md$/, '');
  
  // Normalize the link target (remove .md if present)
  const normalizedTarget = linkTarget.replace(/\.md$/, '');
  
  // Check if it's just a basename match
  if (normalizedTarget === fileBasename) {
    return true;
  }
  
  // Check if it's a path match
  if (normalizedTarget === fileRelPathNoExt) {
    return true;
  }
  
  // Check if the target ends with the basename (partial path match)
  if (normalizedTarget.endsWith('/' + fileBasename)) {
    // Verify the full path matches
    return fileRelPathNoExt.endsWith(normalizedTarget);
  }
  
  return false;
}

/**
 * Scan a single file's content for wikilinks that reference a specific target.
 *
 * Extracted from {@link findWikilinksToFile} so callers that already hold the
 * file content (e.g. a cached backlink index) can compute references without
 * re-reading from disk, while producing byte-for-byte identical results.
 */
export function scanWikilinkReferencesInContent(
  content: string,
  sourceFile: string,
  sourceRelativePath: string,
  targetFilePath: string,
  vaultDir: string
): WikilinkReference[] {
  // Skip the target file itself
  if (sourceFile === targetFilePath) {
    return [];
  }

  const references: WikilinkReference[] = [];

  // Determine where frontmatter ends
  let frontmatterEnd = 0;
  if (content.startsWith('---')) {
    const endMatch = content.indexOf('\n---', 3);
    if (endMatch !== -1) {
      frontmatterEnd = endMatch + 4; // Include the closing ---\n
    }
  }

  // Find all wikilinks
  const regex = new RegExp(WIKILINK_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const linkTarget = match[1]!;

    if (wikilinkMatchesFile(linkTarget, targetFilePath, vaultDir)) {
      // Calculate line number
      const lineNumber = content.slice(0, match.index).split('\n').length;
      const inFrontmatter = match.index < frontmatterEnd;

      references.push({
        sourceFile,
        sourceRelativePath,
        match: match[0],
        linkTarget,
        position: match.index,
        lineNumber,
        inFrontmatter,
      });
    }
  }

  return references;
}

/**
 * Find all wikilinks in the vault that reference a specific file.
 */
export async function findWikilinksToFile(
  vaultDir: string,
  targetFilePath: string,
  allFiles: string[]
): Promise<WikilinkReference[]> {
  const references: WikilinkReference[] = [];

  for (const sourceFile of allFiles) {
    // Skip the target file itself
    if (sourceFile === targetFilePath) {
      continue;
    }

    const content = await readFile(sourceFile, 'utf-8');
    const sourceRelativePath = relative(vaultDir, sourceFile);

    references.push(
      ...scanWikilinkReferencesInContent(
        content,
        sourceFile,
        sourceRelativePath,
        targetFilePath,
        vaultDir
      )
    );
  }

  return references;
}

/**
 * Generate the new wikilink text after a file move.
 * 
 * Strategy: Use shortest unique path.
 * - If the filename is unique in the vault, use just [[Filename]]
 * - If not unique, use path to disambiguate [[Path/To/Filename]]
 */
export function generateUpdatedWikilink(
  oldMatch: string,
  _oldTarget: string,
  newFilePath: string,
  vaultDir: string,
  allFilePaths: string[]
): string {
  const newBasename = getFileBasename(newFilePath);
  const newRelPath = relative(vaultDir, newFilePath).replace(/\.md$/, '');
  
  // Check if the new filename is unique
  const filesWithSameName = allFilePaths.filter(f => 
    getFileBasename(f) === newBasename
  );
  
  // Determine what link text to use
  let newLinkTarget: string;
  if (filesWithSameName.length === 1) {
    // Filename is unique, use just the basename
    newLinkTarget = newBasename;
  } else {
    // Need path for disambiguation
    newLinkTarget = newRelPath;
  }
  
  // Preserve heading and alias from original link
  const headingMatch = oldMatch.match(/#([^\]|]*)/);
  const aliasMatch = oldMatch.match(/\|([^\]]+)/);
  
  let newLink = `[[${newLinkTarget}`;
  if (headingMatch) {
    newLink += headingMatch[0];
  }
  if (aliasMatch) {
    newLink += aliasMatch[0];
  }
  newLink += ']]';
  
  return newLink;
}

/**
 * Update wikilinks in a file's content.
 * Returns the new content and count of links updated.
 */
export function updateWikilinksInContent(
  content: string,
  references: WikilinkReference[],
  newFilePath: string,
  vaultDir: string,
  allFilePaths: string[]
): { newContent: string; linksUpdated: number } {
  if (references.length === 0) {
    return { newContent: content, linksUpdated: 0 };
  }
  
  // Sort references by position descending so we can replace from end to start
  // (to preserve positions)
  const sortedRefs = [...references].sort((a, b) => b.position - a.position);
  
  let newContent = content;
  let linksUpdated = 0;
  
  for (const ref of sortedRefs) {
    const newLink = generateUpdatedWikilink(
      ref.match,
      ref.linkTarget,
      newFilePath,
      vaultDir,
      allFilePaths
    );
    
    if (newLink !== ref.match) {
      newContent = 
        newContent.slice(0, ref.position) + 
        newLink + 
        newContent.slice(ref.position + ref.match.length);
      linksUpdated++;
    }
  }
  
  return { newContent, linksUpdated };
}

/**
 * Determine whether a destination path is already occupied by a *different*
 * file than the source.
 *
 * `rename` clobbers its destination silently, so before any move we must reject
 * the case where a different note already lives at `newPath` — otherwise an
 * `audit --fix` move would overwrite an unrelated file and lose its contents
 * permanently. We compare inodes (via `stat`) rather than path strings so the
 * check is correct on case-insensitive filesystems and across hardlinks: a move
 * whose source and destination resolve to the SAME on-disk file is a harmless
 * no-op (e.g. the note is already in `targetDir`) and is NOT treated as a
 * collision. A genuinely distinct file at the destination is a collision.
 */
async function destinationIsOccupiedByDifferentFile(
  filePath: string,
  newPath: string
): Promise<boolean> {
  let destStat;
  try {
    destStat = await stat(newPath);
  } catch {
    // Destination does not exist (ENOENT) — no collision.
    return false;
  }

  try {
    const srcStat = await stat(filePath);
    // Same inode + device => source and destination are the same file; a
    // rename of a file onto itself is a no-op, not a collision.
    if (srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) {
      return false;
    }
  } catch {
    // Source missing is a separate failure surfaced by the rename below; treat
    // an existing, distinct destination as a collision to stay safe.
  }

  return true;
}

/**
 * Move a file to a new directory.
 */
async function moveFile(
  filePath: string,
  targetDir: string,
  vaultDir: string,
  execute: boolean,
  targetBasename?: string
): Promise<MoveResult> {
  const fileName = targetBasename ?? basename(filePath);
  const newPath = join(targetDir, fileName);
  const oldRelativePath = relative(vaultDir, filePath);
  const newRelativePath = relative(vaultDir, newPath);

  const result: MoveResult = {
    oldPath: filePath,
    newPath,
    oldRelativePath,
    newRelativePath,
    applied: false,
  };

  if (!execute) {
    return result;
  }

  if (resolve(filePath) === resolve(newPath)) {
    result.applied = true;
    return result;
  }

  try {
    // Ensure target directory exists
    await mkdir(targetDir, { recursive: true });

    // Guard against clobbering an existing, DIFFERENT file at the destination.
    // `rename` would silently overwrite it (permanent data loss), so skip the
    // move and report a clear conflict instead of falsely claiming success.
    if (await destinationIsOccupiedByDifferentFile(filePath, newPath)) {
      result.error = `destination already exists, skipped: ${newRelativePath}`;
      return result;
    }

    // Claim the destination atomically without replacement, then remove the
    // source link. Unlike rename(), link() fails with EEXIST if a concurrent
    // writer wins the destination path after our preflight check.
    await link(filePath, newPath);
    // On unlink failure preserve both names. Duplicate hardlinks are
    // recoverable; cleanup could race and delete another writer's file.
    await unlink(filePath);
    result.applied = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * How many times a locked move scans the vault again when notes gain links to
 * the moved notes while it waits for its locks.
 */
const MOVE_LOCK_ATTEMPTS = 3;

/**
 * Find the notes that link to the moved notes, reading each vault file once.
 *
 * Maps each linking note to the moved notes it links to. The notes come in the
 * order {@link findWikilinksToFile} finds them when called once per moved
 * note: by the first moved note they link to, then in vault-file order.
 */
async function findLinkingNotes(
  vaultDir: string,
  filesToMove: string[],
  allVaultFiles: string[]
): Promise<Map<string, string[]>> {
  // Many notes share link targets, so match each distinct target once.
  const movedIndexesByTarget = new Map<string, number[]>();
  const movedIndexesFor = (linkTarget: string): number[] => {
    let indexes = movedIndexesByTarget.get(linkTarget);
    if (!indexes) {
      indexes = filesToMove.flatMap((movedFile, index) =>
        wikilinkMatchesFile(linkTarget, movedFile, vaultDir) ? [index] : []
      );
      movedIndexesByTarget.set(linkTarget, indexes);
    }
    return indexes;
  };

  const found: { sourceFile: string; movedIndexes: number[] }[] = [];
  for (const sourceFile of allVaultFiles) {
    // A note's links to itself are never rewritten, so a single moved note
    // need not be read.
    if (filesToMove.length === 1 && filesToMove[0] === sourceFile) continue;

    const content = await readFile(sourceFile, 'utf-8');
    const movedIndexes = new Set<number>();
    for (const match of content.matchAll(new RegExp(WIKILINK_REGEX.source, 'g'))) {
      for (const index of movedIndexesFor(match[1]!)) {
        if (filesToMove[index] !== sourceFile) movedIndexes.add(index);
      }
    }
    if (movedIndexes.size > 0) {
      found.push({ sourceFile, movedIndexes: [...movedIndexes].sort((a, b) => a - b) });
    }
  }

  found.sort((a, b) => a.movedIndexes[0]! - b.movedIndexes[0]!);
  return new Map(found.map(entry => [entry.sourceFile, entry.movedIndexes.map(index => filesToMove[index]!)]));
}

interface MovePlan {
  vaultDir: string;
  absoluteTargetDir: string;
  filesToMove: string[];
  execute: boolean;
  targetBasenames?: ReadonlyMap<string, string>;
}

function destinationPath(plan: MovePlan, filePath: string): string {
  return join(plan.absoluteTargetDir, plan.targetBasenames?.get(filePath) ?? basename(filePath));
}

function isInsideVault(vaultDir: string, filePath: string): boolean {
  const relativePath = relative(resolve(vaultDir), resolve(filePath));
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

/**
 * Execute a bulk move operation with wikilink updates.
 *
 * When executing, the move holds a lineage mutation lock on every note it
 * writes: each moved note under its old and new path, and every note whose
 * links it rewrites. It takes them in one sorted acquisition, like other
 * locked writes, so it cannot deadlock with them.
 */
export async function executeBulkMove(options: {
  vaultDir: string;
  targetDir: string;
  filesToMove: string[];
  execute: boolean;
  allVaultFiles?: string[];
  /** Optional exact destination basenames, keyed by source path, for safe renames. */
  targetBasenames?: ReadonlyMap<string, string>;
  /**
   * The caller already holds the lineage locks for this move. The locks are
   * not reentrant, so the move then takes none of its own.
   */
  locksHeld?: boolean;
}): Promise<BulkMoveResult> {
  const { vaultDir, targetDir, filesToMove, execute } = options;

  if (filesToMove.length === 0) {
    return { dryRun: !execute, moveResults: [], wikilinkUpdates: [], totalLinksUpdated: 0, errors: [] };
  }

  // Resolve target directory (relative to vault)
  const absoluteTargetDir = isAbsolute(targetDir)
    ? targetDir
    : join(vaultDir, targetDir);
  const plan: MovePlan = {
    vaultDir,
    absoluteTargetDir,
    filesToMove,
    execute,
    ...(options.targetBasenames && { targetBasenames: options.targetBasenames }),
  };

  // Get all markdown files in the vault for wikilink scanning
  const allVaultFiles = options.allVaultFiles ?? await findAllMarkdownFiles(vaultDir);
  const linkingNotes = await findLinkingNotes(vaultDir, filesToMove, allVaultFiles);

  if (!execute || options.locksHeld) {
    return applyBulkMove(plan, linkingNotes, allVaultFiles);
  }

  // Lock paths, keyed by lock file so two spellings of one path count once.
  const lockPaths = new Map<string, string>();
  const addLockPath = (path: string) => lockPaths.set(getLineageMutationLockPath(vaultDir, path), path);
  for (const filePath of filesToMove) {
    addLockPath(filePath);
    const destination = destinationPath(plan, filePath);
    if (isInsideVault(vaultDir, destination)) addLockPath(destination);
  }
  for (const sourceFile of linkingNotes.keys()) addLockPath(sourceFile);

  // A note can gain a link to a moved note between the scan above and the
  // locks, so scan again under the locks. If a note outside the locks now
  // links to a moved note, release and lock again with it included.
  for (let attempt = 1; ; attempt++) {
    const outcome = await withLineageMutationLocks(vaultDir, [...lockPaths.values()], async () => {
      const lockedVaultFiles = await findAllMarkdownFiles(vaultDir);
      const lockedLinkingNotes = await findLinkingNotes(vaultDir, filesToMove, lockedVaultFiles);
      const unlocked = [...lockedLinkingNotes.keys()]
        .filter(sourceFile => !lockPaths.has(getLineageMutationLockPath(vaultDir, sourceFile)));
      if (unlocked.length > 0) return { unlocked };
      return { result: await applyBulkMove(plan, lockedLinkingNotes, lockedVaultFiles) };
    });
    if ('result' in outcome) return outcome.result;
    if (attempt === MOVE_LOCK_ATTEMPTS) {
      throw new Error('Notes kept gaining links to the moved notes while the move waited for locks; retry the move.');
    }
    for (const sourceFile of outcome.unlocked) addLockPath(sourceFile);
  }
}

/**
 * Move the files, then rewrite the links to them.
 */
async function applyBulkMove(
  plan: MovePlan,
  linkingNotes: Map<string, string[]>,
  allVaultFiles: string[]
): Promise<BulkMoveResult> {
  const { vaultDir, absoluteTargetDir, filesToMove, execute } = plan;

  const result: BulkMoveResult = {
    dryRun: !execute,
    moveResults: [],
    wikilinkUpdates: [],
    totalLinksUpdated: 0,
    errors: [],
  };

  // Move the files first so wikilink rewriting only happens for files that
  // were ACTUALLY relocated. A move skipped due to a destination collision (or
  // any other error) must NOT rewrite the vault's links to a phantom new path —
  // the note is still at its original location.
  //
  // In a dry run (`execute === false`) no move is applied, so treat every file
  // as "moved" to preserve the existing preview behaviour (link-update counts).
  const movedFiles = new Set<string>();
  for (const filePath of filesToMove) {
    const moveResult = await moveFile(
      filePath,
      absoluteTargetDir,
      vaultDir,
      execute,
      plan.targetBasenames?.get(filePath)
    );
    result.moveResults.push(moveResult);

    if (moveResult.error) {
      result.errors.push(`Failed to move ${moveResult.oldRelativePath}: ${moveResult.error}`);
    } else if (!execute || moveResult.applied) {
      movedFiles.add(filePath);
    }
  }

  // Calculate what the new file paths will be (for generating correct links).
  // Only files that actually moved get a relocated path; a skipped file keeps
  // its original path so links to it stay valid.
  const newFilePaths = allVaultFiles.map(f => movedFiles.has(f) ? destinationPath(plan, f) : f);

  // Update wikilinks in other files
  for (const [sourceFile, linkedFiles] of linkingNotes) {
    // Skip references to files that were not actually moved (e.g. a
    // collision-skipped move) — rewriting them would corrupt links.
    const linkedMovedFiles = linkedFiles.filter(file => movedFiles.has(file));
    if (linkedMovedFiles.length === 0) continue;

    // A note that links to another moved note may have moved too; its links
    // are rewritten where it now lives.
    const filePath = execute && movedFiles.has(sourceFile) ? destinationPath(plan, sourceFile) : sourceFile;
    const relativePath = relative(vaultDir, filePath);

    const updateResult: WikilinkUpdateResult = {
      filePath,
      relativePath,
      linksUpdated: 0,
      applied: false,
    };

    try {
      const content = await readFile(filePath, 'utf-8');

      // Find the links again in the text about to be rewritten, so a change
      // since the scan cannot shift a replacement onto the wrong text.
      const replacements = linkedMovedFiles.flatMap(movedFile =>
        scanWikilinkReferencesInContent(content, sourceFile, relativePath, movedFile, vaultDir)
          .map(ref => ({ ref, newPath: destinationPath(plan, movedFile) }))
      );

      // Sort by position descending
      replacements.sort((a, b) => b.ref.position - a.ref.position);

      let newContent = content;
      let totalUpdated = 0;
      for (const { ref, newPath } of replacements) {
        const newLink = generateUpdatedWikilink(
          ref.match,
          ref.linkTarget,
          newPath,
          vaultDir,
          newFilePaths
        );

        if (newLink !== ref.match) {
          newContent =
            newContent.slice(0, ref.position) +
            newLink +
            newContent.slice(ref.position + ref.match.length);
          totalUpdated++;
        }
      }

      updateResult.linksUpdated = totalUpdated;

      if (execute && totalUpdated > 0) {
        await writeFile(filePath, newContent, 'utf-8');
        updateResult.applied = true;
      }
    } catch (err) {
      updateResult.error = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to update wikilinks in ${relativePath}: ${updateResult.error}`);
    }

    if (updateResult.linksUpdated > 0 || updateResult.error) {
      result.wikilinkUpdates.push(updateResult);
      result.totalLinksUpdated += updateResult.linksUpdated;
    }
  }

  return result;
}

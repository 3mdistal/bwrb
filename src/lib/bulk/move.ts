/**
 * Move operation with wikilink auto-update.
 * 
 * This module handles:
 * - Moving files to a new directory
 * - Scanning the vault for wikilinks to moved files
 * - Updating wikilinks to point to new locations
 */

import { readFile, writeFile, rename, mkdir, readdir } from 'fs/promises';
import { join, relative, basename, extname } from 'path';

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
export interface MoveResult {
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
        // Skip hidden directories and .pika
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
 * Move a file to a new directory.
 */
export async function moveFile(
  filePath: string,
  targetDir: string,
  vaultDir: string,
  execute: boolean
): Promise<MoveResult> {
  const fileName = basename(filePath);
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
  
  try {
    // Ensure target directory exists
    await mkdir(targetDir, { recursive: true });
    
    // Move the file
    await rename(filePath, newPath);
    result.applied = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  
  return result;
}

/**
 * Execute a bulk move operation with wikilink updates.
 */
export async function executeBulkMove(options: {
  vaultDir: string;
  targetDir: string;
  filesToMove: string[];
  execute: boolean;
  allVaultFiles?: string[];
}): Promise<BulkMoveResult> {
  const { vaultDir, targetDir, filesToMove, execute } = options;
  
  const result: BulkMoveResult = {
    dryRun: !execute,
    moveResults: [],
    wikilinkUpdates: [],
    totalLinksUpdated: 0,
    errors: [],
  };
  
  if (filesToMove.length === 0) {
    return result;
  }
  
  // Get all markdown files in the vault for wikilink scanning
  const allVaultFiles = options.allVaultFiles ?? await findAllMarkdownFiles(vaultDir);
  
  // Resolve target directory (relative to vault)
  const absoluteTargetDir = targetDir.startsWith('/') 
    ? targetDir 
    : join(vaultDir, targetDir);
  
  // First, collect all wikilink references for all files to move
  const allReferences: Map<string, WikilinkReference[]> = new Map();
  const referencesBySourceFile: Map<string, { refs: WikilinkReference[]; movedFile: string; newPath: string }[]> = new Map();
  
  for (const filePath of filesToMove) {
    const refs = await findWikilinksToFile(vaultDir, filePath, allVaultFiles);
    allReferences.set(filePath, refs);
    
    // Calculate new path
    const newPath = join(absoluteTargetDir, basename(filePath));
    
    // Group by source file
    for (const ref of refs) {
      if (!referencesBySourceFile.has(ref.sourceFile)) {
        referencesBySourceFile.set(ref.sourceFile, []);
      }
      referencesBySourceFile.get(ref.sourceFile)!.push({
        refs: [ref],
        movedFile: filePath,
        newPath,
      });
    }
  }
  
  // Calculate what the new file paths will be (for generating correct links)
  const newFilePaths = allVaultFiles.map(f => {
    if (filesToMove.includes(f)) {
      return join(absoluteTargetDir, basename(f));
    }
    return f;
  });
  
  // Move the files
  for (const filePath of filesToMove) {
    const moveResult = await moveFile(filePath, absoluteTargetDir, vaultDir, execute);
    result.moveResults.push(moveResult);
    
    if (moveResult.error) {
      result.errors.push(`Failed to move ${moveResult.oldRelativePath}: ${moveResult.error}`);
    }
  }
  
  // Update wikilinks in other files
  for (const [sourceFile, refGroups] of referencesBySourceFile) {
    const sourceRelativePath = relative(vaultDir, sourceFile);
    
    // Combine all references for this source file
    const allRefs: WikilinkReference[] = [];
    const refToNewPath: Map<WikilinkReference, string> = new Map();
    
    for (const group of refGroups) {
      for (const ref of group.refs) {
        allRefs.push(ref);
        refToNewPath.set(ref, group.newPath);
      }
    }
    
    if (allRefs.length === 0) continue;
    
    const updateResult: WikilinkUpdateResult = {
      filePath: sourceFile,
      relativePath: sourceRelativePath,
      linksUpdated: 0,
      applied: false,
    };
    
    try {
      const content = await readFile(sourceFile, 'utf-8');
      
      // Update each reference
      let newContent = content;
      let totalUpdated = 0;
      
      // Sort by position descending
      const sortedRefs = [...allRefs].sort((a, b) => b.position - a.position);
      
      for (const ref of sortedRefs) {
        const newPath = refToNewPath.get(ref)!;
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
        await writeFile(sourceFile, newContent, 'utf-8');
        updateResult.applied = true;
      }
    } catch (err) {
      updateResult.error = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to update wikilinks in ${sourceRelativePath}: ${updateResult.error}`);
    }
    
    if (updateResult.linksUpdated > 0 || updateResult.error) {
      result.wikilinkUpdates.push(updateResult);
      result.totalLinksUpdated += updateResult.linksUpdated;
    }
  }
  
  return result;
}

/**
 * Bulk execution orchestration.
 */

import { parseNote, writeNote } from '../frontmatter.js';
import { resolveTypeFromFrontmatter } from '../schema.js';
import { prepareRecurrenceFastPath, commitRecurrenceFastPath } from '../recurrence-fast-path.js';
import { discoverManagedFiles, dedupeByCanonicalPath } from '../discovery.js';
import { searchContent } from '../content-search.js';
import { filterByPath } from '../targeting.js';
import { applyWhereExpressions } from '../where-targeting.js';
import { applyOperations } from './operations.js';
import { createBackup } from './backup.js';
import { executeBulkMove, findAllMarkdownFiles } from './move.js';
import type {
  BulkOptions,
  BulkResult,
  FileChange,
  BulkOperation,
} from './types.js';

/**
 * Check if operations include a move operation.
 */
function hasMoveOperation(operations: BulkOperation[]): BulkOperation | undefined {
  return operations.find(op => op.type === 'move');
}

/**
 * Execute bulk operations on matching files.
 */
export async function executeBulk(options: BulkOptions): Promise<BulkResult> {
  const {
    typePath,
    pathGlob,
    textQuery,
    operations,
    whereExpressions,
    execute,
    backup,
    limit,
    vaultDir,
    schema,
  } = options;

  const result: BulkResult = {
    dryRun: !execute,
    candidateFiles: 0,
    matchedFiles: 0,
    totalFiles: 0,
    affectedFiles: 0,
    changes: [],
    errors: [],
  };

  // Check for move operation - handle separately
  const moveOp = hasMoveOperation(operations);
  if (moveOp) {
    return executeBulkWithMove(options, moveOp);
  }

  // Discover files for the specified type
  let files = await discoverManagedFiles(schema, vaultDir, typePath);

  // Apply path glob filter (uses unified targeting module for consistent behavior)
  if (pathGlob) {
    files = filterByPath(files, pathGlob);
  }

  // Apply text content filter
  let textMatchingPaths: Set<string> | undefined;
  if (textQuery) {
    const searchResult = await searchContent({
      pattern: textQuery,
      vaultDir,
      schema,
      ...(typePath && { typePath }),
      contextLines: 0,
      caseSensitive: false,
      regex: false,
      limit: 10000,
    });
    if (searchResult.success) {
      textMatchingPaths = new Set(searchResult.results.map(r => r.file.path));
    } else {
      // Content search failed (e.g. ripgrep not installed) — filter to empty set
      // rather than silently skipping the --body filter
      textMatchingPaths = new Set<string>();
    }
  }

  if (textMatchingPaths) {
    files = files.filter(file => textMatchingPaths!.has(file.path));
  }

  // Collapse entries that resolve to the SAME canonical path under different
  // path casings (case-insensitive filesystems) so each note is processed/
  // reported exactly once. Keyed on realpath, not inode, so case-variant aliases
  // of one directory entry collapse while genuinely distinct files — and
  // distinct hardlinked paths — are kept apart.
  files = await dedupeByCanonicalPath(files);

  result.candidateFiles = files.length;
  result.totalFiles = files.length;

  const parsedFiles: {
    path: string;
    relativePath: string;
    frontmatter: Record<string, unknown>;
    body: string;
  }[] = [];

  for (const file of files) {
    try {
      const { frontmatter, body } = await parseNote(file.path);
      parsedFiles.push({
        path: file.path,
        relativePath: file.relativePath,
        frontmatter,
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${file.relativePath}: ${message}`);
    }
  }

  let filteredFiles = parsedFiles;
  if (whereExpressions.length > 0) {
    const whereResult = await applyWhereExpressions(filteredFiles, {
      schema,
      ...(typePath ? { typePath } : {}),
      whereExpressions,
      vaultDir,
    });
    if (!whereResult.ok) {
      throw new Error(whereResult.error);
    }
    filteredFiles = whereResult.files;
  }
  result.matchedFiles = filteredFiles.length;
  result.totalFiles = filteredFiles.length;

  // Filter and collect changes
  const filesToModify: typeof parsedFiles = [];

  for (const file of filteredFiles) {
    try {
      // Calculate what would change - this may throw for conflicts like rename-to-existing
      // Such errors should abort the entire operation (fail fast)
      const { changes } = applyOperations({ ...file.frontmatter }, operations);
      if (changes.length === 0) continue;

      filesToModify.push(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Check if this is an operation error (like rename conflict) - these abort
      if (message.includes('Cannot rename') || message.includes('target field already exists')) {
        throw new Error(`${file.relativePath}: ${message}`);
      }
      result.errors.push(`Failed to modify ${file.relativePath}: ${message}`);
    }
  }

  // Apply limit
  const filesToProcess = limit ? filesToModify.slice(0, limit) : filesToModify;

  // Create backup if requested and executing
  if (execute && backup && filesToProcess.length > 0) {
    const operationDesc = describeOperations(operations);
    result.backupPath = await createBackup(
      vaultDir,
      filesToProcess.map(f => f.path),
      operationDesc
    );
  }

  // Process each file
  for (const file of filesToProcess) {
    const fileChange: FileChange = {
      filePath: file.path,
      relativePath: file.relativePath,
      changes: [],
      applied: false,
    };

    try {
      const { modified, changes } = applyOperations({ ...file.frontmatter }, operations);
      fileChange.changes = changes;

      if (execute && changes.length > 0) {
        // Recurrence fast path (atomicity, #107): VALIDATE + COMPUTE the
        // successor BEFORE writing the predecessor's change, so a spawn that
        // cannot succeed (missing template, partial/unparseable offset base)
        // leaves the predecessor UNMUTATED. A spawn failure is recorded per file
        // and the predecessor's bulk change is skipped (not half-applied).
        const resolvedType = resolveTypeFromFrontmatter(schema, modified);
        let recError: string | null = null;
        let fastPathPlan = null;
        if (resolvedType) {
          try {
            fastPathPlan = await prepareRecurrenceFastPath(
              schema,
              vaultDir,
              resolvedType,
              file.path,
              file.frontmatter,
              modified,
              file.body
            );
          } catch (recErr) {
            recError = recErr instanceof Error ? recErr.message : String(recErr);
          }
        }

        if (recError) {
          // Do NOT mutate the predecessor when its successor can't be produced.
          fileChange.error = recError;
          result.errors.push(`Recurrence spawn failed for ${file.relativePath}: ${recError}`);
        } else {
          await writeNote(file.path, modified, file.body);
          fileChange.applied = true;

          // Commit the prepared spawn (create successor + back-link `next`).
          if (fastPathPlan) {
            try {
              await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
            } catch (recErr) {
              const recMessage = recErr instanceof Error ? recErr.message : String(recErr);
              result.errors.push(`Recurrence spawn failed for ${file.relativePath}: ${recMessage}`);
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fileChange.error = message;
      result.errors.push(`Failed to modify ${file.relativePath}: ${message}`);
    }

    result.changes.push(fileChange);
  }

  result.affectedFiles = result.changes.filter(c => c.changes.length > 0).length;

  return result;
}

/**
 * Execute bulk move operation with wikilink updates.
 */
async function executeBulkWithMove(
  options: BulkOptions,
  moveOp: BulkOperation
): Promise<BulkResult> {
  const {
    typePath,
    pathGlob,
    textQuery,
    whereExpressions,
    execute,
    backup,
    limit,
    vaultDir,
    schema,
  } = options;

  const targetPath = moveOp.targetPath;
  if (!targetPath) {
    throw new Error('Move operation requires a target path');
  }

  const result: BulkResult = {
    dryRun: !execute,
    candidateFiles: 0,
    matchedFiles: 0,
    totalFiles: 0,
    affectedFiles: 0,
    changes: [],
    errors: [],
    moveResults: [],
    wikilinkUpdates: [],
    totalLinksUpdated: 0,
  };

  // Discover files for the specified type
  let files = await discoverManagedFiles(schema, vaultDir, typePath);

  // Apply path glob filter (uses unified targeting module for consistent behavior)
  if (pathGlob) {
    files = filterByPath(files, pathGlob);
  }

  // Apply text content filter
  let textMatchingPaths: Set<string> | undefined;
  if (textQuery) {
    const searchResult = await searchContent({
      pattern: textQuery,
      vaultDir,
      schema,
      ...(typePath && { typePath }),
      contextLines: 0,
      caseSensitive: false,
      regex: false,
      limit: 10000,
    });
    if (searchResult.success) {
      textMatchingPaths = new Set(searchResult.results.map(r => r.file.path));
    } else {
      // Content search failed (e.g. ripgrep not installed) — filter to empty set
      // rather than silently skipping the --body filter
      textMatchingPaths = new Set<string>();
    }
  }

  if (textMatchingPaths) {
    files = files.filter(file => textMatchingPaths!.has(file.path));
  }

  // Collapse entries that resolve to the SAME canonical path under different path
  // casings (case-insensitive filesystems) so each note is moved/reported exactly
  // once. Keyed on realpath, not inode: a `move` is path-based (`rename` relocates
  // one directory entry), so distinct hardlinked paths must be kept apart and each
  // relocated — only case-variant aliases of one directory entry collapse.
  files = await dedupeByCanonicalPath(files);

  result.candidateFiles = files.length;
  result.totalFiles = files.length;

  const parsedFiles: {
    path: string;
    relativePath: string;
    frontmatter: Record<string, unknown>;
  }[] = [];

  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file.path);
      parsedFiles.push({
        path: file.path,
        relativePath: file.relativePath,
        frontmatter,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${file.relativePath}: ${message}`);
    }
  }

  let filteredFiles = parsedFiles;
  if (whereExpressions.length > 0) {
    const whereResult = await applyWhereExpressions(filteredFiles, {
      schema,
      ...(typePath ? { typePath } : {}),
      whereExpressions,
      vaultDir,
    });
    if (!whereResult.ok) {
      throw new Error(whereResult.error);
    }
    filteredFiles = whereResult.files;
  }
  result.matchedFiles = filteredFiles.length;
  result.totalFiles = filteredFiles.length;

  const filesToMove = filteredFiles.map(file => file.path);

  // Apply limit
  const filesToProcess = limit ? filesToMove.slice(0, limit) : filesToMove;

  if (filesToProcess.length === 0) {
    return result;
  }

  // Get all vault files for wikilink scanning
  const allVaultFiles = await findAllMarkdownFiles(vaultDir);

  // Create backup if requested and executing
  if (execute && backup) {
    // For move operations, we need to backup both the files being moved
    // and the files that will have wikilinks updated
    // For simplicity, just backup files being moved
    result.backupPath = await createBackup(
      vaultDir,
      filesToProcess,
      `bulk move to ${targetPath}`
    );
  }

  // Execute the move
  const moveResult = await executeBulkMove({
    vaultDir,
    targetDir: targetPath,
    filesToMove: filesToProcess,
    execute,
    allVaultFiles,
  });

  // Transfer results
  result.moveResults = moveResult.moveResults;
  result.wikilinkUpdates = moveResult.wikilinkUpdates;
  result.totalLinksUpdated = moveResult.totalLinksUpdated;
  result.errors.push(...moveResult.errors);
  result.affectedFiles = moveResult.moveResults.filter(r => !r.error).length;

  return result;
}

/**
 * Generate a description of the operations for backup manifest.
 */
function describeOperations(operations: BulkOperation[]): string {
  const parts: string[] = [];

  for (const op of operations) {
    switch (op.type) {
      case 'set':
        parts.push(`set ${op.field}=${String(op.value)}`);
        break;
      case 'clear':
        parts.push(`clear ${op.field}`);
        break;
      case 'rename':
        parts.push(`rename ${op.field}=${op.newField}`);
        break;
      case 'delete':
        parts.push(`delete ${op.field}`);
        break;
      case 'append':
        parts.push(`append ${op.field}=${String(op.value)}`);
        break;
      case 'remove':
        parts.push(`remove ${op.field}=${String(op.value)}`);
        break;
    }
  }

  return `bulk ${parts.join(', ')}`;
}

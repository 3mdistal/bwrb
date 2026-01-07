/**
 * Bulk execution orchestration.
 */

import { relative, dirname, basename } from 'path';
import { stat } from 'fs/promises';
import { parseNote, writeNote } from '../frontmatter.js';
import { matchesExpression, type EvalContext } from '../expression.js';
import { matchesAllFilters } from '../query.js';
import { discoverManagedFiles } from '../discovery.js';
import { searchContent } from '../content-search.js';
import { filterByPath } from '../targeting.js';
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
    simpleFilters,
    execute,
    backup,
    limit,
    vaultDir,
    schema,
  } = options;

  const result: BulkResult = {
    dryRun: !execute,
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
    }
  }

  if (textMatchingPaths) {
    files = files.filter(file => textMatchingPaths!.has(file.path));
  }

  result.totalFiles = files.length;

  // Filter and collect changes
  const filesToModify: {
    path: string;
    relativePath: string;
    frontmatter: Record<string, unknown>;
    body: string;
  }[] = [];

  for (const file of files) {
    try {
      const { frontmatter, body } = await parseNote(file.path);

      // Apply simple filters (--field=value syntax)
      if (simpleFilters.length > 0) {
        if (!matchesAllFilters(frontmatter, simpleFilters)) {
          continue;
        }
      }

      // Apply where expression filters
      if (whereExpressions.length > 0) {
        const context = await buildEvalContext(file.path, vaultDir, frontmatter);
        const allMatch = whereExpressions.every(expr => {
          try {
            return matchesExpression(expr, context);
          } catch {
            return false;
          }
        });
        if (!allMatch) continue;
      }

      // Calculate what would change - this may throw for conflicts like rename-to-existing
      // Such errors should abort the entire operation (fail fast)
      const { changes } = applyOperations({ ...frontmatter }, operations);
      if (changes.length === 0) continue;

      filesToModify.push({
        path: file.path,
        relativePath: file.relativePath,
        frontmatter,
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Check if this is an operation error (like rename conflict) - these abort
      if (message.includes('Cannot rename') || message.includes('target field already exists')) {
        throw new Error(`${file.relativePath}: ${message}`);
      }
      // Parse errors just get logged
      result.errors.push(`Failed to parse ${file.relativePath}: ${message}`);
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
        await writeNote(file.path, modified, file.body);
        fileChange.applied = true;
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
    simpleFilters,
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
    }
  }

  if (textMatchingPaths) {
    files = files.filter(file => textMatchingPaths!.has(file.path));
  }

  result.totalFiles = files.length;

  // Filter files based on criteria
  const filesToMove: string[] = [];

  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file.path);

      // Apply simple filters (--field=value syntax)
      if (simpleFilters.length > 0) {
        if (!matchesAllFilters(frontmatter, simpleFilters)) {
          continue;
        }
      }

      // Apply where expression filters
      if (whereExpressions.length > 0) {
        const context = await buildEvalContext(file.path, vaultDir, frontmatter);
        const allMatch = whereExpressions.every(expr => {
          try {
            return matchesExpression(expr, context);
          } catch {
            return false;
          }
        });
        if (!allMatch) continue;
      }

      filesToMove.push(file.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${file.relativePath}: ${message}`);
    }
  }

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
 * Build evaluation context for expression filtering.
 */
async function buildEvalContext(
  filePath: string,
  vaultDir: string,
  frontmatter: Record<string, unknown>
): Promise<EvalContext> {
  const relativePath = relative(vaultDir, filePath);
  const fileName = basename(filePath, '.md');
  const folder = dirname(relativePath);

  let fileInfo: EvalContext['file'] = {
    name: fileName,
    path: relativePath,
    folder,
    ext: '.md',
  };

  // Try to get file stats
  try {
    const stats = await stat(filePath);
    fileInfo = {
      ...fileInfo,
      size: stats.size,
      ctime: stats.birthtime,
      mtime: stats.mtime,
    };
  } catch {
    // Ignore stat errors
  }

  return {
    frontmatter,
    file: fileInfo,
  };
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

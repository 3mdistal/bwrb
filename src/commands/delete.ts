/**
 * Delete command - delete notes from the vault.
 *
 * Supports two modes:
 * 1. Single-file mode: Delete a specific note by query or picker
 * 2. Bulk mode: Delete multiple notes matching targeting selectors
 *
 * Bulk mode uses the two-gate safety model:
 * - Gate 1: Explicit targeting (--type, --path, --where, --text) or --all
 * - Gate 2: --execute flag to actually perform deletion (dry-run by default)
 */

import { Command } from 'commander';
import { basename } from 'path';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { resolveVaultDir, isFile } from '../lib/vault.js';
import { getGlobalOpts } from '../lib/command.js';
import { loadSchema } from '../lib/schema.js';
import {
  promptConfirm,
  printError,
  printSuccess,
  printWarning,
  printInfo,
} from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import { buildNoteIndex } from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';
import { UserCancelledError } from '../lib/errors.js';
import {
  resolveTargets,
  hasAnyTargeting,
  type TargetingOptions,
} from '../lib/targeting.js';

// ============================================================================
// Types
// ============================================================================

interface DeleteOptions {
  force?: boolean;
  picker?: string;
  output?: string;
  // Unified targeting selectors
  type?: string;
  path?: string;
  where?: string[];
  id?: string;
  body?: string;
  text?: string; // deprecated
  all?: boolean;
  execute?: boolean;
}

// ============================================================================
// Backlink Search
// ============================================================================

/**
 * Find files that contain wikilinks to the given note.
 * Uses ripgrep to search for [[NoteName]] patterns.
 * 
 * @param vaultDir - Path to vault directory
 * @param relativePath - Relative path of the note being deleted
 * @returns Array of relative paths that link to this note
 */
async function findBacklinks(vaultDir: string, relativePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    // Extract the note name (without path and extension) for wikilink matching
    const noteName = basename(relativePath, '.md');
    
    // Search for wikilinks: [[NoteName]] or [[NoteName|alias]]
    // Also match full path: [[path/to/NoteName]]
    const pattern = `\\[\\[(${escapeRegex(noteName)}|${escapeRegex(relativePath.replace(/\.md$/, ''))})(\\|[^\\]]*)?\\]\\]`;
    
    const args = [
      '--files-with-matches',  // Only output filenames
      '--glob', '*.md',        // Only search markdown files
      '--regexp', pattern,     // Use regex pattern
      '--ignore-case',         // Case insensitive
    ];

    const rg = spawn('rg', args, {
      cwd: vaultDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    rg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    rg.on('close', (code) => {
      // Code 0 = matches found, 1 = no matches, 2+ = error
      if (code === 0 && stdout.trim()) {
        const files = stdout.trim().split('\n').filter(Boolean);
        // Filter out the file itself
        const backlinks = files.filter(f => f !== relativePath);
        resolve(backlinks);
      } else {
        resolve([]);
      }
    });

    rg.on('error', () => {
      // ripgrep not available, skip backlink check
      resolve([]);
    });
  });
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Command Definition
// ============================================================================

export const deleteCommand = new Command('delete')
  .description('Delete notes from the vault')
  .argument('[query]', 'Note name, basename, or path to delete (omit to browse all)')
  // Unified targeting selectors
  .option('-t, --type <type>', 'Filter by type (e.g., "task", "objective/milestone")')
  .option('-p, --path <glob>', 'Filter by path glob (e.g., "Projects/**")')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression (e.g., "status=active")')
  .option('--id <uuid>', 'Filter by stable note id')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('--text <query>', 'Filter by body content search (deprecated: use --body)', undefined)
  .option('-a, --all', 'Select all notes (required for bulk delete without other targeting)')
  .option('-x, --execute', 'Actually delete files (default is dry-run for bulk operations)')
  // Original options
  .option('-f, --force', 'Skip confirmation prompt (single-file mode)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('--output <format>', 'Output format: text (default) or json')
  .addHelpText('after', `
Modes:
  Single-file mode (default):
    bwrb delete "My Note"           Delete specific note by name
    bwrb delete                     Browse all notes with picker

  Bulk mode (with targeting selectors):
    bwrb delete --type task         Dry-run: show tasks that would be deleted
    bwrb delete --type task -x      Actually delete all tasks
    bwrb delete --where "status=archived" --execute
    bwrb delete --body "DELETE ME" --execute
    bwrb delete --all --execute     Delete ALL notes (dangerous!)

Safety:
  Bulk delete requires TWO gates:
  1. Explicit targeting (--type, --path, --where, --body) or --all
  2. --execute flag to actually perform deletion

Picker Modes:
  auto        Use fzf if available, else numbered select (default)
  fzf         Force fzf (error if unavailable)
  numbered    Force numbered select
  none        Error on ambiguity (for non-interactive use)

Examples:
  bwrb delete "My Note"                   # Single file delete with confirmation
  bwrb delete "My Note" --force           # Skip confirmation
  bwrb delete --type task                 # Dry-run: preview deletions
  bwrb delete --type task --execute       # Actually delete all tasks
  bwrb delete --path "Archive/**" -x      # Delete all notes in Archive
  bwrb delete -o json --force "My Note"   # Scripting mode (single file)

Note: Deletion is permanent. The file is removed from the filesystem.
      Use version control (git) to recover deleted notes if needed.`)
  .action(async (query: string | undefined, options: DeleteOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const pickerMode = parsePickerMode(options.picker);

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      // Handle --text deprecation
      if (options.text) {
        console.error('Warning: --text is deprecated, use --body instead');
      }

      // Check if using bulk targeting selectors
      const bodyQuery = options.body ?? options.text;
      const targetingOpts: TargetingOptions = {
        ...(options.type && { type: options.type }),
        ...(options.path && { path: options.path }),
        ...(options.where && { where: options.where }),
        ...(options.id && { id: options.id }),
        ...(bodyQuery && { body: bodyQuery }),
        ...(options.all && { all: options.all }),
      };

      const hasBulkTargeting = hasAnyTargeting(targetingOpts);

      // If query is provided without bulk targeting, use single-file mode
      // If bulk targeting is provided, use bulk mode
      if (hasBulkTargeting) {
        await handleBulkDelete(vaultDir, schema, targetingOpts, options, jsonMode);
      } else {
        await handleSingleDelete(query, vaultDir, schema, options, jsonMode, pickerMode);
      }
    } catch (err) {
      // Handle user cancellation cleanly
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exitCode = ExitCodes.VALIDATION_ERROR;
          return;
        }
        console.log('Cancelled.');
        process.exitCode = ExitCodes.VALIDATION_ERROR;
        return;
      }

      const message = err instanceof Error ? err.message : String(err);

      // Handle specific error types
      if (err instanceof Error && 'code' in err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          const notFoundError = 'File not found or already deleted';
          if (jsonMode) {
            printJson(jsonError(notFoundError, { code: ExitCodes.IO_ERROR }));
            process.exitCode = ExitCodes.IO_ERROR;
            return;
          }
          printError(notFoundError);
          process.exitCode = ExitCodes.VALIDATION_ERROR;
          return;
        }
        if (code === 'EACCES' || code === 'EPERM') {
          const permError = 'Permission denied: cannot delete file';
          if (jsonMode) {
            printJson(jsonError(permError, { code: ExitCodes.IO_ERROR }));
            process.exitCode = ExitCodes.IO_ERROR;
            return;
          }
          printError(permError);
          process.exitCode = ExitCodes.VALIDATION_ERROR;
          return;
        }
      }

      if (jsonMode) {
        printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR }));
        process.exitCode = ExitCodes.VALIDATION_ERROR;
        return;
      }
      printError(message);
      process.exitCode = ExitCodes.VALIDATION_ERROR;
      return;
    }
  });

// ============================================================================
// Single-File Delete Mode
// ============================================================================

async function handleSingleDelete(
  query: string | undefined,
  vaultDir: string,
  schema: Awaited<ReturnType<typeof loadSchema>>,
  options: DeleteOptions,
  jsonMode: boolean,
  pickerMode: PickerMode
): Promise<void> {
  // JSON mode implies non-interactive
  const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

  // JSON mode requires --force (no interactive confirmation)
  if (jsonMode && !options.force) {
    printJson(jsonError('JSON mode requires --force flag (no interactive confirmation)', {
      code: ExitCodes.VALIDATION_ERROR,
    }));
    process.exitCode = ExitCodes.VALIDATION_ERROR;
    return;
  }

  // Build note index
  const index = await buildNoteIndex(schema, vaultDir);

  // Resolve query to a file (with picker if needed)
  const result = await resolveAndPick(index, query, {
    pickerMode: effectivePickerMode,
    prompt: 'Select note to delete',
  });

  if (!result.ok) {
    if (result.cancelled) {
      process.exitCode = ExitCodes.SUCCESS;
      return;
    }

    if (jsonMode) {
      const errorDetails = result.candidates
        ? {
            errors: result.candidates.map(c => ({
              field: 'candidate',
              value: c.relativePath,
              message: 'Matching file',
            })),
          }
        : {};

      printJson(jsonError(result.error, {
        ...errorDetails,
        code: ExitCodes.VALIDATION_ERROR,
      }));
      process.exitCode = ExitCodes.VALIDATION_ERROR;
      return;
    }

    printError(result.error);
    if (result.candidates && result.candidates.length > 0) {
      console.error('\nMatching files:');
      for (const c of result.candidates) {
        console.error(`  ${c.relativePath}`);
      }
    }
    process.exitCode = ExitCodes.VALIDATION_ERROR;
    return;
  }

  const targetFile = result.file;
  const fullPath = targetFile.path;
  const relativePath = targetFile.relativePath;

  // Verify file exists
  if (!(await isFile(fullPath))) {
    const error = `File not found: ${relativePath}`;
    if (jsonMode) {
      printJson(jsonError(error, { code: ExitCodes.IO_ERROR }));
      process.exitCode = ExitCodes.IO_ERROR;
      return;
    }
    printError(error);
    process.exitCode = ExitCodes.VALIDATION_ERROR;
    return;
  }

  // Check for backlinks (warn user if other notes link to this file)
  let backlinks: string[] = [];
  if (!jsonMode) {
    backlinks = await findBacklinks(vaultDir, relativePath);
  }

  // Confirm deletion (unless --force)
  if (!options.force) {
    printInfo(`\nFile to delete: ${relativePath}`);
    
    // Show backlink warning if any
    if (backlinks.length > 0) {
      printWarning(`\nWarning: ${backlinks.length} note(s) link to this file:`);
      for (const link of backlinks.slice(0, 5)) {
        console.log(`  - ${link}`);
      }
      if (backlinks.length > 5) {
        console.log(`  ... and ${backlinks.length - 5} more`);
      }
      console.log('');
    }

    const confirmed = await promptConfirm('Delete this note?');
    if (confirmed === null) {
      throw new UserCancelledError();
    }
    if (!confirmed) {
      console.log('Cancelled.');
      process.exitCode = ExitCodes.SUCCESS;
      return;
    }
  }

  // Delete the file
  await unlink(fullPath);

  // Success output
  if (jsonMode) {
    printJson(jsonSuccess({
      message: 'Note deleted successfully',
      path: relativePath,
      data: {
        absolutePath: fullPath,
        backlinksCount: backlinks.length,
      },
    }));
  } else {
    printSuccess(`Deleted: ${relativePath}`);
    if (backlinks.length > 0) {
      printWarning(`Note: ${backlinks.length} note(s) still contain links to this file.`);
    }
  }
}

// ============================================================================
// Bulk Delete Mode
// ============================================================================

async function handleBulkDelete(
  vaultDir: string,
  schema: Awaited<ReturnType<typeof loadSchema>>,
  targetingOpts: TargetingOptions,
  options: DeleteOptions,
  jsonMode: boolean
): Promise<void> {
  const isDryRun = !options.execute;

  // Resolve targets using shared targeting module
  const result = await resolveTargets(targetingOpts, schema, vaultDir);

  if (result.error) {
    if (jsonMode) {
      const errorDetails = result.files.length
        ? {
            errors: result.files.map(f => ({
              field: 'candidate',
              value: f.relativePath,
              message: 'Matching file',
            })),
            code: ExitCodes.VALIDATION_ERROR,
          }
        : { code: ExitCodes.VALIDATION_ERROR };

      printJson(jsonError(result.error, errorDetails));
      process.exitCode = ExitCodes.VALIDATION_ERROR;
      return;
    }

    printError(result.error);
    if (result.files.length > 0) {
      printError('Matching files:');
      for (const f of result.files) {
        printError(`  ${f.relativePath}`);
      }
    }
    process.exitCode = ExitCodes.VALIDATION_ERROR;
    return;
  }

  const files = result.files;

  // Check if any files matched
  if (files.length === 0) {
    if (jsonMode) {
      printJson(jsonSuccess({
        message: 'No files matched the targeting criteria',
        data: { matchedFiles: 0, dryRun: isDryRun },
      }));
    } else {
      printInfo('No files matched the targeting criteria.');
    }
    process.exitCode = ExitCodes.SUCCESS;
    return;
  }

  // Dry-run mode: show what would be deleted
  if (isDryRun) {
    if (jsonMode) {
      printJson(jsonSuccess({
        message: `Dry run: ${files.length} file(s) would be deleted`,
        data: {
          dryRun: true,
          matchedFiles: files.length,
          files: files.map(f => ({
            path: f.relativePath,
            type: f.expectedType,
          })),
        },
      }));
    } else {
      printWarning(`Dry run: ${files.length} file(s) would be deleted:\n`);
      
      // Show files grouped by type if type filtering was used
      const byType = new Map<string, string[]>();
      for (const file of files) {
        const type = file.expectedType || 'unknown';
        if (!byType.has(type)) {
          byType.set(type, []);
        }
        byType.get(type)!.push(file.relativePath);
      }

      for (const [type, paths] of byType) {
        console.log(`  ${type}:`);
        for (const path of paths.slice(0, 10)) {
          console.log(`    - ${path}`);
        }
        if (paths.length > 10) {
          console.log(`    ... and ${paths.length - 10} more`);
        }
      }

      console.log('');
      printInfo('To actually delete these files, run with --execute (or -x)');
    }
    process.exitCode = ExitCodes.SUCCESS;
    return;
  }

  // Execute mode: actually delete files
  const deleted: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const file of files) {
    try {
      await unlink(file.path);
      deleted.push(file.relativePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: file.relativePath, error: message });
    }
  }

  // Output results
  if (jsonMode) {
    printJson(jsonSuccess({
      message: `Deleted ${deleted.length} file(s)`,
      data: {
        dryRun: false,
        deletedCount: deleted.length,
        errorCount: errors.length,
        deleted,
        errors: errors.length > 0 ? errors : undefined,
      },
    }));
  } else {
    if (deleted.length > 0) {
      printSuccess(`Deleted ${deleted.length} file(s):`);
      for (const path of deleted.slice(0, 10)) {
        console.log(`  - ${path}`);
      }
      if (deleted.length > 10) {
        console.log(`  ... and ${deleted.length - 10} more`);
      }
    }

    if (errors.length > 0) {
      console.log('');
      printError(`Failed to delete ${errors.length} file(s):`);
      for (const { path, error } of errors.slice(0, 5)) {
        console.log(`  - ${path}: ${error}`);
      }
      if (errors.length > 5) {
        console.log(`  ... and ${errors.length - 5} more errors`);
      }
    }
  }

  // Exit with error if any deletions failed
  if (errors.length > 0) {
    process.exitCode = ExitCodes.VALIDATION_ERROR;
  }
}



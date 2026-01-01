/**
 * Delete command - delete a note from the vault.
 *
 * Supports:
 * - Query resolution (basename, path, or picker selection)
 * - Interactive confirmation (skip with --force)
 * - JSON mode for scripting
 * - Backlink warning (informs user if other notes link to this file)
 */

import { Command } from 'commander';
import { basename } from 'path';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { resolveVaultDir, isFile } from '../lib/vault.js';
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
  exitWithResolutionError,
} from '../lib/output.js';
import { buildNoteIndex } from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';
import { UserCancelledError } from '../lib/errors.js';

// ============================================================================
// Types
// ============================================================================

interface DeleteOptions {
  force?: boolean;
  picker?: string;
  output?: string;
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
  .description('Delete a note from the vault')
  .argument('[query]', 'Note name, basename, or path to delete (omit to browse all)')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .addHelpText('after', `
Picker Modes:
  auto        Use fzf if available, else numbered select (default)
  fzf         Force fzf (error if unavailable)
  numbered    Force numbered select
  none        Error on ambiguity (for non-interactive use)

Examples:
  pika delete                             # Browse all notes with picker
  pika delete "My Note"                   # Delete by basename
  pika delete Ideas/My\\ Note.md          # Delete by path
  pika delete "My Note" --force           # Skip confirmation
  pika delete "My Note" -o json --force   # Scripting mode

Note: Deletion is permanent. The file is removed from the filesystem.
      Use version control (git) to recover deleted notes if needed.`)
  .action(async (query: string | undefined, options: DeleteOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const pickerMode = parsePickerMode(options.picker);

    // JSON mode implies non-interactive
    const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

    // JSON mode requires --force (no interactive confirmation)
    if (jsonMode && !options.force) {
      printJson(jsonError('JSON mode requires --force flag (no interactive confirmation)'));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Build note index
      const index = await buildNoteIndex(schema, vaultDir);

      // Resolve query to a file (with picker if needed)
      const result = await resolveAndPick(index, query, {
        pickerMode: effectivePickerMode,
        prompt: 'Select note to delete',
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const targetFile = result.file;
      const fullPath = targetFile.path;
      const relativePath = targetFile.relativePath;

      // Verify file exists
      if (!(await isFile(fullPath))) {
        const error = `File not found: ${relativePath}`;
        if (jsonMode) {
          printJson(jsonError(error, { code: ExitCodes.IO_ERROR }));
          process.exit(ExitCodes.IO_ERROR);
        }
        printError(error);
        process.exit(1);
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
          process.exit(0);
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
    } catch (err) {
      // Handle user cancellation cleanly
      if (err instanceof UserCancelledError) {
        console.log('Cancelled.');
        process.exit(1);
      }

      const message = err instanceof Error ? err.message : String(err);
      
      // Handle specific error types
      if (err instanceof Error && 'code' in err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          const notFoundError = 'File not found or already deleted';
          if (jsonMode) {
            printJson(jsonError(notFoundError, { code: ExitCodes.IO_ERROR }));
            process.exit(ExitCodes.IO_ERROR);
          }
          printError(notFoundError);
          process.exit(1);
        }
        if (code === 'EACCES' || code === 'EPERM') {
          const permError = 'Permission denied: cannot delete file';
          if (jsonMode) {
            printJson(jsonError(permError, { code: ExitCodes.IO_ERROR }));
            process.exit(ExitCodes.IO_ERROR);
          }
          printError(permError);
          process.exit(1);
        }
      }

      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// Exported Helper (for potential use by other commands)
// ============================================================================

/**
 * Delete a note file directly (used by other commands if needed).
 * Does not check for confirmation - caller is responsible for that.
 */
export async function deleteNoteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

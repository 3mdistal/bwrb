/**
 * Bulk command - mass changes across filtered file sets.
 * 
 * This command performs bulk operations on files matching filter criteria:
 * - Set or clear field values
 * - Rename fields (for migrations)
 * - Delete fields
 * - Append/remove from list fields
 * - Move files to different directories (with wikilink auto-update)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeDefByPath,
  getTypeFamilies,
  getOptionsForField,
  resolveTypeFromFrontmatter,
} from '../lib/schema.js';
import { discoverManagedFiles } from '../lib/discovery.js';
import { parseNote } from '../lib/frontmatter.js';
import { filterByPath } from '../lib/targeting.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { printError, promptConfirm } from '../lib/prompt.js';
import { UserCancelledError } from '../lib/errors.js';
import {
  printJson,
  jsonError,
  jsonSuccess,
  ExitCodes,
} from '../lib/output.js';
import { buildOperation, formatChange } from '../lib/bulk/operations.js';
import { executeBulk } from '../lib/bulk/execute.js';
import {
  parsePositionalArg,
  hasAnyTargeting,
} from '../lib/targeting.js';
import type { BulkOperation, BulkResult } from '../lib/bulk/types.js';
import type { LoadedSchema } from '../types/schema.js';

interface BulkCommandOptions {
  type?: string;
  path?: string;
  body?: string;
  text?: string; // deprecated
  all?: boolean;
  set?: string[];
  rename?: string[];
  delete?: string[];
  append?: string[];
  remove?: string[];
  move?: string;
  where?: string[];
  execute?: boolean;
  force?: boolean;
  yes?: boolean;
  backup?: boolean;
  limit?: string;
  verbose?: boolean;
  quiet?: boolean;
  output?: string;
}

/** Threshold for "large operation" confirmation prompt */
const LARGE_OPERATION_THRESHOLD = 50;

export const bulkCommand = new Command('bulk')
  .description('Mass changes across filtered file sets')
  .addHelpText('after', `
Safety (Two-Gate Model):
  Bulk operations require explicit targeting to prevent accidents.
  
  1. Targeting gate: Specify selectors (--type, --path, --where, --body) OR use --all
  2. Execution gate: Use --execute to apply changes (dry-run by default)

  # Error: no targeting specified
  bwrb bulk --set status=done
  # "No files selected. Use --type, --path, --where, --text, or --all."

  # OK: filtered with --type and --where
  bwrb bulk --type task --where "status == 'active'" --set status=done

  # OK: filtered with --path
  bwrb bulk --path "Projects/**" --set archived=true

  # OK: explicit --all targets all managed files
  bwrb bulk --all --set status=done

Selectors (compose via AND):
  -t, --type <type>           Filter by type (e.g., task, objective/milestone)
  -p, --path <glob>           Filter by file path (supports globs)
  -w, --where <expression>    Filter by frontmatter (can repeat, ANDed)
  --body <query>              Filter by body content

Operations:
  --set <field>=<value>       Set field value
  --set <field>=              Clear field (remove from frontmatter)
  --rename <old>=<new>        Rename field
  --delete <field>            Delete field
  --append <field>=<value>    Append to list field
  --remove <field>=<value>    Remove from list field
  --move <path>               Move files to path (auto-updates wikilinks)

  Execution:
    -a, --all                   Target all files (requires explicit intent)
    --execute                   Actually apply changes (dry-run by default)
    -f, --force                 Skip confirmation prompt for large/cross-type ops
    -y, --yes                   Alias for --force (skip confirmation)
    --backup                    Create backup before changes
    --limit <n>                 Limit to n files

Cross-Type Operations:
  When using --all without --type, operations affect ALL types in the vault.
  A confirmation prompt shows affected file counts by type before execution.
  Use --force to skip confirmation (required for JSON mode).

  Large operations (50+ files) also prompt for confirmation regardless of targeting.

Output:
  --verbose                   Show detailed changes per file
  --quiet                     Only show summary
  --output json               JSON output for scripting

Examples:
  # Preview changes (dry-run)
  bwrb bulk --type task --where "status == 'in-progress'" --set status=done

  # Apply changes
  bwrb bulk --type task --where "status == 'in-progress'" --set status=done --execute

  # Target by path
  bwrb bulk --path "Archive/**" --set archived=true --execute

  # Target by content
  bwrb bulk --body "TODO" --set needs-review=true --execute

  # Target all managed files
  bwrb bulk --all --set reviewed=true --execute

  # Multiple operations
  bwrb bulk --type task --where "status == 'done'" --set archived=true --set "archived-date=2025-01-15" --execute

  # Rename a field across all files
  bwrb bulk --all --rename old-field=new-field --execute

  # Append to a list field
  bwrb bulk --type task --where "priority == 'high'" --append tags=urgent --execute

  # Create backup before changes
  bwrb bulk --type task --all --set status=archived --execute --backup

  # Move files to archive (updates wikilinks automatically)
  bwrb bulk --type idea --where "status == 'settled'" --move Archive/Ideas --execute`)
  .argument('[target]', 'Type, path, or where expression (auto-detected)')
  .option('-t, --type <type>', 'Filter by type (e.g., task, objective/milestone)')
  .option('-p, --path <glob>', 'Filter by file path (supports globs)')
  .option('-b, --body <query>', 'Filter by body content')
  .option('--text <query>', 'Filter by body content (deprecated: use --body)', undefined)
  .option('--set <field=value...>', 'Set field value (or clear with --set field=)')
  .option('--rename <old=new...>', 'Rename field')
  .option('--delete <field...>', 'Delete field')
  .option('--append <field=value...>', 'Append to list field')
  .option('--remove <field=value...>', 'Remove from list field')
  .option('--move <path>', 'Move files to path (auto-updates wikilinks)')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('-a, --all', 'Target all files (requires explicit intent)')
  .option('-x, --execute', 'Actually apply changes (dry-run by default)')
  .option('-f, --force', 'Skip confirmation prompt for large/cross-type operations')
  .option('-y, --yes', 'Alias for --force (skip confirmation prompt)')
  .option('--backup', 'Create backup before changes')
  .option('--limit <n>', 'Limit to n files')
  .option('--verbose', 'Show detailed changes per file')
  .option('--quiet', 'Only show summary')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (target: string | undefined, options: BulkCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      // Handle --text deprecation
      if (options.text) {
        console.error('Warning: --text is deprecated, use --body instead');
      }

      // Build targeting options from flags
      let typePath = options.type;
      let pathGlob = options.path;
      let whereExpressions = options.where ?? [];
      const bodyQuery = options.body ?? options.text;

      // Handle positional argument
      if (target) {
        const parsed = parsePositionalArg(target, schema, {});
        if (parsed.error) {
          if (jsonMode) {
            printJson(jsonError(parsed.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(parsed.error);
          process.exit(1);
        }

        // Apply the detected value
        if (parsed.options.type && !typePath) {
          typePath = parsed.options.type;
        } else if (parsed.options.path && !pathGlob) {
          pathGlob = parsed.options.path;
        } else         if (parsed.options.where) {
          whereExpressions = [...parsed.options.where, ...whereExpressions];
        }
      }

      // Validate type exists if specified
      if (typePath) {
        const typeDef = getTypeDefByPath(schema, typePath);
        if (!typeDef) {
          const error = `Unknown type: ${typePath}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          showAvailableTypes(schema);
          process.exit(1);
        }
      }

      // Targeting gate: require explicit selector(s) OR --all for destructive operations
      const hasTargeting = hasAnyTargeting({
        ...(typePath && { type: typePath }),
        ...(pathGlob && { path: pathGlob }),
        ...(whereExpressions.length > 0 && { where: whereExpressions }),
        ...(bodyQuery && { body: bodyQuery }),
        ...(options.all && { all: options.all }),
      });

      if (!hasTargeting) {
        const error = 'No files selected. Use --type, --path, --where, --text, or --all.';
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        console.log(`
Hint: Bulk operations require explicit targeting to prevent accidents.

  Filter with selectors:
    bwrb bulk --type task --where "status == 'x'" --set field=value
    bwrb bulk --path "Projects/**" --set field=value

  Or use --all to target all managed files:
    bwrb bulk --all --set field=value
`);
        process.exit(1);
      }

      // Build operations list
      const operations: BulkOperation[] = [];
      const validationErrors: string[] = [];

      // Parse --set options
      for (const arg of options.set ?? []) {
        try {
          const op = buildOperation('set', arg);
          // Validate enum values for 'set' operations (only if type is specified)
          if (op.type === 'set' && op.value !== undefined && typePath) {
            const enumError = validateEnumValue(schema, typePath, op.field, op.value);
            if (enumError) {
              validationErrors.push(enumError);
            }
          }
          operations.push(op);
        } catch (err) {
          validationErrors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Parse --rename options
      for (const arg of options.rename ?? []) {
        try {
          operations.push(buildOperation('rename', arg));
        } catch (err) {
          validationErrors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Parse --delete options
      for (const arg of options.delete ?? []) {
        try {
          operations.push(buildOperation('delete', arg));
        } catch (err) {
          validationErrors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Parse --append options
      for (const arg of options.append ?? []) {
        try {
          const op = buildOperation('append', arg);
          // Validate enum values for 'append' operations (only if type is specified)
          if (op.value !== undefined && typePath) {
            const enumError = validateEnumValue(schema, typePath, op.field, op.value);
            if (enumError) {
              validationErrors.push(enumError);
            }
          }
          operations.push(op);
        } catch (err) {
          validationErrors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Parse --remove options
      for (const arg of options.remove ?? []) {
        try {
          operations.push(buildOperation('remove', arg));
        } catch (err) {
          validationErrors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Parse --move option
      if (options.move) {
        operations.push({
          type: 'move',
          field: '', // Not used for move
          targetPath: options.move,
        });
      }

      // Note: We intentionally do NOT validate field names for mutation operations
      // (--set, --delete, --append, --remove). Users may want to set arbitrary
      // custom fields not defined in the schema. Field validation is enforced
      // for --where expressions (filtering) where typos cause silent bugs.

      // Check for validation errors
      if (validationErrors.length > 0) {
        if (jsonMode) {
          printJson(jsonError('Validation failed', { 
            errors: validationErrors.map(e => ({ field: '', message: e }))
          }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        for (const err of validationErrors) {
          printError(err);
        }
        process.exit(1);
      }

      // Check that at least one operation was specified
      if (operations.length === 0) {
        const error = 'No operations specified. Use --set, --rename, --delete, --append, --remove, or --move.';
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Move operation cannot be combined with other operations
      const hasMoveOp = operations.some(op => op.type === 'move');
      if (hasMoveOp && operations.length > 1) {
        const error = '--move cannot be combined with other operations';
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Execute bulk operation
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;
      if (options.limit && (isNaN(limit!) || limit! <= 0)) {
        const error = 'Invalid --limit value: must be a positive integer';
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Confirmation prompt for cross-type operations and large operations
      // Only prompt when --execute is used (dry-run doesn't need confirmation)
      const isCrossTypeOperation = !!(options.all && !typePath);
      const skipConfirmation = options.force || options.yes;
      
      if (options.execute && !skipConfirmation) {
        // Pre-flight discovery to count files and detect if confirmation needed
        const preflightResult = await preflightDiscovery({
          typePath,
          pathGlob,
          vaultDir,
          schema,
          limit,
        });

        const needsConfirmation = isCrossTypeOperation || 
          preflightResult.totalFiles >= LARGE_OPERATION_THRESHOLD;

        if (needsConfirmation) {
          // JSON mode requires --force for operations that need confirmation
          if (jsonMode) {
            const reason = isCrossTypeOperation 
              ? 'Cross-type operations' 
              : `Large operations (${preflightResult.totalFiles} files)`;
            printJson(jsonError(`${reason} require --force or --yes flag in JSON mode`));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }

          // Build confirmation message with type breakdown
          const confirmMessage = buildConfirmationMessage(preflightResult, isCrossTypeOperation);
          const confirmed = await promptConfirm(confirmMessage);
          
          if (confirmed === null) {
            throw new UserCancelledError();
          }
          if (!confirmed) {
            console.log('Operation cancelled.');
            process.exit(0);
          }
        }
      }

      const result = await executeBulk({
        ...(typePath !== undefined && { typePath }),
        ...(pathGlob !== undefined && { pathGlob }),
        ...(bodyQuery !== undefined && { textQuery: bodyQuery }),
        operations,
        whereExpressions,
        execute: options.execute ?? false,
        backup: options.backup ?? false,
        ...(limit !== undefined && { limit }),
        verbose: options.verbose ?? false,
        quiet: options.quiet ?? false,
        jsonMode,
        vaultDir,
        schema,
        all: options.all ?? false,
      });

      // Output results
      if (jsonMode) {
        outputJsonResult(result);
      } else {
        outputTextResult(result, options.verbose ?? false, options.quiet ?? false);
      }

      // Exit with error if there were failures
      if (result.errors.length > 0) {
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

/**
 * Validate that a value is valid for an enum field.
 * Returns an error message if invalid, null if valid.
 */
function validateEnumValue(
  schema: LoadedSchema,
  typePath: string,
  field: string,
  value: unknown
): string | null {
  const validOptions = getOptionsForField(schema, typePath, field);
  if (validOptions.length === 0) {
    return null; // Not a select field with options
  }

  const strValue = String(value);
  if (!validOptions.includes(strValue)) {
    return `Invalid value '${strValue}' for field '${field}'. Valid values: ${validOptions.join(', ')}`;
  }

  return null;
}

/**
 * Show available types.
 */
function showAvailableTypes(schema: LoadedSchema): void {
  console.log('\nAvailable types:');
  for (const family of getTypeFamilies(schema)) {
    console.log(`  ${family}`);
  }
}

/**
 * Output result as JSON.
 */
function outputJsonResult(result: BulkResult): void {
  // Check if this is a move operation
  const isMoveOperation = result.moveResults && result.moveResults.length > 0;

  const jsonOutput = {
    success: result.errors.length === 0,
    dryRun: result.dryRun,
    totalFiles: result.totalFiles,
    filesModified: result.affectedFiles,
    ...(result.backupPath && { backupPath: result.backupPath }),
    // For move operations
    ...(isMoveOperation && {
      moves: result.moveResults!.map(m => ({
        from: m.oldRelativePath,
        to: m.newRelativePath,
        applied: m.applied,
        ...(m.error && { error: m.error }),
      })),
      wikilinkUpdates: result.wikilinkUpdates?.map(u => ({
        file: u.relativePath,
        linksUpdated: u.linksUpdated,
        applied: u.applied,
        ...(u.error && { error: u.error }),
      })),
      totalLinksUpdated: result.totalLinksUpdated,
    }),
    // For field operations
    ...(!isMoveOperation && {
      changes: result.changes.map(fc => ({
        file: fc.relativePath,
        applied: fc.applied,
        ...(fc.error && { error: fc.error }),
        changes: fc.changes.map(c => ({
          operation: c.operation,
          field: c.field,
          from: c.oldValue,
          to: c.newValue,
          ...(c.newField && { newField: c.newField }),
        })),
      })),
    }),
    ...(result.errors.length > 0 && { errors: result.errors }),
  };

  printJson(result.errors.length === 0 
    ? jsonSuccess({ data: jsonOutput })
    : jsonError('Some operations failed', { errors: result.errors.map(e => ({ field: '', message: e })) })
  );
}

/**
 * Output result as text.
 */
function outputTextResult(result: BulkResult, verbose: boolean, quiet: boolean): void {
  // Check if this is a move operation
  const isMoveOperation = result.moveResults && result.moveResults.length > 0;

  if (isMoveOperation) {
    outputMoveTextResult(result, verbose, quiet);
    return;
  }

  // Quiet mode - just summary
  if (quiet) {
    if (result.dryRun) {
      console.log(`Would affect ${result.affectedFiles} files`);
    } else {
      console.log(chalk.green(`✓ Updated ${result.affectedFiles} files`));
    }
    return;
  }

  // Dry-run header
  if (result.dryRun) {
    console.log(chalk.yellow('Dry run - no changes will be made'));
    console.log();
  }

  // Show backup path if created
  if (result.backupPath) {
    console.log(chalk.blue(`Backup created: ${result.backupPath}`));
    console.log();
  }

  // No changes case
  if (result.affectedFiles === 0) {
    console.log('No files match the criteria.');
    return;
  }

  // Show changes
  if (result.dryRun) {
    console.log(`Would affect ${result.affectedFiles} file${result.affectedFiles === 1 ? '' : 's'}:`);
  } else if (!quiet) {
    console.log(`Applying changes to ${result.affectedFiles} file${result.affectedFiles === 1 ? '' : 's'}...`);
  }

  for (const fileChange of result.changes) {
    if (fileChange.changes.length === 0) continue;

    if (verbose || result.dryRun) {
      console.log(`  ${fileChange.relativePath}`);
      for (const change of fileChange.changes) {
        console.log(`    ${formatChange(change)}`);
      }
    } else {
      // Non-verbose execute mode
      const status = fileChange.applied 
        ? chalk.green('✓') 
        : (fileChange.error ? chalk.red('✗') : ' ');
      console.log(`  ${status} ${fileChange.relativePath}`);
      if (fileChange.error) {
        console.log(`    ${chalk.red(fileChange.error)}`);
      }
    }
  }

  // Summary
  console.log();
  if (result.dryRun) {
    console.log(`Run with ${chalk.cyan('--execute')} to apply changes.`);
  } else {
    console.log(chalk.green(`✓ Updated ${result.affectedFiles} files`));
  }

  // Show errors if any
  if (result.errors.length > 0) {
    console.log();
    console.log(chalk.red(`Errors (${result.errors.length}):`));
    for (const error of result.errors) {
      console.log(`  ${chalk.red('•')} ${error}`);
    }
  }
}

/**
 * Output move operation result as text.
 */
function outputMoveTextResult(result: BulkResult, verbose: boolean, quiet: boolean): void {
  const moveResults = result.moveResults ?? [];
  const wikilinkUpdates = result.wikilinkUpdates ?? [];
  const totalLinksUpdated = result.totalLinksUpdated ?? 0;

  // Quiet mode - just summary
  if (quiet) {
    if (result.dryRun) {
      console.log(`Would move ${moveResults.length} files`);
      if (totalLinksUpdated > 0) {
        console.log(`Would update ${totalLinksUpdated} wikilinks`);
      }
    } else {
      console.log(chalk.green(`✓ Moved ${result.affectedFiles} files`));
      if (totalLinksUpdated > 0) {
        console.log(chalk.green(`✓ Updated ${totalLinksUpdated} wikilinks`));
      }
    }
    return;
  }

  // Dry-run header
  if (result.dryRun) {
    console.log(chalk.yellow('Dry run - no changes will be made'));
    console.log();
  }

  // Show backup path if created
  if (result.backupPath) {
    console.log(chalk.blue(`Backup created: ${result.backupPath}`));
    console.log();
  }

  // No files case
  if (moveResults.length === 0) {
    console.log('No files match the criteria.');
    return;
  }

  // Show file moves
  if (result.dryRun) {
    console.log(`Would move ${moveResults.length} file${moveResults.length === 1 ? '' : 's'}:`);
  } else {
    console.log(`Moving ${moveResults.length} file${moveResults.length === 1 ? '' : 's'}...`);
  }

  for (const move of moveResults) {
    if (verbose || result.dryRun) {
      console.log(`  ${move.oldRelativePath} → ${move.newRelativePath}`);
    } else {
      const status = move.applied 
        ? chalk.green('✓') 
        : (move.error ? chalk.red('✗') : ' ');
      console.log(`  ${status} ${move.oldRelativePath} → ${move.newRelativePath}`);
      if (move.error) {
        console.log(`    ${chalk.red(move.error)}`);
      }
    }
  }

  // Show wikilink updates
  if (wikilinkUpdates.length > 0 || totalLinksUpdated > 0) {
    console.log();
    if (result.dryRun) {
      console.log(`Would update ${totalLinksUpdated} wikilink${totalLinksUpdated === 1 ? '' : 's'} across ${wikilinkUpdates.length} file${wikilinkUpdates.length === 1 ? '' : 's'}:`);
    } else {
      console.log(`Updating wikilinks...`);
    }

    if (verbose || result.dryRun) {
      for (const update of wikilinkUpdates) {
        console.log(`  ${update.relativePath}: ${update.linksUpdated} link${update.linksUpdated === 1 ? '' : 's'}`);
      }
    }
  }

  // Summary
  console.log();
  if (result.dryRun) {
    console.log(`Run with ${chalk.cyan('--execute')} to apply changes.`);
  } else {
    console.log(chalk.green(`✓ Moved ${result.affectedFiles} files`));
    if (totalLinksUpdated > 0) {
      console.log(chalk.green(`✓ Updated ${totalLinksUpdated} wikilinks`));
    }
  }

  // Show errors if any
  if (result.errors.length > 0) {
    console.log();
    console.log(chalk.red(`Errors (${result.errors.length}):`));
    for (const error of result.errors) {
      console.log(`  ${chalk.red('•')} ${error}`);
    }
  }
}

// ============================================================================
// Preflight Discovery (for confirmation prompts)
// ============================================================================

interface PreflightOptions {
  typePath: string | undefined;
  pathGlob: string | undefined;
  vaultDir: string;
  schema: LoadedSchema;
  limit: number | undefined;
}

interface PreflightResult {
  totalFiles: number;
  /** Map of type name to count of files of that type */
  filesByType: Map<string, number>;
}

/**
 * Pre-flight discovery to count files before execution.
 * Used to determine if confirmation is needed and build the confirmation message.
 * 
 * Note: This is an upper-bound estimate. We don't filter by body content or
 * where expressions in preflight because that would require parsing all files.
 * The actual execution will filter further.
 */
async function preflightDiscovery(options: PreflightOptions): Promise<PreflightResult> {
  const { typePath, pathGlob, vaultDir, schema, limit } = options;

  // Discover files (same logic as executeBulk)
  let files = await discoverManagedFiles(schema, vaultDir, typePath);

  // Apply path glob filter
  if (pathGlob) {
    files = filterByPath(files, pathGlob);
  }

  // Note: We don't filter by body content or where expressions in preflight
  // because that would require parsing all files. The preflight is an upper bound
  // estimate. The actual execution will filter further.

  // Apply limit for accuracy
  if (limit) {
    files = files.slice(0, limit);
  }

  // Count files by type
  const filesByType = new Map<string, number>();
  
  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file.path);
      const resolvedType = resolveTypeFromFrontmatter(schema, frontmatter) ?? 'unknown';
      filesByType.set(resolvedType, (filesByType.get(resolvedType) ?? 0) + 1);
    } catch {
      // If we can't parse, count as unknown
      filesByType.set('unknown', (filesByType.get('unknown') ?? 0) + 1);
    }
  }

  return {
    totalFiles: files.length,
    filesByType,
  };
}

/**
 * Build a human-readable confirmation message.
 */
function buildConfirmationMessage(
  preflight: PreflightResult,
  isCrossType: boolean
): string {
  const parts: string[] = [];

  if (isCrossType) {
    parts.push(`This will modify ${preflight.totalFiles} files across all types:`);
  } else {
    parts.push(`This will modify ${preflight.totalFiles} files:`);
  }

  // Sort types by count (descending) for readability
  const sortedTypes = Array.from(preflight.filesByType.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [typeName, count] of sortedTypes) {
    // Don't pluralize type names (they may be paths like "objective/task")
    parts.push(`  ${count} ${typeName}`);
  }

  parts.push('');
  parts.push('Are you sure?');

  return parts.join('\n');
}

// Re-export types for testing
export type { BulkOperation, BulkResult };
export { executeBulk } from '../lib/bulk/execute.js';
export { buildOperation, applyOperations, formatChange } from '../lib/bulk/operations.js';
export { createBackup } from '../lib/bulk/backup.js';

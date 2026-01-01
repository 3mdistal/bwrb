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
  getEnumForField,
  getEnumValues,
} from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { parseFilters, validateFilters } from '../lib/query.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  jsonSuccess,
  ExitCodes,
} from '../lib/output.js';
import { buildOperation, formatChange } from '../lib/bulk/operations.js';
import { executeBulk } from '../lib/bulk/execute.js';
import type { BulkOperation, BulkResult, FileChange } from '../lib/bulk/types.js';
import type { LoadedSchema } from '../types/schema.js';

interface BulkCommandOptions {
  set?: string[];
  rename?: string[];
  delete?: string[];
  append?: string[];
  remove?: string[];
  move?: string;
  where?: string[];
  execute?: boolean;
  backup?: boolean;
  limit?: string;
  verbose?: boolean;
  quiet?: boolean;
  output?: string;
}

export const bulkCommand = new Command('bulk')
  .description('Mass changes across filtered file sets')
  .addHelpText('after', `
Operations:
  --set <field>=<value>       Set field value
  --set <field>=              Clear field (remove from frontmatter)
  --rename <old>=<new>        Rename field
  --delete <field>            Delete field
  --append <field>=<value>    Append to list field
  --remove <field>=<value>    Remove from list field
  --move <path>               Move files to path (auto-updates wikilinks)

Filters:
  --field=value               Include where field equals value
  --field=a,b                 Include where field equals a OR b
  --field!=value              Exclude where field equals value
  --field=                    Include where field is empty/missing
  --field!=                   Include where field exists
  --where "<expression>"      Filter expression (can repeat, ANDed)

Execution:
  --execute                   Actually apply changes (dry-run by default)
  --backup                    Create backup before changes
  --limit <n>                 Limit to n files

Output:
  --verbose                   Show detailed changes per file
  --quiet                     Only show summary
  --output json               JSON output for scripting

Examples:
  # Preview changes (dry-run)
  pika bulk task --set status=done --where "status == 'in-progress'"

  # Apply changes
  pika bulk task --set status=done --where "status == 'in-progress'" --execute

  # Multiple operations
  pika bulk task --set status=done --set "completion-date=2025-01-15" --execute

  # Rename a field across all files
  pika bulk idea --rename old-field=new-field --execute

  # Append to a list field
  pika bulk task --append tags=urgent --where "priority == 'high'" --execute

  # Create backup before changes
  pika bulk task --set status=archived --execute --backup

  # Move files to archive (updates wikilinks automatically)
  pika bulk idea --move Archive/Ideas --where "status == 'settled'" --execute

  # Using simple filters
  pika bulk task --status=done --set archived=true --execute
  pika bulk idea --priority=high,critical --set urgent=true --execute`)
  .argument('<type>', 'Type path (e.g., idea, objective/task)')
  .option('--set <field=value...>', 'Set field value (or clear with --set field=)')
  .option('--rename <old=new...>', 'Rename field')
  .option('--delete <field...>', 'Delete field')
  .option('--append <field=value...>', 'Append to list field')
  .option('--remove <field=value...>', 'Remove from list field')
  .option('--move <path>', 'Move files to path (auto-updates wikilinks)')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('--execute', 'Actually apply changes (dry-run by default)')
  .option('--backup', 'Create backup before changes')
  .option('--limit <n>', 'Limit to n files')
  .option('--verbose', 'Show detailed changes per file')
  .option('--quiet', 'Only show summary')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .allowUnknownOption(true)
  .action(async (typePath: string, options: BulkCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type exists
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

      // Parse simple filters from remaining arguments (--field=value syntax)
      const filterArgs = cmd.args.slice(1); // Skip the type argument
      const simpleFilters = parseFilters(filterArgs);

      // Validate simple filters
      if (simpleFilters.length > 0) {
        const validation = validateFilters(schema, typePath, simpleFilters);
        if (!validation.valid) {
          if (jsonMode) {
            printJson(jsonError(validation.errors.join('; ')));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          for (const error of validation.errors) {
            printError(error);
          }
          process.exit(1);
        }
      }

      // Build operations list
      const operations: BulkOperation[] = [];
      const validationErrors: string[] = [];

      // Parse --set options
      for (const arg of options.set ?? []) {
        try {
          const op = buildOperation('set', arg);
          // Validate enum values for 'set' operations
          if (op.type === 'set' && op.value !== undefined) {
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
          // Validate enum values for 'append' operations
          if (op.value !== undefined) {
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

      const result = await executeBulk({
        typePath,
        operations,
        whereExpressions: options.where ?? [],
        simpleFilters,
        execute: options.execute ?? false,
        backup: options.backup ?? false,
        ...(limit !== undefined && { limit }),
        verbose: options.verbose ?? false,
        quiet: options.quiet ?? false,
        jsonMode,
        vaultDir,
        schema,
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
  const enumName = getEnumForField(schema, typePath, field);
  if (!enumName) {
    return null; // Not an enum field
  }

  const enumValues = getEnumValues(schema, enumName);
  if (enumValues.length === 0) {
    return null; // Enum not defined
  }

  const strValue = String(value);
  if (!enumValues.includes(strValue)) {
    return `Invalid value '${strValue}' for field '${field}'. Valid values: ${enumValues.join(', ')}`;
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

// Re-export types for testing
export type { BulkOperation, BulkResult, FileChange };
export { executeBulk } from '../lib/bulk/execute.js';
export { buildOperation, applyOperations, formatChange, formatValue } from '../lib/bulk/operations.js';
export { createBackup, listBackups, restoreBackup } from '../lib/bulk/backup.js';

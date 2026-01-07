/**
 * Schema migration commands.
 * Handles: diff, migrate, history
 */

import { Command } from 'commander';
import { getGlobalOpts } from '../../lib/command.js';
import chalk from 'chalk';
import { loadSchema } from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import {
  printError,
  printSuccess,
  promptInput,
  promptConfirm,
} from '../../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../../lib/output.js';
import { loadRawSchemaJson, writeSchema } from '../../lib/schema-writer.js';
import { diffSchemas, formatDiffForDisplay, formatDiffForJson } from '../../lib/migration/diff.js';
import { loadSchemaSnapshot, saveSchemaSnapshot, hasSchemaSnapshot } from '../../lib/migration/snapshot.js';
import { loadMigrationHistory, recordMigration } from '../../lib/migration/history.js';
import { executeMigration } from '../../lib/migration/execute.js';
import type { MigrationPlan } from '../../types/migration.js';

interface DiffOptions {
  output?: string;
}

interface MigrateOptions {
  output?: string;
  execute?: boolean;
  noBackup?: boolean;
}

interface HistoryOptions {
  output?: string;
  limit?: string;
}

/**
 * Suggest a version bump based on the type of changes.
 * - Major: type removals, field removals, breaking changes
 * - Minor: type additions, field additions
 * - Patch: renames, non-breaking changes
 */
function suggestVersionBump(currentVersion: string, diff: MigrationPlan): string {
  const parts = currentVersion.split('.').map(Number);
  const major = parts[0] ?? 1;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  
  // Check for breaking changes (non-deterministic usually means breaking)
  const hasBreakingChanges = diff.nonDeterministic.some(op => 
    op.op === 'remove-field' || 
    op.op === 'remove-type'
  );
  
  if (hasBreakingChanges) {
    return `${major + 1}.0.0`;
  }
  
  // Check for additions (minor bump)
  const hasAdditions = diff.deterministic.some(op =>
    op.op === 'add-field' ||
    op.op === 'add-type'
  );
  
  if (hasAdditions) {
    return `${major}.${minor + 1}.0`;
  }
  
  // Default to patch for renames and other changes
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Register migration commands onto the schema command.
 */
export function registerMigrationCommands(schemaCommand: Command): void {
  // schema diff
  schemaCommand
    .command('diff')
    .description('Show pending schema changes since last migration')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .addHelpText('after', `
Examples:
  bwrb schema diff              # Show what changed
  bwrb schema diff -o json      # Output as JSON for scripting`)
    .action(async (options: DiffOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        
        // Load current schema
        const currentSchema = await loadSchema(vaultDir);
        
        // Check if snapshot exists
        if (!await hasSchemaSnapshot(vaultDir)) {
          if (jsonMode) {
            printJson(jsonSuccess({
              message: 'No previous schema snapshot found. Run `bwrb schema migrate --execute` to create initial snapshot.',
              data: { hasSnapshot: false, changes: [] },
            }));
          } else {
            console.log(chalk.yellow('No previous schema snapshot found.'));
            console.log('');
            console.log('This is either a new vault or migrations haven\'t been used yet.');
            console.log('Run `bwrb schema migrate --execute` to create the initial snapshot.');
          }
          return;
        }
        
        // Load snapshot and diff
        const snapshot = await loadSchemaSnapshot(vaultDir);
        if (!snapshot) {
          throw new Error('Snapshot file exists but could not be loaded');
        }
        const currentVersion = currentSchema.raw.schemaVersion ?? '1.0.0';
        const snapshotVersion = snapshot.schemaVersion ?? '1.0.0';
        const diff = diffSchemas(snapshot.schema, currentSchema.raw, snapshotVersion, currentVersion);
        
        if (jsonMode) {
          printJson(jsonSuccess({
            message: diff.hasChanges ? 'Schema changes detected' : 'No changes',
            data: formatDiffForJson(diff),
          }));
        } else {
          if (!diff.hasChanges) {
            console.log(chalk.green('No schema changes since last migration.'));
          } else {
            console.log(chalk.bold('\nPending Schema Changes\n'));
            console.log(formatDiffForDisplay(diff));
            if (currentVersion === snapshotVersion) {
              console.log(chalk.yellow(`\nNote: Schema version is still ${currentVersion}.`));
              console.log(chalk.yellow('You\'ll be prompted to update it when running `bwrb schema migrate --execute`.'));
            }
            
            console.log('');
            console.log('Run `bwrb schema migrate` to preview the migration.');
            console.log('Run `bwrb schema migrate --execute` to apply changes.');
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          printJson(jsonError(message));
          process.exit(ExitCodes.SCHEMA_ERROR);
        }
        printError(message);
        process.exit(1);
      }
    });

  // schema migrate
  schemaCommand
    .command('migrate')
    .description('Apply schema changes to existing notes')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .option('-x, --execute', 'Actually apply the migration (default is dry-run)')
    .option('--no-backup', 'Skip backup creation (not recommended)')
    .addHelpText('after', `
Examples:
  bwrb schema migrate              # Preview migration (dry-run)
  bwrb schema migrate --execute    # Apply migration with backup
  bwrb schema migrate --execute --no-backup  # Apply without backup`)
    .action(async (options: MigrateOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      const execute = options.execute ?? false;
      const backup = options.noBackup !== true;

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        
        // Load current schema
        const currentSchema = await loadSchema(vaultDir);
        const currentVersion = currentSchema.raw.schemaVersion ?? '1.0.0';
        
        // Check if snapshot exists - if not, this is initial setup
        let diff: MigrationPlan;
        let isInitialSnapshot = false;
        
        if (!await hasSchemaSnapshot(vaultDir)) {
          isInitialSnapshot = true;
          // Create empty diff for initial snapshot
          diff = {
            fromVersion: '0.0.0',
            toVersion: currentVersion,
            deterministic: [],
            nonDeterministic: [],
            hasChanges: false,
          };
        } else {
          // Load snapshot and diff
          const snapshot = await loadSchemaSnapshot(vaultDir);
          if (!snapshot) {
            throw new Error('Snapshot file exists but could not be loaded');
          }
          const snapshotVersion = snapshot.schemaVersion ?? '1.0.0';
          diff = diffSchemas(snapshot.schema, currentSchema.raw, snapshotVersion, currentVersion);
        }
        
        // If no changes and not initial snapshot
        if (!diff.hasChanges && !isInitialSnapshot) {
          if (jsonMode) {
            printJson(jsonSuccess({
              message: 'No schema changes to migrate',
              data: { hasChanges: false },
            }));
          } else {
            console.log(chalk.green('No schema changes to migrate.'));
          }
          return;
        }
        
        // Dry-run mode
        if (!execute) {
          if (isInitialSnapshot) {
            if (jsonMode) {
              printJson(jsonSuccess({
                message: 'Initial snapshot will be created',
                data: { 
                  isInitialSnapshot: true, 
                  dryRun: true,
                  schemaVersion: currentVersion,
                },
              }));
            } else {
              console.log(chalk.bold('\nInitial Schema Snapshot\n'));
              console.log('No previous snapshot exists. Running `--execute` will:');
              console.log(`  1. Create initial schema snapshot (version ${currentVersion})`);
              console.log('  2. Record this as the baseline for future migrations');
              console.log('');
              console.log('Run `bwrb schema migrate --execute` to create the snapshot.');
            }
          } else {
            // Execute dry-run migration to show what would happen
            const result = await executeMigration({
              vaultDir,
              schema: currentSchema,
              plan: diff,
              execute: false,
              backup: false,
            });
            
            if (jsonMode) {
              printJson(jsonSuccess({
                message: 'Migration preview (dry-run)',
                data: {
                  dryRun: true,
                  fromVersion: diff.fromVersion,
                  toVersion: diff.toVersion,
                  totalFiles: result.totalFiles,
                  affectedFiles: result.affectedFiles,
                  changes: diff,
                },
              }));
            } else {
              console.log(chalk.bold('\nMigration Preview (Dry-Run)\n'));
              console.log(formatDiffForDisplay(diff));
              console.log(chalk.cyan(`Files scanned: ${result.totalFiles}`));
              console.log(chalk.cyan(`Files affected: ${result.affectedFiles}`));
              console.log('');
              console.log('Run `bwrb schema migrate --execute` to apply these changes.');
            }
          }
          return;
        }
        
        // Execute mode - prompt for version if schema changed
        let newVersion = currentVersion;
        if (diff.hasChanges && !jsonMode) {
          // Suggest version bump
          const suggestedVersion = suggestVersionBump(currentVersion, diff);
          
          console.log(chalk.bold('\nSchema Migration\n'));
          console.log(formatDiffForDisplay(diff));
          
          const versionResult = await promptInput(
            `Schema version (current: ${currentVersion})`,
            suggestedVersion
          );
          if (versionResult === null) {
            process.exit(0); // User cancelled
          }
          newVersion = versionResult.trim() || suggestedVersion;
          
          // Validate version format
          if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
            throw new Error('Version must be in semver format (e.g., 1.2.3)');
          }
          
          // Warn if version didn't change
          if (newVersion === currentVersion && diff.hasChanges) {
            const confirmResult = await promptConfirm(
              `Version unchanged (${currentVersion}). Continue anyway?`
            );
            if (confirmResult === null || !confirmResult) {
              process.exit(0);
            }
          }
        }
        
        // For initial snapshot, just save the snapshot
        if (isInitialSnapshot) {
          await saveSchemaSnapshot(vaultDir, currentSchema.raw, currentVersion);
          
          if (jsonMode) {
            printJson(jsonSuccess({
              message: 'Initial schema snapshot created',
              data: {
                isInitialSnapshot: true,
                schemaVersion: currentVersion,
              },
            }));
          } else {
            console.log('');
            printSuccess(`Initial schema snapshot created (version ${currentVersion})`);
            console.log('');
            console.log('Future schema changes will be tracked from this point.');
          }
          return;
        }
        
        // Execute the migration
        const result = await executeMigration({
          vaultDir,
          schema: currentSchema,
          plan: diff,
          execute: true,
          backup,
        });
        
        // Update schema version if changed
        if (newVersion !== currentVersion) {
          const rawSchema = await loadRawSchemaJson(vaultDir);
          rawSchema.schemaVersion = newVersion;
          await writeSchema(vaultDir, rawSchema);
        }
        
        // Save new snapshot
        const updatedSchema = await loadRawSchemaJson(vaultDir);
        await saveSchemaSnapshot(vaultDir, updatedSchema, newVersion);
        
        // Record migration in history
        await recordMigration(vaultDir, {
          ...diff,
          fromVersion: currentVersion,
          toVersion: newVersion,
        }, result);
        
        if (jsonMode) {
          printJson(jsonSuccess({
            message: 'Migration completed',
            data: {
              fromVersion: currentVersion,
              toVersion: newVersion,
              totalFiles: result.totalFiles,
              affectedFiles: result.affectedFiles,
              backupPath: result.backupPath,
              errors: result.errors,
            },
          }));
        } else {
          console.log('');
          printSuccess(`Migration completed (${currentVersion} → ${newVersion})`);
          console.log('');
          console.log(chalk.cyan(`  Files scanned: ${result.totalFiles}`));
          console.log(chalk.cyan(`  Files modified: ${result.affectedFiles}`));
          if (result.backupPath) {
            console.log(chalk.cyan(`  Backup: ${result.backupPath}`));
          }
          if (result.errors.length > 0) {
            console.log('');
            console.log(chalk.yellow(`  Errors: ${result.errors.length}`));
            for (const error of result.errors.slice(0, 5)) {
              console.log(chalk.yellow(`    • ${error}`));
            }
            if (result.errors.length > 5) {
              console.log(chalk.yellow(`    ... and ${result.errors.length - 5} more`));
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          printJson(jsonError(message));
          process.exit(ExitCodes.SCHEMA_ERROR);
        }
        printError(message);
        process.exit(1);
      }
    });

  // schema history
  schemaCommand
    .command('history')
    .description('Show migration history')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .option('--limit <n>', 'Number of entries to show (default: 10)')
    .addHelpText('after', `
Examples:
  bwrb schema history              # Show recent migrations
  bwrb schema history --limit 5    # Show last 5 migrations
  bwrb schema history -o json      # Output as JSON`)
    .action(async (options: HistoryOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      const limit = options.limit ? parseInt(options.limit, 10) : 10;

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        
        const history = await loadMigrationHistory(vaultDir);
        
        if (history.applied.length === 0) {
          if (jsonMode) {
            printJson(jsonSuccess({
              message: 'No migration history',
              data: { migrations: [] },
            }));
          } else {
            console.log('No migration history found.');
            console.log('');
            console.log('Run `bwrb schema migrate --execute` to start tracking migrations.');
          }
          return;
        }
        
        // Get most recent entries
        const entries = history.applied.slice(-limit).reverse();
        
        if (jsonMode) {
          printJson(jsonSuccess({
            data: {
              total: history.applied.length,
              showing: entries.length,
              migrations: entries,
            },
          }));
        } else {
          console.log(chalk.bold('\nMigration History\n'));
          
          for (const entry of entries) {
            const date = new Date(entry.appliedAt).toLocaleString();
            console.log(chalk.cyan(`Version ${entry.version}`));
            console.log(chalk.gray(`  Applied: ${date}`));
            console.log(chalk.gray(`  Notes affected: ${entry.notesAffected}`));
            if (entry.operations.length > 0) {
              console.log(chalk.gray(`  Operations: ${entry.operations.length}`));
            }
            console.log('');
          }
          
          if (history.applied.length > limit) {
            console.log(chalk.gray(`Showing ${entries.length} of ${history.applied.length} migrations.`));
            console.log(chalk.gray(`Use --limit to see more.`));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          printJson(jsonError(message));
          process.exit(ExitCodes.SCHEMA_ERROR);
        }
        printError(message);
        process.exit(1);
      }
    });
}

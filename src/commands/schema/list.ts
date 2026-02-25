/**
 * Schema list commands.
 * Handles: list, list types, list fields, list type <name>
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadCurrentSchema, getTypeNames } from '../../lib/schema.js';
import { resolveVaultDirWithSelection } from '../../lib/vaultSelection.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { getGlobalOpts } from '../../lib/command.js';
import { UserCancelledError } from '../../lib/errors.js';
import { loadSchemaSnapshot } from '../../lib/migration/snapshot.js';
import { getMigrationStatus } from '../../lib/migration/status.js';
import { getTtyContext } from '../../lib/tty/context.js';
import {
  outputSchemaJson,
  outputSchemaVerboseJson,
  outputTypeDetailsJson,
  showSchemaTree,
  showSchemaTreeVerbose,
  showTypeDetails,
  getFieldType,
  renderSchemaFieldsTable,
} from './helpers/output.js';
import type { Field, LoadedSchema } from '../../types/schema.js';

interface ListCommandOptions {
  output?: string;
  verbose?: boolean;
  type?: string;
}

const RESERVED_LIST_NOUNS = new Set(['types', 'fields', 'type']);

function hasTypeAliasFlagToken(): boolean {
  return process.argv.includes('--type') || process.argv.includes('-t');
}

function ensureNoTypeAliasConflict(options: ListCommandOptions, usage: string): void {
  if (!options.type && !hasTypeAliasFlagToken()) {
    return;
  }

  throw new Error(
    `Cannot use --type with '${usage}'. ` +
    `Use either '${usage}' or 'bwrb schema list --type <typePath>'.`
  );
}

export const listCommand = new Command('list')
  .description('List schema contents')
  .addHelpText('after', `
Examples:
  bwrb schema list                # Show full schema overview
  bwrb schema list --verbose      # Show all types with their fields
  bwrb schema list types          # List type names only
  bwrb schema list fields         # List all fields across types
  bwrb schema list type task      # Canonical type detail form
  bwrb schema list task           # Alias for: schema list type task
  bwrb schema list -t task        # Alias for: schema list type task`);

// schema list (no args - show full schema overview)
listCommand
  .argument('[typePath]', 'Type path alias for "schema list type <typePath>"')
  .option('-t, --type <typePath>', 'Type path alias for "schema list type <typePath>"')
  .option('--output <format>', 'Output format: text (default) or json')
  .option('--verbose', 'Show all types with their fields inline')
  .action(async (typePath: string | undefined, options: ListCommandOptions, cmd: Command) => {
    const globalOpts = getGlobalOpts(cmd);
    const jsonMode = options.output === 'json' || globalOpts.output === 'json';

    try {
      if (typePath && options.type) {
        throw new Error(
          `Cannot combine positional type path '${typePath}' with --type '${options.type}'. ` +
          'Use one form: "bwrb schema list <typePath>", "bwrb schema list --type <typePath>", or "bwrb schema list type <typePath>".'
        );
      }

      const targetType = options.type ?? typePath;

      if (typePath && !options.type && RESERVED_LIST_NOUNS.has(typePath)) {
        throw new Error(
          `Type path '${typePath}' is reserved by schema list subcommands. ` +
          `Use 'bwrb schema list ${typePath}' for the subcommand, or ` +
          `'bwrb schema list type ${typePath}' to show that type.`
        );
      }

      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadCurrentSchema(vaultDir);
      await warnIfPendingMigration(vaultDir, schema, jsonMode);

      if (targetType) {
        if (jsonMode) {
          outputTypeDetailsJson(schema, targetType);
        } else {
          showTypeDetails(schema, targetType);
        }
        return;
      }

      if (jsonMode) {
        if (options.verbose) {
          outputSchemaVerboseJson(schema);
        } else {
          outputSchemaJson(schema);
        }
      } else {
        if (options.verbose) {
          showSchemaTreeVerbose(schema);
        } else {
          showSchemaTree(schema);
        }
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      console.error(message);
      process.exit(1);
    }
  });

// schema list types
listCommand
  .command('types')
  .description('List all type names')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      ensureNoTypeAliasConflict(options, 'bwrb schema list types');

      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadCurrentSchema(vaultDir);
      await warnIfPendingMigration(vaultDir, schema, jsonMode);

      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');

      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Found ${typeNames.length} types`,
          data: { types: typeNames },
        }));
      } else {
        console.log(chalk.bold('\nTypes:\n'));
        for (const name of typeNames) {
          const typeEntry = schema.raw.types[name];
          const inherits = typeEntry?.extends ? ` (extends: ${typeEntry.extends})` : '';
          console.log(`  ${name}${chalk.gray(inherits)}`);
        }
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      console.error(message);
      process.exit(1);
    }
  });

// schema list fields
listCommand
  .command('fields')
  .description('List all fields across all types')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      ensureNoTypeAliasConflict(options, 'bwrb schema list fields');

      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadCurrentSchema(vaultDir);
      await warnIfPendingMigration(vaultDir, schema, jsonMode);

      const allFields: Array<{ type: string; field: string; definition: Field }> = [];
      
      for (const typeName of getTypeNames(schema)) {
        if (typeName === 'meta') continue;
        const typeEntry = schema.raw.types[typeName];
        if (typeEntry?.fields) {
          for (const [fieldName, fieldDef] of Object.entries(typeEntry.fields)) {
            allFields.push({ type: typeName, field: fieldName, definition: fieldDef });
          }
        }
      }

      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Found ${allFields.length} fields`,
          data: { fields: allFields },
        }));
      } else {
        console.log(chalk.bold('\nFields:\n'));
        const context = getTtyContext();
        const lines = renderSchemaFieldsTable(
          allFields.map(({ type, field, definition }) => {
            const details: string[] = [];
            if (definition.options?.length) {
              if (context.isTTY) {
                details.push(`options=[${definition.options.slice(0, 3).join(', ')}${definition.options.length > 3 ? '...' : ''}]`);
              } else {
                details.push(`options=[${definition.options.join(', ')}]`);
              }
            }
            if (definition.required) {
              details.push('required');
            }
            if (definition.default !== undefined) {
              const def = Array.isArray(definition.default)
                ? `[${definition.default.join(', ')}]`
                : String(definition.default);
              details.push(`default=${def}`);
            }
            return {
              type,
              field,
              kind: getFieldType(definition),
              details: details.join(' '),
            };
          })
        );
        for (const line of lines) {
          console.log(line);
        }
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      console.error(message);
      process.exit(1);
    }
  });

// schema list type <name>
listCommand
  .command('type <name>')
  .description('Show details for a specific type')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    // Check both this command's options and global options
    const globalOpts = getGlobalOpts(cmd);
    const jsonMode = options.output === 'json' || globalOpts.output === 'json';

    try {
      if (options.type || hasTypeAliasFlagToken()) {
        throw new Error(
          `Cannot combine 'bwrb schema list type ${name}' with --type/-t. ` +
          `Use either 'bwrb schema list type ${name}' or 'bwrb schema list --type <typePath>'.`
        );
      }

      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadCurrentSchema(vaultDir);
      await warnIfPendingMigration(vaultDir, schema, jsonMode);

      if (jsonMode) {
        outputTypeDetailsJson(schema, name);
      } else {
        showTypeDetails(schema, name);
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      console.error(message);
      process.exit(1);
    }
  });

async function warnIfPendingMigration(
  vaultDir: string,
  schema: LoadedSchema,
  jsonMode: boolean
): Promise<void> {
  if (!vaultDir) return;

  try {
    const snapshot = await loadSchemaSnapshot(vaultDir);
    const status = getMigrationStatus(schema.raw, snapshot);

    if (!status.hasSnapshot || !status.pending) {
      return;
    }

    const warning =
      'Warning: schema has changes not yet migrated (schema.json != schema.applied.json). ' +
      'Showing current schema.json. Run "bwrb schema diff" or "bwrb schema migrate" to review/apply.';

    if (jsonMode) {
      console.error(warning);
      return;
    }

    console.error(warning);
  } catch {
    // Snapshot read failures should not block schema inspection.
  }
}

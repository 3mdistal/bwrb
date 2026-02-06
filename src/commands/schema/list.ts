/**
 * Schema list commands.
 * Handles: list, list types, list fields, list type <name>
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadSchema, getTypeNames } from '../../lib/schema.js';
import { resolveVaultDirWithSelection } from '../../lib/vaultSelection.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { getGlobalOpts } from '../../lib/command.js';
import { UserCancelledError } from '../../lib/errors.js';
import {
  outputSchemaJson,
  outputSchemaVerboseJson,
  outputTypeDetailsJson,
  showSchemaTree,
  showSchemaTreeVerbose,
  showTypeDetails,
  getFieldType,
} from './helpers/output.js';
import type { Field, LoadedSchema } from '../../types/schema.js';

interface ListCommandOptions {
  output?: string;
  verbose?: boolean;
  type?: string;
}

type ListRoute =
  | { kind: 'overview' }
  | { kind: 'type-details'; name: string }
  | { kind: 'error'; message: string };

const RESERVED_LIST_NOUNS = new Set(['types', 'fields', 'type', 'enums']);

function resolveListRoute(target: string | undefined, typeFlag: string | undefined): ListRoute {
  if (target && typeFlag) {
    return {
      kind: 'error',
      message:
        'Cannot use both positional shorthand and --type together. Use either `bwrb schema list <typePath>` or `bwrb schema list -t <typePath>`.',
    };
  }

  if (typeFlag) {
    return { kind: 'type-details', name: typeFlag };
  }

  if (!target) {
    return { kind: 'overview' };
  }

  if (target === 'enums') {
    return {
      kind: 'error',
      message:
        '`enums` is reserved for schema-list nouns. To show a type literally named "enums", use `bwrb schema list type enums` or `bwrb schema list -t enums`.',
    };
  }

  if (RESERVED_LIST_NOUNS.has(target)) {
    return {
      kind: 'error',
      message:
        `\`${target}\` is reserved for schema-list nouns. To show a type literally named "${target}", use \`bwrb schema list type ${target}\` or \`bwrb schema list -t ${target}\`.`,
    };
  }

  return { kind: 'type-details', name: target };
}

function isJsonMode(options: ListCommandOptions, cmd: Command): boolean {
  const globalOpts = getGlobalOpts(cmd);
  return options.output === 'json' || globalOpts.output === 'json';
}

async function runWithSchema(
  options: ListCommandOptions,
  cmd: Command,
  run: (schema: LoadedSchema, jsonMode: boolean) => void
): Promise<void> {
  const jsonMode = isJsonMode(options, cmd);

  try {
    const globalOpts = getGlobalOpts(cmd);
    const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
    if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
    const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
    const schema = await loadSchema(vaultDir);

    run(schema, jsonMode);
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
}

function outputTypeDetails(schema: LoadedSchema, name: string, jsonMode: boolean): void {
  if (jsonMode) {
    outputTypeDetailsJson(schema, name);
  } else {
    showTypeDetails(schema, name);
  }
}

export const listCommand = new Command('list')
  .description('List schema contents')
  .addHelpText('after', `
Examples:
  bwrb schema list                  # Show full schema overview
  bwrb schema list --verbose        # Show all types with their fields
  bwrb schema list types            # List type names only
  bwrb schema list fields           # List all fields across types
  bwrb schema list task             # Shorthand for: schema list type task
  bwrb schema list -t task          # Show details for "task" type

Notes:
  - Positional reserved nouns still map to subcommands: types, fields, type, enums
  - If a type name collides with a reserved noun, use explicit form:
    bwrb schema list type <name> or bwrb schema list -t <name>`);

// schema list (no args - show full schema overview)
listCommand
  .argument('[target]', 'Type path shorthand for `schema list type <name>`')
  .option('-t, --type <typePath>', 'Show details for a specific type')
  .option('--output <format>', 'Output format: text (default) or json')
  .option('--verbose', 'Show all types with their fields inline')
  .action(async (target: string | undefined, options: ListCommandOptions, cmd: Command) => {
    const route = resolveListRoute(target, options.type);

    if (route.kind === 'error') {
      const jsonMode = isJsonMode(options, cmd);
      if (jsonMode) {
        printJson(jsonError(route.message, { code: ExitCodes.VALIDATION_ERROR }));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      console.error(route.message);
      process.exit(1);
    }

    await runWithSchema(options, cmd, (schema, jsonMode) => {
      if (route.kind === 'type-details') {
        outputTypeDetails(schema, route.name, jsonMode);
        return;
      }

      if (jsonMode) {
        if (options.verbose) {
          outputSchemaVerboseJson(schema);
        } else {
          outputSchemaJson(schema);
        }
      } else if (options.verbose) {
        showSchemaTreeVerbose(schema);
      } else {
        showSchemaTree(schema);
      }
    });
  });

// schema list types
listCommand
  .command('types')
  .description('List all type names')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    await runWithSchema(options, cmd, (schema, jsonMode) => {
      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');

      if (jsonMode) {
        printJson(
          jsonSuccess({
            message: `Found ${typeNames.length} types`,
            data: { types: typeNames },
          })
        );
      } else {
        console.log(chalk.bold('\nTypes:\n'));
        for (const name of typeNames) {
          const typeEntry = schema.raw.types[name];
          const inherits = typeEntry?.extends ? ` (extends: ${typeEntry.extends})` : '';
          console.log(`  ${name}${chalk.gray(inherits)}`);
        }
      }
    });
  });

// schema list fields
listCommand
  .command('fields')
  .description('List all fields across all types')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    await runWithSchema(options, cmd, (schema, jsonMode) => {
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
        printJson(
          jsonSuccess({
            message: `Found ${allFields.length} fields`,
            data: { fields: allFields },
          })
        );
      } else {
        console.log(chalk.bold('\nFields:\n'));
        for (const { type, field, definition } of allFields) {
          const typeStr = getFieldType(definition);
          const optionsSuffix = definition.options?.length
            ? ` [${definition.options.slice(0, 3).join(', ')}${definition.options.length > 3 ? '...' : ''}]`
            : '';
          const required = definition.required ? chalk.red('*') : '';
          console.log(`  ${type}.${field}${required} ${chalk.gray(`(${typeStr}${optionsSuffix})`)}`);
        }
      }
    });
  });

// schema list type <name>
listCommand
  .command('type <name>')
  .description('Show details for a specific type')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    await runWithSchema(options, cmd, (schema, jsonMode) => {
      outputTypeDetails(schema, name, jsonMode);
    });
  });

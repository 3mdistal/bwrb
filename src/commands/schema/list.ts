/**
 * Schema list commands.
 * Handles: list, list types, list fields, list type <name>
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadSchema, getTypeNames } from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { getGlobalOpts } from '../../lib/command.js';
import {
  outputSchemaJson,
  outputTypeDetailsJson,
  showSchemaTree,
  showTypeDetails,
  getFieldType,
} from './helpers/output.js';
import type { Field } from '../../types/schema.js';

interface ListCommandOptions {
  output?: string;
}

export const listCommand = new Command('list')
  .description('List schema contents')
  .addHelpText('after', `
Examples:
  bwrb schema list                # Show full schema overview
  bwrb schema list types          # List type names only
  bwrb schema list fields         # List all fields across types
  bwrb schema list type task      # Show details for "task" type`);

// schema list (no args - show full schema overview)
listCommand
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        outputSchemaJson(schema);
      } else {
        showSchemaTree(schema);
      }
    } catch (err) {
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
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

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
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

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
        for (const { type, field, definition } of allFields) {
          const typeStr = getFieldType(definition);
          const optionsSuffix = definition.options?.length ? ` [${definition.options.slice(0, 3).join(', ')}${definition.options.length > 3 ? '...' : ''}]` : '';
          const required = definition.required ? chalk.red('*') : '';
          console.log(`  ${type}.${field}${required} ${chalk.gray(`(${typeStr}${optionsSuffix})`)}`);
        }
      }
    } catch (err) {
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
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    // Check both this command's options and global options
    const globalOpts = getGlobalOpts(cmd);
    const jsonMode = options.output === 'json' || globalOpts.output === 'json';

    try {
      const vaultDir = resolveVaultDir(globalOpts);
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        outputTypeDetailsJson(schema, name);
      } else {
        showTypeDetails(schema, name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      console.error(message);
      process.exit(1);
    }
  });

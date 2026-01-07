/**
 * Schema field management commands.
 * Handles: new field, edit field, delete field
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
  promptMultiInput,
  promptSelection,
} from '../../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../../lib/output.js';
import { loadRawSchemaJson, writeSchema } from '../../lib/schema-writer.js';
import { validateFieldName } from './helpers/validation.js';
import { promptTypePicker, promptFieldPicker } from './helpers/pickers.js';
import { promptSingleFieldDefinition } from './helpers/prompts.js';
import { getFieldType } from './helpers/output.js';
import type { Field } from '../../types/schema.js';

interface NewFieldOptions {
  output?: string;
}

interface EditFieldOptions {
  output?: string;
}

interface DeleteFieldOptions {
  output?: string;
  execute?: boolean;
}

/**
 * Register field subcommands onto parent new/edit/delete commands.
 */

export function registerNewFieldCommand(newCommand: Command): void {
  newCommand
    .command('field [type] [name]')
    .description('Add a field to a type')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .action(async (typeName: string | undefined, fieldName: string | undefined, options: NewFieldOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Get type name if not provided
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptTypePicker(schema, 'Select type to add field to');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate type exists
        if (!schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" does not exist`);
        }

        // Get field name if not provided
        if (!fieldName) {
          if (jsonMode) {
            throw new Error('Field name is required in JSON mode');
          }
          const result = await promptInput('Field name');
          if (result === null) {
            process.exit(0);
          }
          fieldName = result;
        }

        // Validate field name
        const nameError = validateFieldName(fieldName);
        if (nameError) {
          throw new Error(nameError);
        }

        // Check if field already exists on this type
        const typeEntry = schema.raw.types[typeName];
        if (typeEntry?.fields?.[fieldName]) {
          throw new Error(`Field "${fieldName}" already exists on type "${typeName}"`);
        }

        // Prompt for field definition
        if (jsonMode) {
          throw new Error('Interactive field definition required. Use add-field with --type flag for JSON mode.');
        }
        
        const result = await promptSingleFieldDefinition(schema, fieldName);
        if (result === null) {
          process.exit(0);
        }
        const fieldDef = result.field;

        // Add the field
        const rawSchema = await loadRawSchemaJson(vaultDir);
        if (!rawSchema.types?.[typeName]) {
          throw new Error(`Type "${typeName}" not found in schema`);
        }
        const targetType = rawSchema.types[typeName]!;
        if (!targetType.fields) {
          targetType.fields = {};
        }
        targetType.fields[fieldName] = fieldDef;
        await writeSchema(vaultDir, rawSchema);

        if (jsonMode) {
          printJson(jsonSuccess({
            message: `Field "${fieldName}" added to type "${typeName}"`,
            data: { type: typeName, field: fieldName, definition: fieldDef },
          }));
        } else {
          printSuccess(`Field "${fieldName}" added to type "${typeName}"`);
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

export function registerEditFieldCommand(editCommand: Command): void {
  editCommand
    .command('field [type] [name]')
    .description('Edit a field definition')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .action(async (typeName: string | undefined, fieldName: string | undefined, options: EditFieldOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Get type name if not provided
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptTypePicker(schema, 'Select type');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate type exists
        if (!schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" does not exist`);
        }

        // Get field name if not provided
        if (!fieldName) {
          if (jsonMode) {
            throw new Error('Field name is required in JSON mode');
          }
          const result = await promptFieldPicker(schema, typeName, 'Select field to edit');
          if (result === null) {
            process.exit(0);
          }
          fieldName = result;
        }

        // Validate field exists on this type
        const typeEntry = schema.raw.types[typeName];
        if (!typeEntry?.fields?.[fieldName]) {
          throw new Error(`Field "${fieldName}" does not exist on type "${typeName}"`);
        }

        // Interactive edit
        if (jsonMode) {
          throw new Error('Interactive edit required. JSON mode is not supported for schema edit field.');
        }

        const currentDef = typeEntry.fields[fieldName];
        if (!currentDef) {
          printError(`Field "${fieldName}" not found on type "${typeName}"`);
          process.exit(1);
        }
        console.log(chalk.bold(`\nEditing field: ${typeName}.${fieldName}\n`));
        // eslint-disable-next-line no-control-regex
        console.log(`Current type: ${getFieldType(currentDef).replace(/\x1b\[[0-9;]*m/g, '')}`);
        if (currentDef.required) console.log(`Required: yes`);
        if (currentDef.default !== undefined) console.log(`Default: ${currentDef.default}`);

        const editOptions = ['Change prompt type', 'Toggle required', 'Set default', 'Done'];
        
        while (true) {
          const choice = await promptSelection('What would you like to edit?', editOptions);
          if (choice === null || choice === 'Done') {
            break;
          }

          const rawSchema = await loadRawSchemaJson(vaultDir);
          const rawTypeEntry = rawSchema.types?.[typeName];
          if (!rawTypeEntry?.fields) {
            printError(`Type "${typeName}" or its fields not found`);
            process.exit(1);
          }

          if (choice === 'Change prompt type') {
            const promptOptions = ['text', 'select', 'list', 'date', 'relation', 'boolean', 'number'];
            const newPrompt = await promptSelection('Prompt type', promptOptions);
            const fieldEntry = rawTypeEntry.fields?.[fieldName];
            if (newPrompt !== null && fieldEntry) {
              fieldEntry.prompt = newPrompt as Field['prompt'];
              
              // If select type, prompt for inline options
              if (newPrompt === 'select') {
                const optionsResult = await promptMultiInput('Enter options (one per line)');
                if (optionsResult !== null && optionsResult.length > 0) {
                  fieldEntry.options = optionsResult;
                }
              }
              
              await writeSchema(vaultDir, rawSchema);
              printSuccess(`Field prompt type updated to "${newPrompt}"`);
            }
          } else if (choice === 'Toggle required') {
            const fieldEntry = rawTypeEntry.fields?.[fieldName];
            if (fieldEntry) {
              const currentRequired = fieldEntry.required ?? false;
              fieldEntry.required = !currentRequired;
              await writeSchema(vaultDir, rawSchema);
              printSuccess(`Required set to ${!currentRequired}`);
            }
          } else if (choice === 'Set default') {
            const fieldEntry = rawTypeEntry.fields?.[fieldName];
            if (fieldEntry) {
              const currentDefault = fieldEntry.default;
              const newDefault = await promptInput('Default value', currentDefault?.toString() ?? '');
              if (newDefault !== null) {
                if (newDefault === '') {
                  delete fieldEntry.default;
                } else {
                  fieldEntry.default = newDefault;
                }
                await writeSchema(vaultDir, rawSchema);
                printSuccess(`Default value updated`);
              }
            }
          }
        }

        printSuccess(`Finished editing field "${typeName}.${fieldName}"`);
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

export function registerDeleteFieldCommand(deleteCommand: Command): void {
  deleteCommand
    .command('field [type] [name]')
    .description('Delete a field from a type (dry-run by default)')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .option('-x, --execute', 'Actually perform the deletion (default is dry-run)')
    .action(async (typeName: string | undefined, fieldName: string | undefined, options: DeleteFieldOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      const dryRun = !options.execute;

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Get type name if not provided
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptTypePicker(schema, 'Select type');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate type exists
        if (!schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" does not exist`);
        }

        // Get field name if not provided
        if (!fieldName) {
          if (jsonMode) {
            throw new Error('Field name is required in JSON mode');
          }
          const result = await promptFieldPicker(schema, typeName, 'Select field to delete');
          if (result === null) {
            process.exit(0);
          }
          fieldName = result;
        }

        // Validate field exists on this type
        const typeEntry = schema.raw.types[typeName];
        if (!typeEntry?.fields?.[fieldName]) {
          throw new Error(`Field "${fieldName}" does not exist on type "${typeName}"`);
        }

        // Build impact report
        const impact = {
          type: typeName,
          field: fieldName,
          dryRun,
        };

        if (dryRun) {
          if (jsonMode) {
            printJson(jsonSuccess({
              message: `Dry run: would delete field "${fieldName}" from type "${typeName}"`,
              data: { ...impact, wouldDelete: true },
            }));
          } else {
            console.log(chalk.bold(`\nDry run: would delete field "${typeName}.${fieldName}"\n`));
            console.log('Run with --execute to perform the deletion.');
          }
          return;
        }

        // Actually delete
        const rawSchema = await loadRawSchemaJson(vaultDir);
        const typeToUpdate = rawSchema.types?.[typeName];
        if (typeToUpdate?.fields) {
          delete typeToUpdate.fields[fieldName];
          
          // Clean up empty fields object
          if (Object.keys(typeToUpdate.fields).length === 0) {
            delete typeToUpdate.fields;
          }
        }
        
        await writeSchema(vaultDir, rawSchema);

        if (jsonMode) {
          printJson(jsonSuccess({
            message: `Field "${fieldName}" deleted from type "${typeName}"`,
            data: { deleted: { type: typeName, field: fieldName } },
          }));
        } else {
          printSuccess(`Field "${fieldName}" deleted from type "${typeName}"`);
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

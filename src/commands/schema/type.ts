/**
 * Schema type management commands.
 * Handles: new type, edit type, delete type
 */

import { Command } from 'commander';
import { getGlobalOpts } from '../../lib/command.js';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeNames,
  computeDefaultOutputDir,
} from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import {
  printError,
  printSuccess,
  promptInput,
  promptConfirm,
  promptSelection,
} from '../../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../../lib/output.js';
import { loadRawSchemaJson, writeSchema } from '../../lib/schema-writer.js';
import { validateTypeName } from './helpers/validation.js';
import { promptTypePicker } from './helpers/pickers.js';
import { promptFieldDefinition, promptSingleFieldDefinition } from './helpers/prompts.js';
import type { Field, Type } from '../../types/schema.js';

interface NewTypeOptions {
  output?: string;
  fields?: string;
  directory?: string;
  inherits?: string;
}

interface EditTypeOptions {
  output?: string;
}

interface DeleteTypeOptions {
  output?: string;
  execute?: boolean;
}

/**
 * Register type subcommands onto parent new/edit/delete commands.
 */

export function registerNewTypeCommand(newCommand: Command): void {
  newCommand
    .command('type [name]')
    .description('Create a new type')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .option('--fields <fields>', 'Comma-separated field definitions (name:type)')
    .option('--directory <dir>', 'Output directory for notes of this type')
    .option('--inherits <type>', 'Parent type to inherit from')
    .action(async (name: string | undefined, options: NewTypeOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);

        // Get name if not provided
        let typeName = name;
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptInput('Type name');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate name
        const nameError = validateTypeName(typeName);
        if (nameError) {
          throw new Error(nameError);
        }

        // Check if type already exists
        const schema = await loadSchema(vaultDir);
        if (schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" already exists`);
        }

        // Build the type definition
        const rawSchema = await loadRawSchemaJson(vaultDir);
        
        // Parse inheritance
        let inherits: string | undefined;
        if (options.inherits) {
          inherits = options.inherits;
          // Validate parent exists
          if (!schema.raw.types[inherits]) {
            throw new Error(`Parent type "${inherits}" does not exist`);
          }
        }

        // Parse fields from options or prompt
        const fields: Record<string, Field> = {};
        if (options.fields) {
          // Parse "name:type,name2:type2" format
          for (const fieldDef of options.fields.split(',')) {
            const [fieldName, fieldType] = fieldDef.split(':').map(s => s.trim());
            if (!fieldName || !fieldType) {
              throw new Error(`Invalid field definition: "${fieldDef}". Use "name:type" format.`);
            }
            // Map simple type strings to field definitions
            const promptType = fieldType as 'text' | 'select' | 'date' | 'list' | 'relation' | 'boolean' | 'number';
            fields[fieldName] = { prompt: promptType };
          }
        } else if (!jsonMode) {
          // Interactive prompt for fields
          const wantFields = await promptConfirm('Add fields to this type?');
          if (wantFields) {
            const fieldResult = await promptFieldDefinition(schema);
            if (fieldResult && fieldResult !== 'done') {
              fields[fieldResult.name] = fieldResult.field;
            }
          }
        }

        // Build the type object
        const newType: Type = {};
        if (inherits) {
          newType.extends = inherits;
        }
        if (options.directory) {
          newType.output_dir = options.directory;
        } else {
          newType.output_dir = computeDefaultOutputDir(schema, typeName);
        }
        if (Object.keys(fields).length > 0) {
          newType.fields = fields;
        }

        // Add to schema
        rawSchema.types[typeName] = newType;
        await writeSchema(vaultDir, rawSchema);

        if (jsonMode) {
          printJson(jsonSuccess({
            message: `Type "${typeName}" created`,
            data: { type: typeName, definition: newType },
          }));
        } else {
          printSuccess(`Type "${typeName}" created`);
          if (inherits) {
            console.log(`  Inherits from: ${inherits}`);
          }
          console.log(`  Output directory: ${newType.output_dir}`);
          if (Object.keys(fields).length > 0) {
            console.log(`  Fields: ${Object.keys(fields).join(', ')}`);
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

export function registerEditTypeCommand(editCommand: Command): void {
  editCommand
    .command('type [name]')
    .description('Edit a type definition')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .action(async (name: string | undefined, options: EditTypeOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Get type name if not provided
        let typeName = name;
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptTypePicker(schema, 'Select type to edit');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate type exists
        if (!schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" does not exist`);
        }

        // Interactive edit flow
        // Show what can be edited and prompt for changes
        if (jsonMode) {
          throw new Error('Interactive edit required. Use specific flags in JSON mode.');
        }

        console.log(chalk.bold(`\nEditing type: ${typeName}\n`));
        
        const editOptions = ['Edit output directory', 'Edit inheritance', 'Add field', 'Done'];
        
        while (true) {
          const choice = await promptSelection('What would you like to edit?', editOptions);
          if (choice === null || choice === 'Done') {
            break;
          }

          const rawSchema = await loadRawSchemaJson(vaultDir);

          if (choice === 'Edit output directory') {
            const resolvedType = schema.types.get(typeName);
            const currentDir = resolvedType?.outputDir || computeDefaultOutputDir(schema, typeName);
            const newDir = await promptInput('Output directory', currentDir);
            if (newDir !== null && newDir !== currentDir) {
              rawSchema.types[typeName]!.output_dir = newDir;
              await writeSchema(vaultDir, rawSchema);
              printSuccess(`Output directory updated to "${newDir}"`);
            }
          } else if (choice === 'Edit inheritance') {
            const availableTypes = getTypeNames(schema).filter(t => t !== typeName && t !== 'meta');
            if (availableTypes.length === 0) {
              printError('No other types available for inheritance');
              continue;
            }
            const inheritOptions = ['(none)', ...availableTypes];
            const newExtends = await promptSelection('Inherit from', inheritOptions);
            if (newExtends !== null) {
              if (newExtends === '(none)') {
                delete rawSchema.types[typeName]!.extends;
              } else {
                rawSchema.types[typeName]!.extends = newExtends;
              }
              await writeSchema(vaultDir, rawSchema);
              printSuccess(`Inheritance updated`);
            }
          } else if (choice === 'Add field') {
            const fieldName = await promptInput('Field name');
            if (fieldName === null) continue;
            
            const nameError = validateTypeName(fieldName);
            if (nameError) {
              printError(nameError);
              continue;
            }

            const reloadedSchema = await loadSchema(vaultDir);
            const fieldDef = await promptSingleFieldDefinition(reloadedSchema, fieldName);
            if (fieldDef === null) continue;

            const freshSchema = await loadRawSchemaJson(vaultDir);
            if (!freshSchema.types?.[typeName]) {
              throw new Error(`Type "${typeName}" not found in schema`);
            }
            const targetType = freshSchema.types[typeName]!;
            if (!targetType.fields) {
              targetType.fields = {};
            }
            targetType.fields[fieldName] = fieldDef.field;
            await writeSchema(vaultDir, freshSchema);
            printSuccess(`Field "${fieldName}" added`);
          }
        }

        printSuccess(`Finished editing type "${typeName}"`);
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

export function registerDeleteTypeCommand(deleteCommand: Command): void {
  deleteCommand
    .command('type [name]')
    .description('Delete a type (dry-run by default)')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .option('-x, --execute', 'Actually perform the deletion (default is dry-run)')
    .action(async (name: string | undefined, options: DeleteTypeOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      const dryRun = !options.execute;

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Get type name if not provided
        let typeName = name;
        if (!typeName) {
          if (jsonMode) {
            throw new Error('Type name is required in JSON mode');
          }
          const result = await promptTypePicker(schema, 'Select type to delete');
          if (result === null) {
            process.exit(0);
          }
          typeName = result;
        }

        // Validate type exists
        if (!schema.raw.types[typeName]) {
          throw new Error(`Type "${typeName}" does not exist`);
        }

        // Check for subtypes (children)
        const subtypes = getTypeNames(schema).filter(t => {
          const typeEntry = schema.raw.types[t];
          return typeEntry?.extends === typeName;
        });

        // Build impact report
        const impact = {
          type: typeName,
          hasSubtypes: subtypes.length > 0,
          subtypes,
          dryRun,
        };

        if (dryRun) {
          if (jsonMode) {
            printJson(jsonSuccess({
              message: `Dry run: would delete type "${typeName}"`,
              data: { ...impact, wouldDelete: true },
            }));
          } else {
            console.log(chalk.bold(`\nDry run: would delete type "${typeName}"\n`));
            if (subtypes.length > 0) {
              console.log(chalk.yellow(`Warning: This type has ${subtypes.length} subtype(s): ${subtypes.join(', ')}`));
              console.log(chalk.yellow('Subtypes will lose their inheritance.'));
            }
            console.log('');
            console.log('Run with --execute to perform the deletion.');
          }
          return;
        }

        // Actually delete
        const rawSchema = await loadRawSchemaJson(vaultDir);
        
        // Update subtypes to remove inheritance
        for (const subtype of subtypes) {
          if (rawSchema.types[subtype]) {
            delete rawSchema.types[subtype].extends;
          }
        }
        
        // Delete the type
        delete rawSchema.types[typeName];
        await writeSchema(vaultDir, rawSchema);

        if (jsonMode) {
          printJson(jsonSuccess({
            message: `Type "${typeName}" deleted`,
            data: { deleted: typeName, subtypesUpdated: subtypes },
          }));
        } else {
          printSuccess(`Type "${typeName}" deleted`);
          if (subtypes.length > 0) {
            console.log(`Updated ${subtypes.length} subtype(s) to remove inheritance.`);
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

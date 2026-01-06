/**
 * Deprecated schema commands.
 * These are kept for backwards compatibility but will be removed in a future version.
 */

import { Command } from 'commander';
import { getGlobalOpts } from '../../lib/command.js';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeDefByPath,
  getTypeNames,
  computeDefaultOutputDir,
  getFieldsForType,
} from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import {
  printError,
  printSuccess,
  promptInput,
  promptSelection,
} from '../../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../../lib/output.js';
import { loadRawSchemaJson, writeSchema } from '../../lib/schema-writer.js';

/**
 * Print a deprecation warning for old command names.
 */
function warnDeprecated(oldCmd: string, newCmd: string): void {
  console.error(chalk.yellow(`Warning: '${oldCmd}' is deprecated. Use '${newCmd}' instead.`));
}

interface EditTypeOptions {
  outputDir?: string;
  extends?: string;
  filename?: string;
  output?: string;
}

interface EditFieldOptions {
  required?: boolean;
  notRequired?: boolean;
  default?: string;
  clearDefault?: boolean;
  label?: string;
  output?: string;
}

/**
 * Register deprecated commands onto the schema command.
 */
export function registerDeprecatedCommands(schemaCommand: Command): void {
  // schema edit-type (deprecated)
  schemaCommand
    .command('edit-type <type>')
    .description('Edit type settings (output directory, extends, filename pattern)')
    .option('--output-dir <dir>', 'Set output directory for notes of this type')
    .option('--extends <parent>', 'Change parent type')
    .option('--filename <pattern>', 'Set filename pattern')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .action(async (typeName: string, options: EditTypeOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      warnDeprecated('schema edit-type', 'schema edit type');

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);
        const rawSchema = await loadRawSchemaJson(vaultDir);

        // Validate type exists
        const typeDef = getTypeDefByPath(schema, typeName);
        if (!typeDef) {
          const msg = `Unknown type: ${typeName}`;
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        // Don't allow editing meta
        if (typeName === 'meta') {
          const msg = 'Cannot edit the meta type directly';
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        // Get or create the type entry in raw schema
        const typeEntry = rawSchema.types[typeName];
        if (!typeEntry) {
          const msg = `Type not found in schema: ${typeName}`;
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        const changes: string[] = [];

        // Interactive mode if no flags provided
        if (!options.outputDir && !options.extends && !options.filename) {
          console.log(chalk.bold(`Editing type: ${typeName}`));
          console.log('');

          // Prompt for output_dir
          const currentOutputDir = typeEntry.output_dir ?? computeDefaultOutputDir(schema, typeName);
          const newOutputDirResult = await promptInput(
            `Output directory`,
            currentOutputDir
          );
          if (newOutputDirResult === null) {
            process.exit(0); // User cancelled
          }
          const newOutputDir = newOutputDirResult.trim() || currentOutputDir;
          if (newOutputDir !== currentOutputDir) {
            typeEntry.output_dir = newOutputDir;
            changes.push(`output_dir: ${currentOutputDir} → ${newOutputDir}`);
          }

          // Prompt for extends
          const currentExtends = typeEntry.extends ?? 'meta';
          const allTypes = getTypeNames(schema).filter(t => t !== typeName && t !== 'meta');
          const extendsOptions = ['meta', ...allTypes];
          console.log('');
          console.log(chalk.gray(`Current extends: ${currentExtends}`));
          const newExtendsResult = await promptSelection('Extends:', extendsOptions);
          if (newExtendsResult === null) {
            process.exit(0); // User cancelled
          }
          if (newExtendsResult !== currentExtends) {
            typeEntry.extends = newExtendsResult;
            changes.push(`extends: ${currentExtends} → ${newExtendsResult}`);
          }

          // Prompt for filename pattern
          const currentFilename = typeEntry.filename ?? '';
          const newFilenameResult = await promptInput(
            `Filename pattern (blank for default)`,
            currentFilename
          );
          if (newFilenameResult === null) {
            process.exit(0); // User cancelled
          }
          if (newFilenameResult !== currentFilename) {
            if (newFilenameResult) {
              typeEntry.filename = newFilenameResult;
            } else {
              delete typeEntry.filename;
            }
            changes.push(`filename: ${currentFilename || '(default)'} → ${newFilenameResult || '(default)'}`);
          }
        } else {
          // Flag-based mode
          if (options.outputDir) {
            const currentOutputDir = typeEntry.output_dir ?? computeDefaultOutputDir(schema, typeName);
            typeEntry.output_dir = options.outputDir;
            changes.push(`output_dir: ${currentOutputDir} → ${options.outputDir}`);
          }

          if (options.extends) {
            // Validate parent type exists
            if (options.extends !== 'meta' && !getTypeDefByPath(schema, options.extends)) {
              const msg = `Unknown parent type: ${options.extends}`;
              if (jsonMode) {
                printJson(jsonError(msg));
                process.exit(ExitCodes.VALIDATION_ERROR);
              }
              printError(msg);
              process.exit(1);
            }
            // Prevent circular inheritance
            if (options.extends === typeName) {
              const msg = 'A type cannot extend itself';
              if (jsonMode) {
                printJson(jsonError(msg));
                process.exit(ExitCodes.VALIDATION_ERROR);
              }
              printError(msg);
              process.exit(1);
            }
            const currentExtends = typeEntry.extends ?? 'meta';
            typeEntry.extends = options.extends;
            changes.push(`extends: ${currentExtends} → ${options.extends}`);
          }

          if (options.filename !== undefined) {
            const currentFilename = typeEntry.filename ?? '';
            if (options.filename) {
              typeEntry.filename = options.filename;
            } else {
              delete typeEntry.filename;
            }
            changes.push(`filename: ${currentFilename || '(default)'} → ${options.filename || '(default)'}`);
          }
        }

        if (changes.length === 0) {
          if (jsonMode) {
            printJson(jsonSuccess({ message: 'No changes made' }));
          } else {
            console.log(chalk.gray('No changes made.'));
          }
          return;
        }

        // Write updated schema
        await writeSchema(vaultDir, rawSchema);

        if (jsonMode) {
          printJson(jsonSuccess({ message: `Updated type '${typeName}'` }));
        } else {
          printSuccess(`Updated type '${typeName}'`);
          for (const change of changes) {
            console.log(`  ${chalk.gray('•')} ${change}`);
          }
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

  // schema edit-field (deprecated)
  schemaCommand
    .command('edit-field <type> <field>')
    .description('Edit field properties')
    .option('--required', 'Mark field as required')
    .option('--not-required', 'Mark field as not required')
    .option('--default <value>', 'Set default value')
    .option('--clear-default', 'Remove default value')
    .option('--label <text>', 'Set prompt label')
    .option('-o, --output <format>', 'Output format: text (default) or json')
    .action(async (typeName: string, fieldName: string, options: EditFieldOptions, cmd: Command) => {
      const jsonMode = options.output === 'json';
      warnDeprecated('schema edit-field', 'schema edit field');

      try {
        const globalOpts = getGlobalOpts(cmd);
        const vaultDir = resolveVaultDir(globalOpts);
        const schema = await loadSchema(vaultDir);

        // Validate type exists
        const typeDef = getTypeDefByPath(schema, typeName);
        if (!typeDef) {
          const msg = `Unknown type: ${typeName}`;
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        // Get type entry from raw schema
        const typeEntry = schema.raw.types[typeName];
        if (!typeEntry) {
          const msg = `Type not found in schema: ${typeName}`;
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        // Check if field exists on this type (not inherited)
        const ownFields = typeEntry.fields ?? {};
        if (!(fieldName in ownFields)) {
          // Check if it's inherited
          const allFields = getFieldsForType(schema, typeName);
          if (fieldName in allFields) {
            const msg = `Field '${fieldName}' is inherited and cannot be edited on '${typeName}'. Edit it on the parent type instead.`;
            if (jsonMode) {
              printJson(jsonError(msg));
              process.exit(ExitCodes.VALIDATION_ERROR);
            }
            printError(msg);
            process.exit(1);
          }
          const msg = `Field '${fieldName}' not found on type '${typeName}'`;
          if (jsonMode) {
            printJson(jsonError(msg));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(msg);
          process.exit(1);
        }

        const fieldDef = ownFields[fieldName]!;
        const changes: string[] = [];

        // Interactive mode if no flags provided
        if (options.required === undefined && !options.notRequired && options.default === undefined && 
            !options.clearDefault && options.label === undefined) {
          console.log(chalk.bold(`Editing field: ${typeName}.${fieldName}`));
          console.log('');

          // Show current field info
          const fieldInfo: string[] = [];
          if (fieldDef.prompt) fieldInfo.push(`prompt: ${fieldDef.prompt}`);
          if (fieldDef.options) fieldInfo.push(`options: ${fieldDef.options.join(', ')}`);
          if (fieldDef.source) fieldInfo.push(`source: ${fieldDef.source}`);
          if (fieldInfo.length > 0) {
            console.log(chalk.gray(fieldInfo.join(', ')));
            console.log('');
          }

          // Prompt for required
          const currentRequired = fieldDef.required ?? false;
          console.log(chalk.gray(`Currently required: ${currentRequired}`));
          const requiredResult = await promptSelection('Required?', ['true', 'false']);
          if (requiredResult === null) {
            process.exit(0); // User cancelled
          }
          const newRequired = requiredResult === 'true';
          if (newRequired !== currentRequired) {
            fieldDef.required = newRequired;
            changes.push(`required: ${currentRequired} → ${newRequired}`);
          }

          // Prompt for default value
          const currentDefault = fieldDef.default !== undefined 
            ? (Array.isArray(fieldDef.default) ? fieldDef.default.join(', ') : String(fieldDef.default))
            : '';
          const newDefaultResult = await promptInput(
            `Default value (blank to clear)`,
            currentDefault
          );
          if (newDefaultResult === null) {
            process.exit(0); // User cancelled
          }
          if (newDefaultResult !== currentDefault) {
            if (newDefaultResult) {
              fieldDef.default = newDefaultResult;
              changes.push(`default: ${currentDefault || '(none)'} → ${newDefaultResult}`);
            } else if (currentDefault) {
              delete fieldDef.default;
              changes.push(`default: ${currentDefault} → (none)`);
            }
          }

          // Prompt for label
          const currentLabel = fieldDef.label ?? '';
          const newLabelResult = await promptInput(
            `Prompt label (blank to clear)`,
            currentLabel
          );
          if (newLabelResult === null) {
            process.exit(0); // User cancelled
          }
          if (newLabelResult !== currentLabel) {
            if (newLabelResult) {
              fieldDef.label = newLabelResult;
            } else {
              delete fieldDef.label;
            }
            changes.push(`label: ${currentLabel || '(none)'} → ${newLabelResult || '(none)'}`);
          }
        } else {
          // Flag-based mode
          if (options.required) {
            const currentRequired = fieldDef.required ?? false;
            if (!currentRequired) {
              fieldDef.required = true;
              changes.push(`required: false → true`);
            }
          } else if (options.notRequired) {
            const currentRequired = fieldDef.required ?? false;
            if (currentRequired) {
              delete fieldDef.required;
              changes.push(`required: true → false`);
            }
          }

          if (options.clearDefault) {
            if (fieldDef.default !== undefined) {
              const oldDefault = fieldDef.default;
              delete fieldDef.default;
              changes.push(`default: ${oldDefault} → (none)`);
            }
          } else if (options.default !== undefined) {
            const oldDefault = fieldDef.default;
            fieldDef.default = options.default;
            changes.push(`default: ${oldDefault ?? '(none)'} → ${options.default}`);
          }

          if (options.label !== undefined) {
            const oldLabel = fieldDef.label;
            if (options.label) {
              fieldDef.label = options.label;
            } else {
              delete fieldDef.label;
            }
            changes.push(`label: ${oldLabel ?? '(none)'} → ${options.label || '(none)'}`);
          }
        }

        if (changes.length === 0) {
          if (jsonMode) {
            printJson(jsonSuccess({ message: 'No changes made' }));
          } else {
            console.log(chalk.gray('No changes made.'));
          }
          return;
        }

        // Update the field in the type
        typeEntry.fields = { ...typeEntry.fields, [fieldName]: fieldDef };

        // Write updated schema
        await writeSchema(vaultDir, schema.raw);

        if (jsonMode) {
          printJson(jsonSuccess({ message: `Updated field '${fieldName}' on type '${typeName}'` }));
        } else {
          printSuccess(`Updated field '${fieldName}' on type '${typeName}'`);
          for (const change of changes) {
            console.log(`  ${chalk.gray('•')} ${change}`);
          }
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
}

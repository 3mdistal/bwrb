import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
  getTypeNames,
  computeDefaultOutputDir,
  getFieldsByOrigin,
  getFieldOrderForOrigin,
} from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import {
  printError,
  printSuccess,
  promptMultiInput,
  promptInput,
  promptConfirm,
  promptSelection,
} from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import { loadRawSchemaJson, writeSchema } from '../lib/schema-writer.js';

import type { LoadedSchema, Field, BodySection, ResolvedType, Type } from '../types/schema.js';

// ============================================================================
// Deprecation Helper
// ============================================================================

/**
 * Print a deprecation warning for old command names.
 */
function warnDeprecated(oldCmd: string, newCmd: string): void {
  console.error(chalk.yellow(`Warning: '${oldCmd}' is deprecated. Use '${newCmd}' instead.`));
}

// ============================================================================
// Entity Type Picker (for unified verbs)
// ============================================================================

type SchemaEntityType = 'type' | 'field';

/**
 * Prompt user to select what kind of schema entity to work with.
 */
async function promptSchemaEntityType(action: string): Promise<SchemaEntityType | null> {
  const result = await promptSelection(`What do you want to ${action}?`, [
    'type',
    'field',
  ]);
  if (result === null) return null;
  return result as SchemaEntityType;
}

/**
 * Prompt for type selection from available types.
 */
async function promptTypePicker(schema: LoadedSchema, message: string = 'Select type'): Promise<string | null> {
  const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
  if (typeNames.length === 0) {
    throw new Error('No types defined in schema');
  }
  return promptSelection(message, typeNames);
}

/**
 * Prompt for field selection from a type's own fields.
 */
async function promptFieldPicker(
  schema: LoadedSchema, 
  typeName: string, 
  message: string = 'Select field'
): Promise<string | null> {
  const typeEntry = schema.raw.types[typeName];
  if (!typeEntry?.fields || Object.keys(typeEntry.fields).length === 0) {
    throw new Error(`Type "${typeName}" has no own fields to select`);
  }
  const fieldNames = Object.keys(typeEntry.fields);
  return promptSelection(message, fieldNames);
}



interface SchemaShowOptions {
  output?: string;
}

export const schemaCommand = new Command('schema')
  .description('Schema introspection commands')
  .addHelpText('after', `
Examples:
  bwrb schema list              # List all types
  bwrb schema list objective    # Show objective type details
  bwrb schema list objective/task  # Show task subtype details
  bwrb schema list task --output json  # Show as JSON for AI/scripting
  bwrb schema validate          # Validate schema structure`);

// schema validate
schemaCommand
  .command('validate')
  .description('Validate schema structure')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: SchemaShowOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});

      // Loading the schema validates it via Zod
      await loadSchema(vaultDir);

      if (jsonMode) {
        printJson(jsonSuccess({ message: 'Schema is valid' }));
      } else {
        printSuccess('Schema is valid');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(`Schema validation failed: ${message}`));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError('Schema validation failed:');
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// Type Management Subcommands
// ============================================================================

/**
 * Validate a type name.
 * Returns an error message if invalid, undefined if valid.
 */
function validateTypeName(name: string): string | undefined {
  if (!name) {
    return 'Type name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Type name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  if (name === 'meta') {
    return '"meta" is a reserved type name';
  }
  return undefined;
}

/**
 * Prompt for field definition interactively.
 * Returns null if user cancels.
 */
async function promptFieldDefinition(
  schema: LoadedSchema
): Promise<{ name: string; field: Field } | null | 'done'> {
  // Get field name
  const nameResult = await promptInput('Field name (or "done" to finish)');
  if (nameResult === null) return null;
  
  const name = nameResult.trim().toLowerCase();
  if (!name || name === 'done') return 'done';
  
  // Validate field name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    printError('Field name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens');
    return promptFieldDefinition(schema); // Retry
  }
  
  // Get prompt type
  const promptTypes = [
    'text',
    'select (options)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
    'boolean (yes/no)',
    'number (numeric)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'text',
    1: 'select',
    2: 'date',
    3: 'list',
    4: 'relation',
    5: 'boolean',
    6: 'number',
    7: 'value',
  };
  const promptType = promptTypeMap[promptTypeIndex];
  
  const field: Field = {};
  
  // Handle different prompt types
  if (promptType === 'value') {
    // Fixed value
    const valueResult = await promptInput('Fixed value');
    if (valueResult === null) return null;
    field.value = valueResult;
  } else {
    field.prompt = promptType as Field['prompt'];
    
    // For select, get inline options
    if (promptType === 'select') {
      const optionsResult = await promptMultiInput('Enter options (one per line)');
      if (optionsResult === null) return null;
      if (optionsResult.length === 0) {
        printError('Select fields require at least one option');
        return promptFieldDefinition(schema);
      }
      field.options = optionsResult;
    }
    
    // For dynamic, get source type
    if (promptType === 'relation') {
      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
      if (typeNames.length === 0) {
        printError('No types defined in schema yet.');
        return promptFieldDefinition(schema);
      }
      const sourceResult = await promptSelection('Source type', typeNames);
      if (sourceResult === null) return null;
      field.source = sourceResult;
      // Note: Link format is now a vault-wide config option (config.link_format)
    }
    
    // Ask if required
    const requiredResult = await promptConfirm('Required?');
    if (requiredResult === null) return null;
    field.required = requiredResult;
    
    // If not required, ask for default
    if (!field.required) {
      const defaultResult = await promptInput('Default value (blank for none)');
      if (defaultResult === null) return null;
      if (defaultResult.trim()) {
        field.default = defaultResult.trim();
      }
    }
  }
  
  return { name, field };
}

// ============================================================================
// Field Management Subcommands
// ============================================================================

/**
 * Validate a field name.
 * Returns an error message if invalid, undefined if valid.
 */
function validateFieldName(name: string): string | undefined {
  if (!name) {
    return 'Field name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Field name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  return undefined;
}

/**
 * Prompt for a single field definition interactively.
 * Unlike promptFieldDefinition, this doesn't have a "done" option since we're
 * only adding one field.
 */
async function promptSingleFieldDefinition(
  schema: LoadedSchema,
  fieldName?: string
): Promise<{ name: string; field: Field } | null> {
  let name = fieldName;
  
  // Get field name if not provided
  if (!name) {
    const nameResult = await promptInput('Field name');
    if (nameResult === null) return null;
    name = nameResult.trim().toLowerCase();
    
    if (!name) {
      throw new Error('Field name is required');
    }
  }
  
  // Validate field name
  const nameError = validateFieldName(name);
  if (nameError) {
    throw new Error(nameError);
  }
  
  // Get prompt type
  const promptTypes = [
    'text',
    'select (options)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
    'boolean (yes/no)',
    'number (numeric)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'text',
    1: 'select',
    2: 'date',
    3: 'list',
    4: 'relation',
    5: 'boolean',
    6: 'number',
    7: 'value',
  };
  const promptType = promptTypeMap[promptTypeIndex];
  
  const field: Field = {};
  
  // Handle different prompt types
  if (promptType === 'value') {
    // Fixed value
    const valueResult = await promptInput('Fixed value');
    if (valueResult === null) return null;
    field.value = valueResult;
  } else {
    field.prompt = promptType as Field['prompt'];
    
    // For select, get inline options
    if (promptType === 'select') {
      const optionsResult = await promptMultiInput('Enter options (one per line)');
      if (optionsResult === null) return null;
      if (optionsResult.length === 0) {
        throw new Error('Select fields require at least one option');
      }
      field.options = optionsResult;
    }
    
    // For relation, get source type
    if (promptType === 'relation') {
      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
      if (typeNames.length === 0) {
        throw new Error('No types defined in schema yet.');
      }
      const sourceResult = await promptSelection('Source type', typeNames);
      if (sourceResult === null) return null;
      field.source = sourceResult;
      // Note: Link format is now a vault-wide config option (config.link_format)
    }
    
    // Ask if required
    const requiredResult = await promptConfirm('Required?');
    if (requiredResult === null) return null;
    field.required = requiredResult;
    
    // If not required, ask for default
    if (!field.required) {
      const defaultResult = await promptInput('Default value (blank for none)');
      if (defaultResult === null) return null;
      if (defaultResult.trim()) {
        field.default = defaultResult.trim();
      }
    }
  }
  
  return { name, field };
}

// schema edit-type
schemaCommand
  .command('edit-type <type>')
  .description('Edit type settings (output directory, extends, filename pattern)')
  .option('--output-dir <dir>', 'Set output directory for notes of this type')
  .option('--extends <parent>', 'Change parent type')
  .option('--filename <pattern>', 'Set filename pattern')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string, options: {
    outputDir?: string;
    extends?: string;
    filename?: string;
    output?: string;
  }, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

// schema edit-field
schemaCommand
  .command('edit-field <type> <field>')
  .description('Edit field properties')
  .option('--required', 'Mark field as required')
  .option('--not-required', 'Mark field as not required')
  .option('--default <value>', 'Set default value')
  .option('--clear-default', 'Remove default value')
  .option('--label <text>', 'Set prompt label')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string, fieldName: string, options: {
    required?: boolean;
    notRequired?: boolean;
    default?: string;
    clearDefault?: boolean;
    label?: string;
    output?: string;
  }, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema edit-field', 'schema edit field');

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

/**
 * Output schema as JSON for AI/scripting usage.
 */
function outputSchemaJson(schema: LoadedSchema): void {
  const raw = schema.raw;
  const output: Record<string, unknown> = {
    version: raw.version ?? 2,
    types: Object.fromEntries(
      getTypeFamilies(schema).map(family => {
        const typeDef = getTypeDefByPath(schema, family);
        return [
          family,
          typeDef ? formatTypeForJson(schema, family, typeDef) : {},
        ];
      })
    ),
  };

  console.log(JSON.stringify(output, null, 2));
}

/**
 * Output specific type details as JSON.
 */
function outputTypeDetailsJson(schema: LoadedSchema, typePath: string): void {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printJson(jsonError(`Unknown type: ${typePath}`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Get all fields (merged) for backwards compatibility
  const allFields = getFieldsForType(schema, typePath);

  // Get fields grouped by origin for inheritance display
  const { ownFields, inheritedFields } = getFieldsByOrigin(schema, typePath);

  // Format inherited fields as object keyed by origin type
  const inheritedFieldsObj: Record<string, Record<string, unknown>> = {};
  for (const [origin, fields] of inheritedFields) {
    inheritedFieldsObj[origin] = Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        formatFieldForJson(field),
      ])
    );
  }

  const output: Record<string, unknown> = {
    type_path: typePath,
    extends: typeDef.parent,
    output_dir: typeDef.outputDir,
    filename: typeDef.filename,
    // Own fields defined on this type
    own_fields: Object.fromEntries(
      Object.entries(ownFields).map(([name, field]) => [
        name,
        formatFieldForJson(field),
      ])
    ),
    // Inherited fields grouped by origin type
    inherited_fields: Object.keys(inheritedFieldsObj).length > 0
      ? inheritedFieldsObj
      : undefined,
    // All merged fields (backwards compatible)
    fields: Object.fromEntries(
      Object.entries(allFields).map(([name, field]) => [
        name,
        formatFieldForJson(field),
      ])
    ),
    subtypes: hasSubtypes(typeDef) ? getSubtypeKeys(typeDef) : undefined,
    body_sections: typeDef.bodySections 
      ? formatBodySectionsForJson(typeDef.bodySections)
      : undefined,
  };

  // Remove undefined values
  const cleaned = Object.fromEntries(
    Object.entries(output).filter(([_, v]) => v !== undefined)
  );

  console.log(JSON.stringify(cleaned, null, 2));
}

/**
 * Format a type definition for JSON output.
 */
function formatTypeForJson(
  schema: LoadedSchema,
  _typePath: string,
  typeDef: ResolvedType
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    output_dir: typeDef.outputDir,
  };

  // Add subtypes if present (children in new model)
  if (hasSubtypes(typeDef)) {
    result.subtypes = Object.fromEntries(
      getSubtypeKeys(typeDef).map(subtype => {
        // In v2, children are just type names, not paths
        const childTypeDef = getTypeDefByPath(schema, subtype);
        return [
          subtype,
          childTypeDef ? formatTypeForJson(schema, subtype, childTypeDef) : {},
        ];
      })
    );
  }

  return result;
}

/**
 * Format a field for JSON output.
 */
function formatFieldForJson(field: Field): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Determine type
  if (field.value !== undefined) {
    result.type = 'static';
    result.value = field.value;
  } else if (field.prompt) {
    result.type = field.prompt;
  } else {
    result.type = 'auto';
  }

  // Add options if applicable
  if (field.options && field.options.length > 0) {
    result.options = field.options;
  }

  // Add other properties
  if (field.required) result.required = true;
  if (field.default !== undefined) result.default = field.default;
  if (field.label) result.label = field.label;
  if (field.source) result.source = field.source;
  if (field.list_format) result.list_format = field.list_format;

  return result;
}

/**
 * Format body sections for JSON output.
 */
function formatBodySectionsForJson(sections: BodySection[]): unknown[] {
  return sections.map(section => {
    const result: Record<string, unknown> = {
      title: section.title,
      level: section.level ?? 2,
    };
    if (section.content_type) result.content_type = section.content_type;
    if (section.prompt) result.prompt = section.prompt;
    if (section.prompt_label) result.prompt_label = section.prompt_label;
    if (section.children && section.children.length > 0) {
      result.children = formatBodySectionsForJson(section.children);
    }
    return result;
  });
}

/**
 * Show a tree view of all types in the schema.
 */
function showSchemaTree(schema: LoadedSchema): void {
  console.log(chalk.bold('\nSchema Types\n'));

  // Show types
  console.log(chalk.cyan('Types:'));
  for (const family of getTypeFamilies(schema)) {
    const typeDef = getTypeDefByPath(schema, family);
    if (!typeDef) continue;
    printTypeTree(schema, family, typeDef, 0);
  }
}

/**
 * Recursively print a type tree.
 */
function printTypeTree(
  schema: LoadedSchema,
  typePath: string,
  typeDef: ResolvedType,
  depth: number
): void {
  const indent = '  '.repeat(depth + 1);
  const typeName = typePath.split('/').pop() ?? typePath;
  const outputDir = typeDef.outputDir;

  // Build type label
  let label = chalk.green(typeName);
  if (outputDir) {
    label += chalk.gray(` -> ${outputDir}`);
  }

  console.log(`${indent}${label}`);

  // Show subtypes (children in new model)
  if (hasSubtypes(typeDef)) {
    for (const subtype of getSubtypeKeys(typeDef)) {
      // In v2, children are just type names, not paths
      const subDef = getTypeDefByPath(schema, subtype);
      if (subDef) {
        printTypeTree(schema, subtype, subDef, depth + 1);
      }
    }
  }
}

/**
 * Show detailed information about a specific type.
 */
function showTypeDetails(schema: LoadedSchema, typePath: string): void {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printError(`Unknown type: ${typePath}`);
    process.exit(1);
  }

  console.log(chalk.bold(`\nType: ${typePath}\n`));

  // Basic info
  if (typeDef.outputDir) {
    console.log(`  ${chalk.cyan('Output Dir:')} ${typeDef.outputDir}`);
  }
  if (typeDef.filename) {
    console.log(`  ${chalk.cyan('Filename Pattern:')} ${typeDef.filename}`);
  }
  if (typeDef.parent) {
    console.log(`  ${chalk.cyan('Extends:')} ${typeDef.parent}`);
  }

  // Subtypes (children in new model) - show before fields for better overview
  if (hasSubtypes(typeDef)) {
    console.log(`  ${chalk.cyan('Subtypes:')} ${getSubtypeKeys(typeDef).join(', ')}`);
  }

  // Fields grouped by origin (own vs inherited)
  const { ownFields, inheritedFields } = getFieldsByOrigin(schema, typePath);

  // Own fields section
  console.log(`\n  ${chalk.cyan('Own fields:')}`);
  const ownFieldNames = Object.keys(ownFields);
  if (ownFieldNames.length === 0) {
    console.log(chalk.gray('    (none)'));
  } else {
    // Use this type's field order for own fields
    const orderedOwnFields = getFieldOrderForOrigin(schema, typeDef.name, ownFieldNames);
    for (const name of orderedOwnFields) {
      printFieldDetails(name, ownFields[name]!, '    ');
    }
  }

  // Inherited fields sections - one per ancestor that contributed fields
  // Show in ancestor order (parent first, then grandparent, etc.)
  if (inheritedFields.size > 0) {
    for (const ancestorName of typeDef.ancestors) {
      const ancestorFields = inheritedFields.get(ancestorName);
      if (ancestorFields && Object.keys(ancestorFields).length > 0) {
        console.log(`\n  ${chalk.cyan(`Inherited fields (from ${ancestorName}):`)}`);
        // Use ancestor's field order
        const orderedFields = getFieldOrderForOrigin(
          schema,
          ancestorName,
          Object.keys(ancestorFields)
        );
        for (const name of orderedFields) {
          printFieldDetails(name, ancestorFields[name]!, '    ');
        }
      }
    }
  } else {
    console.log(`\n  ${chalk.cyan('Inherited fields:')}`);
    console.log(chalk.gray('    (none)'));
  }

  // Body sections
  if (typeDef.bodySections && typeDef.bodySections.length > 0) {
    console.log(`\n  ${chalk.cyan('Body Sections:')}`);
    for (const section of typeDef.bodySections) {
      console.log(`    ${chalk.yellow(section.title)} (h${section.level ?? 2})`);
    }
  }

  console.log('');
}

/**
 * Print details for a single field.
 */
function printFieldDetails(
  name: string,
  field: Field,
  indent: string
): void {
  const type = getFieldType(field);
  let line = `${indent}${chalk.yellow(name)}: ${type}`;

  // Show options if applicable
  if (field.options && field.options.length > 0) {
    line += chalk.gray(` (${field.options.slice(0, 5).join(', ')}${field.options.length > 5 ? '...' : ''})`);
  }

  // Show filter summary for dynamic fields
  if (field.prompt === 'relation' && field.filter) {
    const filterKeys = Object.keys(field.filter);
    if (filterKeys.length > 0) {
      line += chalk.gray(` filter=[${filterKeys.join(',')}]`);
    }
  }

  // Show default
  if (field.default !== undefined) {
    const defaultStr = Array.isArray(field.default)
      ? `[${field.default.join(', ')}]`
      : String(field.default);
    line += chalk.gray(` default=${defaultStr}`);
  }

  // Show required
  if (field.required) {
    line += chalk.red(' *required');
  }

  console.log(line);
}

/**
 * Get a human-readable type string for a field.
 */
function getFieldType(field: Field): string {
  if (field.value !== undefined) {
    return chalk.magenta('static');
  }

  switch (field.prompt) {
    case 'select':
      return chalk.blue('select');
    case 'list':
      return chalk.blue('list');
    case 'text':
      return chalk.blue('text');
    case 'date':
      return chalk.blue('date');
    case 'relation':
      return field.source ? chalk.blue(`relation:${field.source}`) : chalk.blue('relation');
    case 'boolean':
      return chalk.blue('boolean');
    case 'number':
      return chalk.blue('number');
    default:
      return chalk.gray('auto');
  }
}

// Note: Global enum commands have been removed in favor of inline options on fields.
// Use field.options instead of field.enum for select fields.

// ============================================================================
// Unified Verb Subcommands (new, edit, delete, list)
// ============================================================================

interface NewCommandOptions {
  output?: string;
  fields?: string;
  directory?: string;
  inherits?: string;
  values?: string;
}

interface EditCommandOptions {
  output?: string;
}

interface DeleteCommandOptions {
  output?: string;
  execute?: boolean;
}

interface ListCommandOptions {
  output?: string;
}

// -------------------- schema new --------------------

const newCommand = new Command('new')
  .description('Create a new type or field')
  .addHelpText('after', `
Examples:
  bwrb schema new                    # Prompts for what to create
  bwrb schema new type               # Create a new type
  bwrb schema new type project       # Create type named "project"
  bwrb schema new field              # Create a field (prompts for type)
  bwrb schema new field task status  # Add "status" field to "task" type`);

// schema new (no args - prompt for entity type)
newCommand
  .action(async (options: NewCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema new type|field');
      }

      const entityType = await promptSchemaEntityType('create');
      if (entityType === null) {
        process.exit(0);
      }

      // Re-invoke the appropriate subcommand
      const args = [entityType];
      await newCommand.parseAsync(args, { from: 'user' });
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

// schema new type [name]
newCommand
  .command('type [name]')
  .description('Create a new type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--fields <fields>', 'Comma-separated field definitions (name:type)')
  .option('--directory <dir>', 'Output directory for notes of this type')
  .option('--inherits <type>', 'Parent type to inherit from')
  .action(async (name: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});

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
          if (fieldResult) {
            Object.assign(fields, fieldResult);
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

// schema new field [type] [name]
newCommand
  .command('field [type] [name]')
  .description('Add a field to a type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string | undefined, fieldName: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

// Note: schema new enum has been removed - use inline options on fields instead

schemaCommand.addCommand(newCommand);

// -------------------- schema edit --------------------

const editCommand = new Command('edit')
  .description('Edit an existing type or field')
  .addHelpText('after', `
Examples:
  bwrb schema edit                   # Prompts for what to edit
  bwrb schema edit type              # Edit a type (shows picker)
  bwrb schema edit type task         # Edit the "task" type
  bwrb schema edit field             # Edit a field (shows pickers)
  bwrb schema edit field task status # Edit "status" field on "task" type`);

// schema edit (no args - prompt for entity type)
editCommand
  .action(async (options: EditCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema edit type|field');
      }

      const entityType = await promptSchemaEntityType('edit');
      if (entityType === null) {
        process.exit(0);
      }

      // Re-invoke the appropriate subcommand
      const args = [entityType];
      await editCommand.parseAsync(args, { from: 'user' });
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

// schema edit type [name]
editCommand
  .command('type [name]')
  .description('Edit a type definition')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string | undefined, options: EditCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

      // Delegate to edit-type implementation
      // For now, show what can be edited and prompt
      if (jsonMode) {
        throw new Error('Interactive edit required. Use specific flags in JSON mode.');
      }

      // Type entry available via schema.raw.types[typeName] if needed
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
          // currentExtends available via typeEntry?.extends if needed
          const availableTypes = getTypeNames(schema).filter(t => t !== typeName && t !== 'meta');
          if (availableTypes.length === 0) {
            printError('No other types available for inheritance');
            continue;
          }
          const options = ['(none)', ...availableTypes];
          const newExtends = await promptSelection('Inherit from', options);
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
          
          const nameError = validateFieldName(fieldName);
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

// schema edit field [type] [name]
editCommand
  .command('field [type] [name]')
  .description('Edit a field definition')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string | undefined, fieldName: string | undefined, options: EditCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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
        throw new Error('Interactive edit required. Use edit-field with specific flags for JSON mode.');
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

// Note: schema edit enum has been removed - use inline options on fields instead

schemaCommand.addCommand(editCommand);

// -------------------- schema delete --------------------

const deleteCommand = new Command('delete')
  .description('Delete a type or field (dry-run by default)')
  .addHelpText('after', `
Examples:
  bwrb schema delete                      # Prompts for what to delete
  bwrb schema delete type                 # Delete a type (shows picker, dry-run)
  bwrb schema delete type project         # Preview deleting "project" type
  bwrb schema delete type project --execute  # Actually delete "project" type
  bwrb schema delete field                # Delete a field (shows pickers)
  bwrb schema delete field task status    # Preview deleting "status" from "task"`);

// schema delete (no args - prompt for entity type)
deleteCommand
  .action(async (options: DeleteCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema delete type|field');
      }

      const entityType = await promptSchemaEntityType('delete');
      if (entityType === null) {
        process.exit(0);
      }

      // Re-invoke the appropriate subcommand
      const args = [entityType];
      await deleteCommand.parseAsync(args, { from: 'user' });
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

// schema delete type [name]
deleteCommand
  .command('type [name]')
  .description('Delete a type (dry-run by default)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('-x, --execute', 'Actually perform the deletion (default is dry-run)')
  .action(async (name: string | undefined, options: DeleteCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const dryRun = !options.execute;

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

// schema delete field [type] [name]
deleteCommand
  .command('field [type] [name]')
  .description('Delete a field from a type (dry-run by default)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('-x, --execute', 'Actually perform the deletion (default is dry-run)')
  .action(async (typeName: string | undefined, fieldName: string | undefined, options: DeleteCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const dryRun = !options.execute;

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

// Note: schema delete enum has been removed - use inline options on fields instead

schemaCommand.addCommand(deleteCommand);

// -------------------- schema list --------------------

const listCommand = new Command('list')
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
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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
      printError(message);
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
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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
      printError(message);
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
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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
      printError(message);
      process.exit(1);
    }
  });

// Note: schema list enums has been removed - use inline options on fields instead

// schema list type <name>
listCommand
  .command('type <name>')
  .description('Show details for a specific type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    // Check both this command's options and parent's options (Commander.js quirk with nested commands)
    const parentListOpts = cmd.parent?.opts() as ListCommandOptions | undefined;
    const jsonMode = options.output === 'json' || parentListOpts?.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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
      printError(message);
      process.exit(1);
    }
  });

// Note: schema list enum has been removed - use inline options on fields instead

schemaCommand.addCommand(listCommand);

// ============================================================================
// Migration Subcommands
// ============================================================================

import { diffSchemas, formatDiffForDisplay, formatDiffForJson } from '../lib/migration/diff.js';
import { loadSchemaSnapshot, saveSchemaSnapshot, hasSchemaSnapshot } from '../lib/migration/snapshot.js';
import { loadMigrationHistory, recordMigration } from '../lib/migration/history.js';
import { executeMigration } from '../lib/migration/execute.js';
import type { MigrationPlan } from '../types/migration.js';

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
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
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
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
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
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
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
    op.op === 'remove-type' || 
    op.op === 'remove-enum-value'
  );
  
  if (hasBreakingChanges) {
    return `${major + 1}.0.0`;
  }
  
  // Check for additions (minor bump)
  const hasAdditions = diff.deterministic.some(op =>
    op.op === 'add-field' ||
    op.op === 'add-type' ||
    op.op === 'add-enum-value'
  );
  
  if (hasAdditions) {
    return `${major}.${minor + 1}.0`;
  }
  
  // Default to patch for renames and other changes
  return `${major}.${minor}.${patch + 1}`;
}

// Note: Enum output helpers have been removed - use inline options on fields instead

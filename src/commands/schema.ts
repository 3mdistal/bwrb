import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
  getEnumValues,
  getTypeNames,
  computeDefaultOutputDir,
  resolveSourceType,
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
import {
  getEnumUsage,
  getEnumNames,
  enumExists,
  addEnum,
  deleteEnum,
  addEnumValue,
  removeEnumValue,
  renameEnumValue,
  validateEnumName,
  validateEnumValue,
} from '../lib/enum-utils.js';
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

type SchemaEntityType = 'type' | 'field' | 'enum';

/**
 * Prompt user to select what kind of schema entity to work with.
 */
async function promptSchemaEntityType(action: string): Promise<SchemaEntityType | null> {
  const result = await promptSelection(`What do you want to ${action}?`, [
    'type',
    'field',
    'enum',
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

/**
 * Prompt for enum selection from available enums.
 */
async function promptEnumPicker(schema: LoadedSchema, message: string = 'Select enum'): Promise<string | null> {
  const enumNames = getEnumNames(schema);
  if (enumNames.length === 0) {
    throw new Error('No enums defined in schema');
  }
  return promptSelection(message, enumNames);
}

interface SchemaShowOptions {
  output?: string;
}

export const schemaCommand = new Command('schema')
  .description('Schema introspection commands')
  .addHelpText('after', `
Examples:
  bwrb schema show              # Show all types
  bwrb schema show objective    # Show objective type details
  bwrb schema show objective/task  # Show task subtype details
  bwrb schema show task --output json  # Show as JSON for AI/scripting
  bwrb schema validate          # Validate schema structure`);

// schema show
schemaCommand
  .command('show [type]')
  .description('Show schema structure (all types or specific type)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string | undefined, options: SchemaShowOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema show', 'schema list');

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        if (typePath) {
          outputTypeDetailsJson(schema, typePath);
        } else {
          outputSchemaJson(schema);
        }
      } else {
        if (typePath) {
          showTypeDetails(schema, typePath);
        } else {
          showSchemaTree(schema);
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

interface AddTypeOptions {
  output?: string;
  extends?: string;
  outputDir?: string;
}

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
    'select (enum)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
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
    5: 'value',
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
    
    // For select, get enum name
    if (promptType === 'select') {
      const enumNames = Array.from(schema.enums.keys());
      if (enumNames.length === 0) {
        printError('No enums defined in schema. Create an enum first with: bwrb schema enum add <name>');
        return promptFieldDefinition(schema);
      }
      const enumResult = await promptSelection('Enum to use', enumNames);
      if (enumResult === null) return null;
      field.enum = enumResult;
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
      
      // Ask for format
      const formatOptions = ['plain', 'wikilink', 'quoted-wikilink'];
      const formatResult = await promptSelection('Link format', formatOptions);
      if (formatResult === null) return null;
      field.format = formatResult as Field['format'];
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

// schema add-type <name>
schemaCommand
  .command('add-type <name>')
  .description('Create a new type definition')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--extends <parent>', 'Parent type to extend')
  .option('--output-dir <dir>', 'Output directory for type files')
  .addHelpText('after', `
Examples:
  # Non-interactive type creation (requires --output-dir):
  bwrb schema add-type book --output-dir Books -o json
  bwrb schema add-type entity --output-dir Entities
  bwrb schema add-type person --extends entity --output-dir Entities/People -o json

  # Interactive mode (prompts for options):
  bwrb schema add-type book`)
  .action(async (name: string, options: AddTypeOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema add-type', 'schema new type');

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Validate type name
      const nameError = validateTypeName(name);
      if (nameError) {
        throw new Error(nameError);
      }
      
      // Load schema to check for conflicts
      const schema = await loadSchema(vaultDir);
      
      // Check if type already exists
      if (schema.types.has(name)) {
        throw new Error(`Type "${name}" already exists`);
      }
      
      // Validate parent type if provided
      let parentType: string | undefined = options.extends;
      if (parentType && !schema.types.has(parentType)) {
        throw new Error(`Parent type "${parentType}" does not exist`);
      }
      
      let outputDir = options.outputDir;
      const fields: Record<string, Field> = {};
      const fieldOrder: string[] = [];
      
      // Interactive mode if not JSON
      if (!jsonMode) {
        // Prompt for parent type if not provided
        if (!parentType) {
          const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
          if (typeNames.length > 0) {
            console.log('');
            const parentResult = await promptInput('Extend from type? (blank for none)');
            if (parentResult === null) {
              process.exit(0); // User cancelled
            }
            if (parentResult.trim()) {
              parentType = parentResult.trim();
              if (!schema.types.has(parentType)) {
                throw new Error(`Parent type "${parentType}" does not exist`);
              }
            }
          }
        }
        
        // Prompt for output directory if not provided
        if (!outputDir) {
          // Compute default based on type hierarchy
          const defaultDir = computeDefaultOutputDir(schema, name);
          const dirResult = await promptInput('Output directory', defaultDir);
          if (dirResult === null) {
            process.exit(0);
          }
          outputDir = dirResult.trim() || defaultDir;
        }
        
        // Ask if user wants to add fields now
        const addFieldsResult = await promptConfirm('Add fields now?');
        if (addFieldsResult === null) {
          process.exit(0);
        }
        
        if (addFieldsResult) {
          // Field wizard loop
          while (true) {
            const fieldResult = await promptFieldDefinition(schema);
            if (fieldResult === null) {
              process.exit(0); // User cancelled
            }
            if (fieldResult === 'done') {
              break;
            }
            fields[fieldResult.name] = fieldResult.field;
            fieldOrder.push(fieldResult.name);
            printSuccess(`Added field: ${fieldResult.name}`);
          }
        }
      }
      
      // Build the new type definition
      const newType: Type = {};
      
      if (parentType) {
        newType.extends = parentType;
      }
      
      if (outputDir) {
        newType.output_dir = outputDir;
      }
      
      if (Object.keys(fields).length > 0) {
        newType.fields = fields;
        if (fieldOrder.length > 0) {
          newType.field_order = fieldOrder;
        }
      }
      
      // Load raw schema and add the type
      const rawSchema = await loadRawSchemaJson(vaultDir);
      rawSchema.types[name] = newType;
      
      // Write the updated schema
      await writeSchema(vaultDir, rawSchema);
      
      // Validate the result by loading the schema again
      await loadSchema(vaultDir);
      
      // Output result
      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Created type "${name}"`,
          data: {
            name,
            extends: parentType,
            output_dir: outputDir,
            fields: Object.keys(fields),
          },
        }));
      } else {
        console.log('');
        printSuccess(`Created type "${name}"`);
        if (parentType) {
          console.log(`  Extends: ${parentType}`);
        }
        if (outputDir) {
          console.log(`  Directory: ${outputDir}/`);
        }
        if (Object.keys(fields).length > 0) {
          console.log(`  Fields: ${Object.keys(fields).join(', ')}`);
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

// ============================================================================
// Field Management Subcommands
// ============================================================================

interface AddFieldOptions {
  output?: string;
  type?: string;        // prompt type
  enum?: string;        // for select
  source?: string;      // for dynamic
  value?: string;       // for fixed value
  format?: string;      // for dynamic
  required?: boolean;
  default?: string;
}

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
 * Build a field definition from CLI options.
 */
function buildFieldFromOptions(
  options: AddFieldOptions,
  schema: LoadedSchema
): Field {
  const field: Field = {};
  const promptType = options.type;

  if (promptType === 'fixed') {
    // Fixed value field
    if (!options.value) {
      throw new Error('--value is required for fixed type');
    }
    field.value = options.value;
  } else if (promptType) {
    // Validate prompt type
    const validPromptTypes = ['text', 'select', 'date', 'list', 'relation'];
    if (!validPromptTypes.includes(promptType)) {
      throw new Error(`Invalid prompt type "${promptType}". Valid types: text, select, date, list, relation, fixed`);
    }
    
    field.prompt = promptType as Field['prompt'];
    
    // Handle select type
    if (promptType === 'select') {
      if (!options.enum) {
        throw new Error('--enum is required for select type');
      }
      if (!enumExists(schema, options.enum)) {
        throw new Error(`Enum "${options.enum}" does not exist`);
      }
      field.enum = options.enum;
    }
    
    // Handle dynamic type
    if (promptType === 'relation') {
      if (!options.source) {
        throw new Error('--source is required for dynamic type');
      }
      
      // Use resolveSourceType for better error messages
      const resolution = resolveSourceType(schema, options.source);
      if (!resolution.success) {
        throw new Error(resolution.error);
      }
      field.source = resolution.typeName;
      
      // Format is optional, default to plain
      if (options.format) {
        const validFormats = ['plain', 'wikilink', 'quoted-wikilink'];
        if (!validFormats.includes(options.format)) {
          throw new Error(`Invalid format "${options.format}". Valid formats: plain, wikilink, quoted-wikilink`);
        }
        field.format = options.format as Field['format'];
      }
    }
    
    // Handle required flag
    if (options.required) {
      field.required = true;
    }
    
    // Handle default value
    if (options.default !== undefined) {
      field.default = options.default;
    }
  }
  
  return field;
}

/**
 * Prompt for a single field definition interactively (for add-field command).
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
    'select (enum)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
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
    5: 'value',
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
    
    // For select, get enum name
    if (promptType === 'select') {
      const enumNames = Array.from(schema.enums.keys());
      if (enumNames.length === 0) {
        throw new Error('No enums defined in schema. Create an enum first with: bwrb schema enum add <name>');
      }
      const enumResult = await promptSelection('Enum to use', enumNames);
      if (enumResult === null) return null;
      field.enum = enumResult;
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
      
      // Ask for format
      const formatOptions = ['plain', 'wikilink', 'quoted-wikilink'];
      const formatResult = await promptSelection('Link format', formatOptions);
      if (formatResult === null) return null;
      field.format = formatResult as Field['format'];
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

// schema add-field <type-name> [field-name]
schemaCommand
  .command('add-field <type-name> [field-name]')
  .description('Add a field to an existing type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--type <prompt-type>', 'Prompt type: input, select, date, list, dynamic, fixed')
  .option('--enum <name>', 'Enum name (for select type)')
  .option('--source <type>', 'Source type (for dynamic type)')
  .option('--value <value>', 'Fixed value (for fixed type)')
  .option('--format <format>', 'Link format: plain, wikilink, quoted-wikilink (for dynamic)')
  .option('--required', 'Mark field as required')
  .option('--default <value>', 'Default value')
  .addHelpText('after', `
Examples:
  # Non-interactive field creation (requires --type flag):
  bwrb schema add-field book title --type input --required -o json
  bwrb schema add-field book status --type select --enum status -o json
  bwrb schema add-field book author --type dynamic --source person --format wikilink -o json
  bwrb schema add-field book edition --type fixed --value "1st" -o json
  bwrb schema add-field book published --type date -o json
  bwrb schema add-field book tags --type list -o json

  # Interactive mode (prompts for field definition):
  bwrb schema add-field book title`)
  .action(async (typeName: string, fieldName: string | undefined, options: AddFieldOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema add-field', 'schema new field');

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Load schema
      const schema = await loadSchema(vaultDir);
      
      // Validate type exists
      if (!schema.types.has(typeName)) {
        throw new Error(`Type "${typeName}" does not exist`);
      }
      
      // If field name is provided, validate it early (before interactive mode)
      if (fieldName) {
        // Validate field name format
        const nameError = validateFieldName(fieldName);
        if (nameError) {
          throw new Error(nameError);
        }
        
        // Check if field already exists on this type (including inherited fields)
        const effectiveFields = getFieldsForType(schema, typeName);
        if (effectiveFields[fieldName]) {
          // Check if it's inherited or defined on this type
          const rawType = schema.raw.types[typeName];
          const isOwnField = rawType?.fields?.[fieldName] !== undefined;
          if (isOwnField) {
            throw new Error(`Field "${fieldName}" already exists on type "${typeName}"`);
          } else {
            throw new Error(`Field "${fieldName}" is inherited from a parent type. To override it, edit the parent type instead.`);
          }
        }
      }
      
      let name: string;
      let field: Field;
      
      // Check if we have enough options for non-interactive mode
      const hasTypeOption = options.type !== undefined;
      
      if (jsonMode || (fieldName && hasTypeOption)) {
        // Non-interactive mode
        if (!fieldName) {
          throw new Error('Field name is required in JSON mode');
        }
        
        if (!hasTypeOption) {
          throw new Error('--type is required in JSON mode');
        }
        
        name = fieldName;
        field = buildFieldFromOptions(options, schema);
      } else {
        // Interactive mode
        const result = await promptSingleFieldDefinition(schema, fieldName);
        if (result === null) {
          process.exit(0); // User cancelled
        }
        name = result.name;
        field = result.field;
      }
      
      // Check if field already exists (only needed if name came from interactive mode)
      if (!fieldName) {
        const effectiveFields = getFieldsForType(schema, typeName);
        if (effectiveFields[name]) {
          // Check if it's inherited or defined on this type
          const rawType = schema.raw.types[typeName];
          const isOwnField = rawType?.fields?.[name] !== undefined;
          if (isOwnField) {
            throw new Error(`Field "${name}" already exists on type "${typeName}"`);
          } else {
            throw new Error(`Field "${name}" is inherited from a parent type. To override it, edit the parent type instead.`);
          }
        }
      }
      
      // Load raw schema and add the field
      const rawSchema = await loadRawSchemaJson(vaultDir);
      
      // Get the type definition, creating it if this is an implicit type (like meta)
      // The type exists in the resolved schema (validated above) but may not exist
      // in the raw schema if it's implicit (e.g., meta is created implicitly if not defined)
      let typeDef = rawSchema.types[typeName];
      if (!typeDef) {
        // Create an empty type definition for the implicit type
        rawSchema.types[typeName] = {};
        typeDef = rawSchema.types[typeName];
      }
      
      // Ensure the type has a fields object
      if (!typeDef.fields) {
        typeDef.fields = {};
      }
      typeDef.fields[name] = field;
      
      // Update field_order if it exists, or create it
      if (typeDef.field_order) {
        typeDef.field_order.push(name);
      } else {
        // Only create field_order if there are multiple fields now
        const existingFields = Object.keys(typeDef.fields);
        if (existingFields.length > 1) {
          typeDef.field_order = existingFields;
        }
      }
      
      // Write the updated schema
      await writeSchema(vaultDir, rawSchema);
      
      // Validate the result by loading the schema again
      await loadSchema(vaultDir);
      
      // Check if adding to meta (affects all types)
      const isMetaType = typeName === 'meta';
      const childCount = schema.types.get(typeName)?.children.length ?? 0;
      
      // Output result
      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Added field "${name}" to type "${typeName}"`,
          data: {
            type: typeName,
            field: name,
            definition: field,
            affectsChildTypes: childCount > 0,
          },
        }));
      } else {
        console.log('');
        printSuccess(`Added field "${name}" to type "${typeName}"`);
        
        // Show field details
        const fieldTypeStr = field.value !== undefined 
          ? 'fixed value' 
          : field.prompt ?? 'auto';
        console.log(`  Type: ${fieldTypeStr}`);
        
        if (field.enum) {
          console.log(`  Enum: ${field.enum}`);
        }
        if (field.source) {
          console.log(`  Source: ${field.source}`);
        }
        if (field.format) {
          console.log(`  Format: ${field.format}`);
        }
        if (field.required) {
          console.log(`  Required: yes`);
        }
        if (field.default !== undefined) {
          console.log(`  Default: ${field.default}`);
        }
        if (field.value !== undefined) {
          console.log(`  Value: ${field.value}`);
        }
        
        // Show inheritance note
        if (isMetaType) {
          console.log('');
          console.log(chalk.yellow('Note: Adding to "meta" affects all types in the schema.'));
        } else if (childCount > 0) {
          console.log('');
          console.log(chalk.gray(`This field will be inherited by ${childCount} child type${childCount > 1 ? 's' : ''}.`));
        }
        
        // Hint about updating existing notes
        console.log('');
        console.log(chalk.gray(`Run 'bwrb audit' to check existing notes for this field.`));
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

// schema remove-type
schemaCommand
  .command('remove-type <type>')
  .description('Remove a type from the schema (dry-run by default)')
  .option('--execute', 'Actually apply the removal (default is dry-run)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string, options: { execute?: boolean; output?: string }, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema remove-type', 'schema delete type');

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

      // Don't allow removing meta
      if (typeName === 'meta') {
        const msg = 'Cannot remove the meta type';
        if (jsonMode) {
          printJson(jsonError(msg));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(msg);
        process.exit(1);
      }

      // Check if type has children
      const children = getTypeNames(schema).filter(t => {
        const def = rawSchema.types[t];
        return def?.extends === typeName;
      });

      if (children.length > 0) {
        const msg = `Cannot remove type '${typeName}': it has child types (${children.join(', ')}). Remove or reparent them first.`;
        if (jsonMode) {
          printJson(jsonError(msg));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(msg);
        process.exit(1);
      }

      // Count affected files using discovery
      const { discoverManagedFiles } = await import('../lib/discovery.js');
      const managedFiles = await discoverManagedFiles(schema, vaultDir, typeName);
      const affectedCount = managedFiles.length;

      // Show what would happen
      if (!options.execute) {
        if (jsonMode) {
          console.log(JSON.stringify({
            success: true,
            dryRun: true,
            type: typeName,
            affectedFiles: affectedCount,
            message: affectedCount > 0
              ? `Would remove type '${typeName}' affecting ${affectedCount} file(s)`
              : `Would remove type '${typeName}' (no files affected)`,
          }, null, 2));
        } else {
          console.log(chalk.bold('Dry run - no changes made'));
          console.log('');
          console.log(`Type to remove: ${chalk.cyan(typeName)}`);
          console.log(`Files affected: ${affectedCount > 0 ? chalk.yellow(String(affectedCount)) : chalk.green('0')}`);
          
          if (affectedCount > 0) {
            console.log('');
            console.log(chalk.yellow(`Warning: ${affectedCount} file(s) currently use this type.`));
            console.log(chalk.yellow('These files will become untyped after removal.'));
          }
          
          console.log('');
          
          // Prompt for confirmation
          const confirmed = await promptConfirm('Apply this change?');
          if (confirmed === null) {
            process.exit(0); // User cancelled
          }
          if (confirmed) {
            // Apply the removal
            delete rawSchema.types[typeName];
            await writeSchema(vaultDir, rawSchema);
            printSuccess(`Removed type '${typeName}'`);
            if (affectedCount > 0) {
              console.log(chalk.gray(`Run 'bwrb audit' to review affected files.`));
            }
          } else {
            console.log(chalk.gray('No changes made.'));
          }
        }
        return;
      }

      // Execute mode - apply the removal
      delete rawSchema.types[typeName];
      await writeSchema(vaultDir, rawSchema);

      if (jsonMode) {
        printJson(jsonSuccess({ message: `Removed type '${typeName}'` }));
      } else {
        printSuccess(`Removed type '${typeName}'`);
        if (affectedCount > 0) {
          console.log(chalk.gray(`Run 'bwrb audit' to review ${affectedCount} affected file(s).`));
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
        if (fieldDef.enum) fieldInfo.push(`enum: ${fieldDef.enum}`);
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

// schema remove-field
schemaCommand
  .command('remove-field <type> <field>')
  .description('Remove a field from a type (dry-run by default)')
  .option('--execute', 'Actually apply the removal (default is dry-run)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typeName: string, fieldName: string, options: { execute?: boolean; output?: string }, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema remove-field', 'schema delete field');

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
          const msg = `Field '${fieldName}' is inherited and cannot be removed from '${typeName}'. Remove it from the parent type instead.`;
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

      // Count affected files - files of this type and all descendant types
      const { discoverManagedFiles } = await import('../lib/discovery.js');
      const managedFiles = await discoverManagedFiles(schema, vaultDir, typeName);
      const affectedCount = managedFiles.length;

      // Check if field is inherited by children
      const childTypes = getTypeNames(schema).filter(t => {
        const def = schema.raw.types[t];
        return def?.extends === typeName;
      });
      const descendantCount = childTypes.length;

      // Show what would happen
      if (!options.execute) {
        if (jsonMode) {
          console.log(JSON.stringify({
            success: true,
            dryRun: true,
            type: typeName,
            field: fieldName,
            affectedFiles: affectedCount,
            childTypes: childTypes.length > 0 ? childTypes : undefined,
            message: `Would remove field '${fieldName}' from type '${typeName}'`,
          }, null, 2));
        } else {
          console.log(chalk.bold('Dry run - no changes made'));
          console.log('');
          console.log(`Field to remove: ${chalk.cyan(`${typeName}.${fieldName}`)}`);
          console.log(`Files of this type: ${affectedCount > 0 ? chalk.yellow(String(affectedCount)) : chalk.green('0')}`);
          
          if (descendantCount > 0) {
            console.log(`Child types affected: ${chalk.yellow(String(descendantCount))} (${childTypes.join(', ')})`);
          }
          
          if (affectedCount > 0) {
            console.log('');
            console.log(chalk.yellow(`Warning: ${affectedCount} file(s) may have this field in their frontmatter.`));
            console.log(chalk.yellow('The field data will remain in files but become unrecognized.'));
          }
          
          console.log('');
          
          // Prompt for confirmation
          const confirmed = await promptConfirm('Apply this change?');
          if (confirmed === null) {
            process.exit(0); // User cancelled
          }
          if (confirmed) {
            // Apply the removal
            delete ownFields[fieldName];
            typeEntry.fields = ownFields;
            
            // Also remove from field_order if present
            if (typeEntry.field_order) {
              typeEntry.field_order = typeEntry.field_order.filter(f => f !== fieldName);
            }
            
            await writeSchema(vaultDir, schema.raw);
            printSuccess(`Removed field '${fieldName}' from type '${typeName}'`);
            if (affectedCount > 0) {
              console.log(chalk.gray(`Run 'bwrb audit' to review affected files.`));
            }
          } else {
            console.log(chalk.gray('No changes made.'));
          }
        }
        return;
      }

      // Execute mode - apply the removal
      delete ownFields[fieldName];
      typeEntry.fields = ownFields;
      
      // Also remove from field_order if present
      if (typeEntry.field_order) {
        typeEntry.field_order = typeEntry.field_order.filter(f => f !== fieldName);
      }
      
      await writeSchema(vaultDir, schema.raw);

      if (jsonMode) {
        printJson(jsonSuccess({ message: `Removed field '${fieldName}' from type '${typeName}'` }));
      } else {
        printSuccess(`Removed field '${fieldName}' from type '${typeName}'`);
        if (affectedCount > 0) {
          console.log(chalk.gray(`Run 'bwrb audit' to review ${affectedCount} affected file(s).`));
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
    enums: raw.enums ?? {},
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
        formatFieldForJson(schema, field),
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
        formatFieldForJson(schema, field),
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
        formatFieldForJson(schema, field),
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
 * Format a field for JSON output with resolved enum values.
 */
function formatFieldForJson(schema: LoadedSchema, field: Field): Record<string, unknown> {
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

  // Add enum values if applicable
  if (field.enum) {
    result.enum = field.enum;
    result.values = getEnumValues(schema, field.enum);
  }

  // Add other properties
  if (field.required) result.required = true;
  if (field.default !== undefined) result.default = field.default;
  if (field.label) result.label = field.label;
  if (field.source) result.source = field.source;
  if (field.format) result.format = field.format;
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

  const raw = schema.raw;
  
  // Show enums if any
  if (raw.enums && Object.keys(raw.enums).length > 0) {
    console.log(chalk.cyan('Enums:'));
    for (const [name, values] of Object.entries(raw.enums)) {
      console.log(`  ${chalk.yellow(name)}: ${values.join(', ')}`);
    }
    console.log('');
  }

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
      printFieldDetails(schema, name, ownFields[name]!, '    ');
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
          printFieldDetails(schema, name, ancestorFields[name]!, '    ');
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
  schema: LoadedSchema,
  name: string,
  field: Field,
  indent: string
): void {
  const type = getFieldType(field);
  let line = `${indent}${chalk.yellow(name)}: ${type}`;

  // Show enum values if applicable
  if (field.enum) {
    const values = getEnumValues(schema, field.enum);
    if (values.length > 0) {
      line += chalk.gray(` (${values.slice(0, 5).join(', ')}${values.length > 5 ? '...' : ''})`);
    }
  }

  // Show format for dynamic fields
  if (field.prompt === 'relation' && field.format) {
    line += chalk.gray(` format=${field.format}`);
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
      return field.enum ? chalk.blue(`enum:${field.enum}`) : chalk.blue('select');
    case 'list':
      return chalk.blue('list');
    case 'text':
      return chalk.blue('text');
    case 'date':
      return chalk.blue('date');
    case 'relation':
      return field.source ? chalk.blue(`relation:${field.source}`) : chalk.blue('relation');
    default:
      return chalk.gray('auto');
  }
}

// ============================================================================
// Enum Subcommands
// ============================================================================

interface EnumCommandOptions {
  output?: string;
  values?: string;
  add?: string;
  remove?: string;
  rename?: string;
  force?: boolean;
}

const enumCommand = new Command('enum')
  .description('Manage enum definitions')
  .addHelpText('after', `
Examples:
  bwrb schema enum list              # Show all enums
  bwrb schema enum add status        # Create enum (prompts for values)
  bwrb schema enum add status --values "raw,active,done"
  bwrb schema enum update status --add archived
  bwrb schema enum update status --remove raw
  bwrb schema enum update status --rename active=in-progress
  bwrb schema enum delete old-status
  bwrb schema enum delete unused --force  # Delete even if in use`);

// schema enum list
enumCommand
  .command('list')
  .description('Show all enums with their values and usage')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: EnumCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema enum list', 'schema list enums');

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        outputEnumListJson(schema);
      } else {
        outputEnumListText(schema);
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

// schema enum add <name>
enumCommand
  .command('add <name>')
  .description('Create a new enum')
  .option('--values <values>', 'Comma-separated values')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: EnumCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema enum add', 'schema new enum');

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Validate name
      const nameError = validateEnumName(name);
      if (nameError) {
        throw new Error(nameError);
      }
      
      // Check if exists
      const schema = await loadSchema(vaultDir);
      if (enumExists(schema, name)) {
        throw new Error(`Enum "${name}" already exists`);
      }
      
      // Get values from flag or prompt
      let values: string[];
      if (options.values) {
        values = options.values.split(',').map(v => v.trim()).filter(Boolean);
      } else {
        if (jsonMode) {
          throw new Error('--values flag is required in JSON mode');
        }
        const prompted = await promptMultiInput(`Enter values for enum "${name}"`);
        if (prompted === null) {
          process.exit(0); // User cancelled
        }
        values = prompted;
      }
      
      if (values.length === 0) {
        throw new Error('Enum must have at least one value');
      }
      
      // Validate values
      for (const value of values) {
        const valueError = validateEnumValue(value);
        if (valueError) {
          throw new Error(`Invalid value "${value}": ${valueError}`);
        }
      }
      
      // Add enum
      let rawSchema = await loadRawSchemaJson(vaultDir);
      rawSchema = addEnum(rawSchema, name, values);
      await writeSchema(vaultDir, rawSchema);
      
      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Created enum "${name}"`,
          data: { name, values },
        }));
      } else {
        printSuccess(`Created enum "${name}" with values: ${values.join(', ')}`);
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

// schema enum update <name>
enumCommand
  .command('update <name>')
  .description('Update an enum (add/remove/rename values)')
  .option('--add <value>', 'Add a value')
  .option('--remove <value>', 'Remove a value')
  .option('--rename <old>=<new>', 'Rename a value')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: EnumCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema enum update', 'schema edit enum');

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Check if enum exists
      const schema = await loadSchema(vaultDir);
      if (!enumExists(schema, name)) {
        throw new Error(`Enum "${name}" does not exist`);
      }
      
      // Require exactly one operation
      const ops = [options.add, options.remove, options.rename].filter(Boolean);
      if (ops.length === 0) {
        throw new Error('Specify one of: --add, --remove, or --rename');
      }
      if (ops.length > 1) {
        throw new Error('Specify only one of: --add, --remove, or --rename');
      }
      
      let rawSchema = await loadRawSchemaJson(vaultDir);
      let message: string;
      
      if (options.add) {
        const valueError = validateEnumValue(options.add);
        if (valueError) {
          throw new Error(valueError);
        }
        rawSchema = addEnumValue(rawSchema, name, options.add);
        message = `Added "${options.add}" to enum "${name}"`;
      } else if (options.remove) {
        rawSchema = removeEnumValue(rawSchema, name, options.remove);
        message = `Removed "${options.remove}" from enum "${name}"`;
        
        // Warn about notes that may have this value
        if (!jsonMode) {
          console.log(chalk.yellow(`\nNote: Existing notes with ${name}: ${options.remove} are now invalid.`));
          console.log(chalk.yellow(`Run \`bwrb audit --fix\` to update affected notes.`));
        }
      } else if (options.rename) {
        // Parse old=new format (split on first = only)
        const eqIndex = options.rename.indexOf('=');
        if (eqIndex === -1) {
          throw new Error('--rename format must be: old=new');
        }
        const oldValue = options.rename.slice(0, eqIndex);
        const newValue = options.rename.slice(eqIndex + 1);
        
        if (!oldValue || !newValue) {
          throw new Error('--rename format must be: old=new');
        }
        
        const valueError = validateEnumValue(newValue);
        if (valueError) {
          throw new Error(`Invalid new value: ${valueError}`);
        }
        
        rawSchema = renameEnumValue(rawSchema, name, oldValue, newValue);
        message = `Renamed "${oldValue}" to "${newValue}" in enum "${name}"`;
        
        // Warn about notes that need updating
        if (!jsonMode) {
          console.log(chalk.yellow(`\nNote: Existing notes with ${name}: ${oldValue} need to be updated.`));
          console.log(chalk.yellow(`Run: bwrb bulk --set ${name}=${newValue} --where "${name}=${oldValue}" --execute`));
        }
      } else {
        throw new Error('Unexpected state');
      }
      
      await writeSchema(vaultDir, rawSchema);
      
      // Get updated values for output
      const updatedSchema = await loadRawSchemaJson(vaultDir);
      const updatedValues = updatedSchema.enums?.[name] ?? [];
      
      if (jsonMode) {
        printJson(jsonSuccess({
          message,
          data: { name, values: updatedValues },
        }));
      } else {
        printSuccess(message);
        console.log(`Values: ${updatedValues.join(', ')}`);
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

// schema enum delete <name>
enumCommand
  .command('delete <name>')
  .description('Delete an enum')
  .option('--force', 'Delete even if in use (dangerous)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: EnumCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    warnDeprecated('schema enum delete', 'schema delete enum');

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Check if enum exists
      const schema = await loadSchema(vaultDir);
      if (!enumExists(schema, name)) {
        throw new Error(`Enum "${name}" does not exist`);
      }
      
      // Check if in use
      const usages = getEnumUsage(schema, name);
      if (usages.length > 0 && !options.force) {
        const usageList = usages.map(u => `${u.typeName}.${u.fieldName}`).join(', ');
        throw new Error(
          `Cannot delete enum "${name}" - used by: ${usageList}\n` +
          `To delete anyway: bwrb schema enum delete ${name} --force`
        );
      }
      
      let rawSchema = await loadRawSchemaJson(vaultDir);
      rawSchema = deleteEnum(rawSchema, name);
      await writeSchema(vaultDir, rawSchema);
      
      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Deleted enum "${name}"`,
          data: { name, wasInUse: usages.length > 0 },
        }));
      } else {
        printSuccess(`Deleted enum "${name}"`);
        if (usages.length > 0) {
          console.log(chalk.yellow(`\nWarning: This enum was in use by:`));
          for (const usage of usages) {
            console.log(chalk.yellow(`  • ${usage.typeName}.${usage.fieldName}`));
          }
          console.log(chalk.yellow(`\nRun \`bwrb audit\` to find affected notes.`));
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

// Add enum command to schema command
schemaCommand.addCommand(enumCommand);

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
  .description('Create a new type, field, or enum')
  .addHelpText('after', `
Examples:
  bwrb schema new                    # Prompts for what to create
  bwrb schema new type               # Create a new type
  bwrb schema new type project       # Create type named "project"
  bwrb schema new field              # Create a field (prompts for type)
  bwrb schema new field task status  # Add "status" field to "task" type
  bwrb schema new enum               # Create a new enum
  bwrb schema new enum priority      # Create enum named "priority"`);

// schema new (no args - prompt for entity type)
newCommand
  .action(async (options: NewCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema new type|field|enum');
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
          const promptType = fieldType as 'text' | 'select' | 'date' | 'relation';
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

// schema new enum [name]
newCommand
  .command('enum [name]')
  .description('Create a new enum')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--values <values>', 'Comma-separated values')
  .action(async (name: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});

      // Get name if not provided
      let enumName = name;
      if (!enumName) {
        if (jsonMode) {
          throw new Error('Enum name is required in JSON mode');
        }
        const result = await promptInput('Enum name');
        if (result === null) {
          process.exit(0);
        }
        enumName = result;
      }

      // Validate name
      const nameError = validateEnumName(enumName);
      if (nameError) {
        throw new Error(nameError);
      }

      // Check if exists
      const schema = await loadSchema(vaultDir);
      if (enumExists(schema, enumName)) {
        throw new Error(`Enum "${enumName}" already exists`);
      }

      // Get values from flag or prompt
      let values: string[];
      if (options.values) {
        values = options.values.split(',').map(v => v.trim()).filter(Boolean);
      } else {
        if (jsonMode) {
          throw new Error('--values flag is required in JSON mode');
        }
        const prompted = await promptMultiInput(`Enter values for enum "${enumName}"`);
        if (prompted === null) {
          process.exit(0);
        }
        values = prompted;
      }

      // Validate values
      for (const value of values) {
        const valueError = validateEnumValue(value);
        if (valueError) {
          throw new Error(`Invalid value "${value}": ${valueError}`);
        }
      }

      if (values.length === 0) {
        throw new Error('Enum must have at least one value');
      }

      // Add to schema
      const rawSchema = await loadRawSchemaJson(vaultDir);
      const updatedSchema = addEnum(rawSchema, enumName, values);
      await writeSchema(vaultDir, updatedSchema);

      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Enum "${enumName}" created with ${values.length} values`,
          data: { name: enumName, values },
        }));
      } else {
        printSuccess(`Enum "${enumName}" created with values: ${values.join(', ')}`);
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

schemaCommand.addCommand(newCommand);

// -------------------- schema edit --------------------

const editCommand = new Command('edit')
  .description('Edit an existing type, field, or enum')
  .addHelpText('after', `
Examples:
  bwrb schema edit                   # Prompts for what to edit
  bwrb schema edit type              # Edit a type (shows picker)
  bwrb schema edit type task         # Edit the "task" type
  bwrb schema edit field             # Edit a field (shows pickers)
  bwrb schema edit field task status # Edit "status" field on "task" type
  bwrb schema edit enum              # Edit an enum (shows picker)
  bwrb schema edit enum priority     # Edit the "priority" enum`);

// schema edit (no args - prompt for entity type)
editCommand
  .action(async (options: EditCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema edit type|field|enum');
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
          const promptOptions = ['text', 'select', 'list', 'date', 'relation'];
          const newPrompt = await promptSelection('Prompt type', promptOptions);
          const fieldEntry = rawTypeEntry.fields?.[fieldName];
          if (newPrompt !== null && fieldEntry) {
            fieldEntry.prompt = newPrompt as Field['prompt'];
            
            // If select type, prompt for enum name
            if (newPrompt === 'select') {
              const reloadedSchema = await loadSchema(vaultDir);
              const enumNames = getEnumNames(reloadedSchema);
              if (enumNames.length > 0) {
                const enumChoice = await promptSelection('Select enum (or skip)', ['(none)', ...enumNames]);
                if (enumChoice !== null && enumChoice !== '(none)') {
                  fieldEntry.enum = enumChoice;
                }
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

// schema edit enum [name]
editCommand
  .command('enum [name]')
  .description('Edit an enum definition')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--add <value>', 'Add a value to the enum')
  .option('--remove <value>', 'Remove a value from the enum')
  .option('--rename <old=new>', 'Rename a value (format: old=new)')
  .action(async (name: string | undefined, options: { output?: string; add?: string; remove?: string; rename?: string }, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Get enum name if not provided
      let enumName = name;
      if (!enumName) {
        if (jsonMode) {
          throw new Error('Enum name is required in JSON mode');
        }
        const result = await promptEnumPicker(schema, 'Select enum to edit');
        if (result === null) {
          process.exit(0);
        }
        enumName = result;
      }

      // Validate enum exists
      if (!enumExists(schema, enumName)) {
        throw new Error(`Enum "${enumName}" does not exist`);
      }

      // Handle flag-based operations
      if (options.add || options.remove || options.rename) {
        const rawSchema = await loadRawSchemaJson(vaultDir);
        
        if (options.add) {
          const valueError = validateEnumValue(options.add);
          if (valueError) {
            throw new Error(valueError);
          }
          const updatedSchema = addEnumValue(rawSchema, enumName, options.add);
          await writeSchema(vaultDir, updatedSchema);
          
          if (jsonMode) {
            printJson(jsonSuccess({
              message: `Value "${options.add}" added to enum "${enumName}"`,
              data: { enum: enumName, added: options.add },
            }));
          } else {
            printSuccess(`Value "${options.add}" added to enum "${enumName}"`);
          }
          return;
        }

        if (options.remove) {
          const updatedSchema = removeEnumValue(rawSchema, enumName, options.remove);
          await writeSchema(vaultDir, updatedSchema);
          
          if (jsonMode) {
            printJson(jsonSuccess({
              message: `Value "${options.remove}" removed from enum "${enumName}"`,
              data: { enum: enumName, removed: options.remove },
            }));
          } else {
            printSuccess(`Value "${options.remove}" removed from enum "${enumName}"`);
          }
          return;
        }

        if (options.rename) {
          const [oldValue, newValue] = options.rename.split('=');
          if (!oldValue || !newValue) {
            throw new Error('Rename format must be "old=new"');
          }
          const updatedSchema = renameEnumValue(rawSchema, enumName, oldValue, newValue);
          await writeSchema(vaultDir, updatedSchema);
          
          if (jsonMode) {
            printJson(jsonSuccess({
              message: `Value "${oldValue}" renamed to "${newValue}" in enum "${enumName}"`,
              data: { enum: enumName, renamed: { from: oldValue, to: newValue } },
            }));
          } else {
            printSuccess(`Value "${oldValue}" renamed to "${newValue}" in enum "${enumName}"`);
          }
          return;
        }
      }

      // Interactive mode
      if (jsonMode) {
        throw new Error('Interactive edit required. Use --add, --remove, or --rename flags in JSON mode.');
      }

      const currentValues = getEnumValues(schema, enumName);
      console.log(chalk.bold(`\nEditing enum: ${enumName}\n`));
      console.log(`Current values: ${currentValues.join(', ')}`);

      const editOptions = ['Add value', 'Remove value', 'Rename value', 'Done'];
      
      while (true) {
        const choice = await promptSelection('What would you like to do?', editOptions);
        if (choice === null || choice === 'Done') {
          break;
        }

        const rawSchema = await loadRawSchemaJson(vaultDir);

        if (choice === 'Add value') {
          const newValue = await promptInput('New value');
          if (newValue !== null) {
            const valueError = validateEnumValue(newValue);
            if (valueError) {
              printError(valueError);
              continue;
            }
            addEnumValue(rawSchema, enumName, newValue);
            await writeSchema(vaultDir, rawSchema);
            printSuccess(`Value "${newValue}" added`);
          }
        } else if (choice === 'Remove value') {
          const reloadedSchema = await loadSchema(vaultDir);
          const values = getEnumValues(reloadedSchema, enumName);
          const toRemove = await promptSelection('Value to remove', values);
          if (toRemove !== null) {
            removeEnumValue(rawSchema, enumName, toRemove);
            await writeSchema(vaultDir, rawSchema);
            printSuccess(`Value "${toRemove}" removed`);
          }
        } else if (choice === 'Rename value') {
          const reloadedSchema = await loadSchema(vaultDir);
          const values = getEnumValues(reloadedSchema, enumName);
          const oldValue = await promptSelection('Value to rename', values);
          if (oldValue !== null) {
            const newValue = await promptInput('New name', oldValue);
            if (newValue !== null && newValue !== oldValue) {
              renameEnumValue(rawSchema, enumName, oldValue, newValue);
              await writeSchema(vaultDir, rawSchema);
              printSuccess(`Value "${oldValue}" renamed to "${newValue}"`);
            }
          }
        }
      }

      printSuccess(`Finished editing enum "${enumName}"`);
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

schemaCommand.addCommand(editCommand);

// -------------------- schema delete --------------------

const deleteCommand = new Command('delete')
  .description('Delete a type, field, or enum (dry-run by default)')
  .addHelpText('after', `
Examples:
  bwrb schema delete                      # Prompts for what to delete
  bwrb schema delete type                 # Delete a type (shows picker, dry-run)
  bwrb schema delete type project         # Preview deleting "project" type
  bwrb schema delete type project --execute  # Actually delete "project" type
  bwrb schema delete field                # Delete a field (shows pickers)
  bwrb schema delete field task status    # Preview deleting "status" from "task"
  bwrb schema delete enum                 # Delete an enum (shows picker)
  bwrb schema delete enum priority --execute  # Actually delete "priority" enum`);

// schema delete (no args - prompt for entity type)
deleteCommand
  .action(async (options: DeleteCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema delete type|field|enum');
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
  .option('--execute', 'Actually perform the deletion (default is dry-run)')
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
  .option('--execute', 'Actually perform the deletion (default is dry-run)')
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

// schema delete enum [name]
deleteCommand
  .command('enum [name]')
  .description('Delete an enum (dry-run by default)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--execute', 'Actually perform the deletion (default is dry-run)')
  .action(async (name: string | undefined, options: DeleteCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const dryRun = !options.execute;

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Get enum name if not provided
      let enumName = name;
      if (!enumName) {
        if (jsonMode) {
          throw new Error('Enum name is required in JSON mode');
        }
        const result = await promptEnumPicker(schema, 'Select enum to delete');
        if (result === null) {
          process.exit(0);
        }
        enumName = result;
      }

      // Validate enum exists
      if (!enumExists(schema, enumName)) {
        throw new Error(`Enum "${enumName}" does not exist`);
      }

      // Check usage
      const usage = getEnumUsage(schema, enumName);

      // Error if enum is in use
      if (usage.length > 0) {
        const usageList = usage.map(u => `${u.typeName}.${u.fieldName}`).join(', ');
        throw new Error(`Enum "${enumName}" is in use by: ${usageList}. Remove field references first.`);
      }

      // Build impact report
      const impact = {
        enum: enumName,
        usedBy: usage,
        isInUse: usage.length > 0,
        dryRun,
      };

      if (dryRun) {
        if (jsonMode) {
          printJson(jsonSuccess({
            message: `Dry run: would delete enum "${enumName}"`,
            data: { ...impact, wouldDelete: true },
          }));
        } else {
          console.log(chalk.bold(`\nDry run: would delete enum "${enumName}"\n`));
          console.log('Run with --execute to perform the deletion.');
        }
        return;
      }

      // Actually delete
      let rawSchema = await loadRawSchemaJson(vaultDir);
      rawSchema = deleteEnum(rawSchema, enumName);
      await writeSchema(vaultDir, rawSchema);

      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Enum "${enumName}" deleted`,
          data: { deleted: enumName, fieldsAffected: usage },
        }));
      } else {
        printSuccess(`Enum "${enumName}" deleted`);
        if (usage.length > 0) {
          console.log(chalk.yellow(`Note: ${usage.length} field(s) were referencing this enum.`));
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

schemaCommand.addCommand(deleteCommand);

// -------------------- schema list --------------------

const listCommand = new Command('list')
  .description('List schema contents')
  .addHelpText('after', `
Examples:
  bwrb schema list                # Show full schema overview
  bwrb schema list types          # List type names only
  bwrb schema list fields         # List all fields across types
  bwrb schema list enums          # List all enums
  bwrb schema list type task      # Show details for "task" type
  bwrb schema list enum priority  # Show details for "priority" enum`);

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
          const typeStr = getFieldType(definition) + (definition.enum ? `:${definition.enum}` : '');
          const required = definition.required ? chalk.red('*') : '';
          console.log(`  ${type}.${field}${required} ${chalk.gray(`(${typeStr})`)}`);
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

// schema list enums
listCommand
  .command('enums')
  .description('List all enums')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        outputEnumListJson(schema);
      } else {
        outputEnumListText(schema);
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

// schema list type <name>
listCommand
  .command('type <name>')
  .description('Show details for a specific type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

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

// schema list enum <name>
listCommand
  .command('enum <name>')
  .description('Show details for a specific enum')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (!enumExists(schema, name)) {
        throw new Error(`Enum "${name}" does not exist`);
      }

      const values = getEnumValues(schema, name);
      const usage = getEnumUsage(schema, name);

      if (jsonMode) {
        printJson(jsonSuccess({
          message: `Enum "${name}"`,
          data: {
            name,
            values,
            usedBy: usage,
          },
        }));
      } else {
        console.log(chalk.bold(`\nEnum: ${name}\n`));
        console.log('Values:');
        for (const value of values) {
          console.log(`  - ${value}`);
        }
        if (usage.length > 0) {
          console.log('\nUsed by:');
          for (const u of usage) {
            console.log(`  - ${u.typeName}.${u.fieldName}`);
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
  .option('--execute', 'Actually apply the migration (default is dry-run)')
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

// ============================================================================
// Enum Output Helpers
// ============================================================================

/**
 * Output enum list as JSON.
 */
function outputEnumListJson(schema: LoadedSchema): void {
  const enumNames = getEnumNames(schema);
  const enums = enumNames.map(name => {
    const values = schema.enums.get(name) ?? [];
    const usages = getEnumUsage(schema, name);
    return {
      name,
      values,
      usages: usages.map(u => ({ type: u.typeName, field: u.fieldName })),
    };
  });
  
  printJson(jsonSuccess({ data: { enums } }));
}

/**
 * Output enum list as text.
 */
function outputEnumListText(schema: LoadedSchema): void {
  const enumNames = getEnumNames(schema);
  
  if (enumNames.length === 0) {
    console.log('No enums defined in schema.');
    return;
  }
  
  console.log(chalk.bold('\nEnums\n'));
  
  for (const name of enumNames) {
    const values = schema.enums.get(name) ?? [];
    const usages = getEnumUsage(schema, name);
    
    console.log(`${chalk.yellow(name)}: ${values.join(', ')}`);
    
    if (usages.length > 0) {
      const usageStr = usages.map(u => `${u.typeName}.${u.fieldName}`).join(', ');
      console.log(chalk.gray(`  Used by: ${usageStr}`));
    } else {
      console.log(chalk.gray(`  (not in use)`));
    }
  }
  
  console.log('');
}

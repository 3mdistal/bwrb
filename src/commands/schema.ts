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

interface SchemaShowOptions {
  output?: string;
}

export const schemaCommand = new Command('schema')
  .description('Schema introspection commands')
  .addHelpText('after', `
Examples:
  pika schema show              # Show all types
  pika schema show objective    # Show objective type details
  pika schema show objective/task  # Show task subtype details
  pika schema show task --output json  # Show as JSON for AI/scripting
  pika schema validate          # Validate schema structure`);

// schema show
schemaCommand
  .command('show [type]')
  .description('Show schema structure (all types or specific type)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string | undefined, options: SchemaShowOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

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
    'input (text)',
    'select (enum)',
    'date',
    'multi-input (list)',
    'dynamic (from other notes)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'input',
    1: 'select',
    2: 'date',
    3: 'multi-input',
    4: 'dynamic',
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
        printError('No enums defined in schema. Create an enum first with: pika schema enum add <name>');
        return promptFieldDefinition(schema);
      }
      const enumResult = await promptSelection('Enum to use', enumNames);
      if (enumResult === null) return null;
      field.enum = enumResult;
    }
    
    // For dynamic, get source type
    if (promptType === 'dynamic') {
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
  pika schema add-type book --output-dir Books -o json
  pika schema add-type entity --output-dir Entities
  pika schema add-type person --extends entity --output-dir Entities/People -o json

  # Interactive mode (prompts for options):
  pika schema add-type book`)
  .action(async (name: string, options: AddTypeOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

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
    const validPromptTypes = ['input', 'select', 'date', 'multi-input', 'dynamic'];
    if (!validPromptTypes.includes(promptType)) {
      throw new Error(`Invalid prompt type "${promptType}". Valid types: input, select, date, multi-input, dynamic, fixed`);
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
    if (promptType === 'dynamic') {
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
    'input (text)',
    'select (enum)',
    'date',
    'multi-input (list)',
    'dynamic (from other notes)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'input',
    1: 'select',
    2: 'date',
    3: 'multi-input',
    4: 'dynamic',
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
        throw new Error('No enums defined in schema. Create an enum first with: pika schema enum add <name>');
      }
      const enumResult = await promptSelection('Enum to use', enumNames);
      if (enumResult === null) return null;
      field.enum = enumResult;
    }
    
    // For dynamic, get source type
    if (promptType === 'dynamic') {
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
  .option('--type <prompt-type>', 'Prompt type: input, select, date, multi-input, dynamic, fixed')
  .option('--enum <name>', 'Enum name (for select type)')
  .option('--source <type>', 'Source type (for dynamic type)')
  .option('--value <value>', 'Fixed value (for fixed type)')
  .option('--format <format>', 'Link format: plain, wikilink, quoted-wikilink (for dynamic)')
  .option('--required', 'Mark field as required')
  .option('--default <value>', 'Default value')
  .addHelpText('after', `
Examples:
  # Non-interactive field creation (requires --type flag):
  pika schema add-field book title --type input --required -o json
  pika schema add-field book status --type select --enum status -o json
  pika schema add-field book author --type dynamic --source person --format wikilink -o json
  pika schema add-field book edition --type fixed --value "1st" -o json
  pika schema add-field book published --type date -o json
  pika schema add-field book tags --type multi-input -o json

  # Interactive mode (prompts for field definition):
  pika schema add-field book title`)
  .action(async (typeName: string, fieldName: string | undefined, options: AddFieldOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

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
        console.log(chalk.gray(`Run 'pika audit' to check existing notes for this field.`));
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
  if (field.prompt === 'dynamic' && field.format) {
    line += chalk.gray(` format=${field.format}`);
  }

  // Show filter summary for dynamic fields
  if (field.prompt === 'dynamic' && field.filter) {
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
    case 'multi-input':
      return chalk.blue('multi-input');
    case 'input':
      return chalk.blue('input');
    case 'date':
      return chalk.blue('date');
    case 'dynamic':
      return field.source ? chalk.blue(`dynamic:${field.source}`) : chalk.blue('dynamic');
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
  pika schema enum list              # Show all enums
  pika schema enum add status        # Create enum (prompts for values)
  pika schema enum add status --values "raw,active,done"
  pika schema enum update status --add archived
  pika schema enum update status --remove raw
  pika schema enum update status --rename active=in-progress
  pika schema enum delete old-status
  pika schema enum delete unused --force  # Delete even if in use`);

// schema enum list
enumCommand
  .command('list')
  .description('Show all enums with their values and usage')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: EnumCommandOptions, cmd: Command) => {
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

// schema enum add <name>
enumCommand
  .command('add <name>')
  .description('Create a new enum')
  .option('--values <values>', 'Comma-separated values')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (name: string, options: EnumCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

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
          console.log(chalk.yellow(`Run \`pika audit --fix\` to update affected notes.`));
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
          console.log(chalk.yellow(`Run: pika bulk --set ${name}=${newValue} --where "${name}=${oldValue}" --execute`));
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
          `To delete anyway: pika schema enum delete ${name} --force`
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
          console.log(chalk.yellow(`\nRun \`pika audit\` to find affected notes.`));
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

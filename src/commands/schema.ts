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
} from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { printError, printSuccess, promptMultiInput } from '../lib/prompt.js';
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
import type { LoadedSchema, Field, BodySection, ResolvedType } from '../types/schema.js';

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

  const fields = getFieldsForType(schema, typePath);

  const output: Record<string, unknown> = {
    type_path: typePath,
    output_dir: typeDef.outputDir,
    filename: typeDef.filename,
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
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
  typePath: string,
  typeDef: ResolvedType
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    output_dir: typeDef.outputDir,
  };

  // Add subtypes if present (children in new model)
  if (hasSubtypes(typeDef)) {
    result.subtypes = Object.fromEntries(
      getSubtypeKeys(typeDef).map(subtype => {
        const childTypeDef = getTypeDefByPath(schema, `${typePath}/${subtype}`);
        return [
          subtype,
          childTypeDef ? formatTypeForJson(schema, `${typePath}/${subtype}`, childTypeDef) : {},
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
      const subDef = getTypeDefByPath(schema, `${typePath}/${subtype}`);
      if (subDef) {
        printTypeTree(schema, `${typePath}/${subtype}`, subDef, depth + 1);
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

  // Frontmatter fields
  const fields = getFieldsForType(schema, typePath);
  if (Object.keys(fields).length > 0) {
    console.log(`\n  ${chalk.cyan('Fields:')}`);
    for (const [name, field] of Object.entries(fields)) {
      printFieldDetails(schema, name, field, '    ');
    }
  }

  // Subtypes (children in new model)
  if (hasSubtypes(typeDef)) {
    console.log(`\n  ${chalk.cyan('Subtypes:')}`);
    for (const subtype of getSubtypeKeys(typeDef)) {
      console.log(`    ${chalk.green(subtype)}`);
    }
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

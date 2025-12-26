import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
} from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { printError, printSuccess } from '../lib/prompt.js';
import type { Schema, Type, TypeDef, Field } from '../types/schema.js';

export const schemaCommand = new Command('schema')
  .description('Schema introspection commands');

// schema show
schemaCommand
  .command('show [type]')
  .description('Show schema structure (all types or specific type)')
  .action(async (typePath: string | undefined, _options: unknown, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (typePath) {
        showTypeDetails(schema, typePath);
      } else {
        showSchemaTree(schema);
      }
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// schema validate
schemaCommand
  .command('validate')
  .description('Validate schema structure')
  .action(async (_options: unknown, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});

      // Loading the schema validates it via Zod
      await loadSchema(vaultDir);
      printSuccess('✓ Schema is valid');
    } catch (err) {
      printError('Schema validation failed:');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * Show a tree view of all types in the schema.
 */
function showSchemaTree(schema: Schema): void {
  console.log(chalk.bold('\nSchema Types\n'));

  // Show shared fields if any
  if (schema.shared_fields && Object.keys(schema.shared_fields).length > 0) {
    console.log(chalk.cyan('Shared Fields:'));
    for (const [name, field] of Object.entries(schema.shared_fields)) {
      const type = getFieldType(field);
      console.log(`  ${chalk.yellow(name)}: ${type}`);
    }
    console.log('');
  }

  // Show enums if any
  if (schema.enums && Object.keys(schema.enums).length > 0) {
    console.log(chalk.cyan('Enums:'));
    for (const [name, values] of Object.entries(schema.enums)) {
      console.log(`  ${chalk.yellow(name)}: ${values.join(', ')}`);
    }
    console.log('');
  }

  // Show types
  console.log(chalk.cyan('Types:'));
  for (const family of getTypeFamilies(schema)) {
    const typeDef = schema.types[family];
    if (!typeDef) continue;
    printTypeTree(schema, family, typeDef, 0);
  }
}

/**
 * Recursively print a type tree.
 */
function printTypeTree(
  schema: Schema,
  typePath: string,
  typeDef: TypeDef,
  depth: number
): void {
  const indent = '  '.repeat(depth + 1);
  const typeName = typePath.split('/').pop() ?? typePath;
  const dirMode = (typeDef as Type).dir_mode;
  const outputDir = typeDef.output_dir;

  // Build type label
  let label = chalk.green(typeName);
  if (dirMode === 'instance-grouped') {
    label += chalk.gray(' [instance-grouped]');
  }
  if (outputDir) {
    label += chalk.gray(` → ${outputDir}`);
  }

  console.log(`${indent}${label}`);

  // Show subtypes
  if (hasSubtypes(typeDef)) {
    for (const subtype of getSubtypeKeys(typeDef)) {
      const subDef = typeDef.subtypes?.[subtype];
      if (subDef) {
        printTypeTree(schema, `${typePath}/${subtype}`, subDef, depth + 1);
      }
    }
  }
}

/**
 * Show detailed information about a specific type.
 */
function showTypeDetails(schema: Schema, typePath: string): void {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printError(`Unknown type: ${typePath}`);
    process.exit(1);
  }

  console.log(chalk.bold(`\nType: ${typePath}\n`));

  // Basic info
  if (typeDef.output_dir) {
    console.log(`  ${chalk.cyan('Output Dir:')} ${typeDef.output_dir}`);
  }
  if ((typeDef as Type).dir_mode) {
    console.log(`  ${chalk.cyan('Dir Mode:')} ${(typeDef as Type).dir_mode}`);
  }
  if (typeDef.name_field) {
    console.log(`  ${chalk.cyan('Name Field:')} ${typeDef.name_field}`);
  }
  if ((typeDef as { filename?: string }).filename) {
    console.log(`  ${chalk.cyan('Filename Pattern:')} ${(typeDef as { filename?: string }).filename}`);
  }

  // Shared fields opt-in
  const sharedFields = (typeDef as { shared_fields?: string[] }).shared_fields;
  if (sharedFields && sharedFields.length > 0) {
    console.log(`  ${chalk.cyan('Shared Fields:')} ${sharedFields.join(', ')}`);
  }

  // Field overrides
  const overrides = (typeDef as { field_overrides?: Record<string, unknown> }).field_overrides;
  if (overrides && Object.keys(overrides).length > 0) {
    console.log(`  ${chalk.cyan('Field Overrides:')} ${Object.keys(overrides).join(', ')}`);
  }

  // Frontmatter fields
  const fields = getFieldsForType(schema, typePath);
  if (Object.keys(fields).length > 0) {
    console.log(`\n  ${chalk.cyan('Fields:')}`);
    for (const [name, field] of Object.entries(fields)) {
      printFieldDetails(schema, name, field, '    ');
    }
  }

  // Subtypes
  if (hasSubtypes(typeDef)) {
    console.log(`\n  ${chalk.cyan('Subtypes:')}`);
    for (const subtype of getSubtypeKeys(typeDef)) {
      console.log(`    ${chalk.green(subtype)}`);
    }
  }

  // Body sections
  if (typeDef.body_sections && typeDef.body_sections.length > 0) {
    console.log(`\n  ${chalk.cyan('Body Sections:')}`);
    for (const section of typeDef.body_sections) {
      console.log(`    ${chalk.yellow(section.title)} (h${section.level ?? 2})`);
    }
  }

  console.log('');
}

/**
 * Print details for a single field.
 */
function printFieldDetails(
  schema: Schema,
  name: string,
  field: Field,
  indent: string
): void {
  const type = getFieldType(field);
  let line = `${indent}${chalk.yellow(name)}: ${type}`;

  // Show enum values if applicable
  if (field.enum) {
    const values = schema.enums?.[field.enum] ?? [];
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

/**
 * Schema output and display helpers.
 */

import chalk from 'chalk';
import {
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
  getFieldsByOrigin,
  getFieldOrderForOrigin,
} from '../../../lib/schema.js';
import { printError } from '../../../lib/prompt.js';
import { printJson, jsonError, ExitCodes } from '../../../lib/output.js';
import type { LoadedSchema, Field, BodySection, ResolvedType } from '../../../types/schema.js';

/**
 * Output schema as JSON for AI/scripting usage.
 */
export function outputSchemaJson(schema: LoadedSchema): void {
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
export function outputTypeDetailsJson(schema: LoadedSchema, typePath: string): void {
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
export function showSchemaTree(schema: LoadedSchema): void {
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
export function showTypeDetails(schema: LoadedSchema, typePath: string): void {
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
export function getFieldType(field: Field): string {
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

// ============================================================================
// Verbose Output Functions
// ============================================================================

/**
 * Show a verbose tree view of all types with their fields inline.
 */
export function showSchemaTreeVerbose(schema: LoadedSchema): void {
  console.log(chalk.bold('\nSchema Types\n'));

  console.log(chalk.cyan('Types:'));
  for (const family of getTypeFamilies(schema)) {
    const typeDef = getTypeDefByPath(schema, family);
    if (!typeDef) continue;
    printTypeTreeVerbose(schema, family, typeDef, 0);
  }
}

/**
 * Recursively print a type tree with fields inline.
 */
function printTypeTreeVerbose(
  schema: LoadedSchema,
  typePath: string,
  typeDef: ResolvedType,
  depth: number
): void {
  const indent = '  '.repeat(depth + 1);
  const typeName = typePath.split('/').pop() ?? typePath;

  // Build type header line
  let header = chalk.green(typeName);
  if (typeDef.parent && typeDef.parent !== 'meta') {
    header += chalk.gray(` (extends ${typeDef.parent})`);
  }
  if (typeDef.outputDir) {
    header += chalk.gray(` -> ${typeDef.outputDir}`);
  }

  console.log(`${indent}${header}`);

  // Get fields grouped by origin
  const { ownFields, inheritedFields } = getFieldsByOrigin(schema, typePath);

  // Collect all fields in order with their origin info
  const fieldsToShow: Array<{ name: string; field: Field; inherited?: string }> = [];

  // Add inherited fields first (in ancestor order: parent first, then grandparent)
  for (const ancestorName of typeDef.ancestors) {
    const ancestorFields = inheritedFields.get(ancestorName);
    if (ancestorFields) {
      const orderedFields = getFieldOrderForOrigin(
        schema,
        ancestorName,
        Object.keys(ancestorFields)
      );
      for (const name of orderedFields) {
        fieldsToShow.push({ name, field: ancestorFields[name]!, inherited: ancestorName });
      }
    }
  }

  // Add own fields
  const ownFieldNames = Object.keys(ownFields);
  if (ownFieldNames.length > 0) {
    const orderedOwnFields = getFieldOrderForOrigin(schema, typeDef.name, ownFieldNames);
    for (const name of orderedOwnFields) {
      fieldsToShow.push({ name, field: ownFields[name]! });
    }
  }

  // Print fields with tree characters
  const fieldIndent = indent + '  ';
  for (let i = 0; i < fieldsToShow.length; i++) {
    const { name, field, inherited } = fieldsToShow[i]!;
    const isLast = i === fieldsToShow.length - 1;
    const prefix = isLast ? '└─' : '├─';

    let line = `${fieldIndent}${prefix} ${chalk.yellow(name)}: ${getFieldTypeCompact(field)}`;

    // Add required marker
    if (field.required) {
      line += chalk.red(' [required]');
    }

    // Add inherited marker
    if (inherited) {
      line += chalk.gray(` (inherited)`);
    }

    console.log(line);
  }

  // Add blank line between types for readability (but not after the last subtype)
  const subtypes = hasSubtypes(typeDef) ? getSubtypeKeys(typeDef) : [];
  if (subtypes.length === 0) {
    console.log('');
  }

  // Show subtypes (children in new model)
  if (subtypes.length > 0) {
    for (const subtype of subtypes) {
      const subDef = getTypeDefByPath(schema, subtype);
      if (subDef) {
        printTypeTreeVerbose(schema, subtype, subDef, depth + 1);
      }
    }
  }
}

/**
 * Get a type string for verbose field display, with multiple indicator.
 * Reuses getFieldType() to avoid drift between formatters.
 */
function getFieldTypeCompact(field: Field): string {
  const baseType = getFieldType(field);
  // Add multiple indicator for select fields
  if (field.prompt === 'select' && field.multiple) {
    return baseType + chalk.blue(' (multiple)');
  }
  return baseType;
}

/**
 * Output verbose schema as JSON showing all types with their fields.
 */
export function outputSchemaVerboseJson(schema: LoadedSchema): void {
  const types: Array<Record<string, unknown>> = [];

  // Process all types (not just families - include children too)
  const processedTypes = new Set<string>();

  function processType(typeName: string): void {
    if (processedTypes.has(typeName)) return;
    processedTypes.add(typeName);

    const typeDef = getTypeDefByPath(schema, typeName);
    if (!typeDef) return;

    // Get fields grouped by origin
    const { ownFields, inheritedFields } = getFieldsByOrigin(schema, typeName);

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

    const typeOutput: Record<string, unknown> = {
      name: typeName,
    };

    // Add extends if present (hide implicit 'meta' parent for cleaner output)
    if (typeDef.parent && typeDef.parent !== 'meta') {
      typeOutput.extends = typeDef.parent;
    }

    // Add output_dir
    if (typeDef.outputDir) {
      typeOutput.output_dir = typeDef.outputDir;
    }

    // Add own fields
    typeOutput.own_fields = Object.fromEntries(
      Object.entries(ownFields).map(([name, field]) => [
        name,
        formatFieldForJson(field),
      ])
    );

    // Add inherited fields if any
    if (Object.keys(inheritedFieldsObj).length > 0) {
      typeOutput.inherited_fields = inheritedFieldsObj;
    }

    // Add subtypes if any
    if (hasSubtypes(typeDef)) {
      typeOutput.subtypes = getSubtypeKeys(typeDef);
    }

    types.push(typeOutput);

    // Process children
    for (const childName of typeDef.children) {
      processType(childName);
    }
  }

  // Start with top-level families
  for (const family of getTypeFamilies(schema)) {
    processType(family);
  }

  const output = {
    version: schema.raw.version ?? 2,
    types,
  };

  console.log(JSON.stringify(output, null, 2));
}

import { readFile } from 'fs/promises';
import { join } from 'path';
import { OvaultSchema, type Schema, type TypeDef, type Field, type Subtype } from '../types/schema.js';

const SCHEMA_PATH = '.ovault/schema.json';

/**
 * Load and validate the schema from a vault directory.
 */
export async function loadSchema(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return OvaultSchema.parse(json);
}

/**
 * Get top-level type family names.
 */
export function getTypeFamilies(schema: Schema): string[] {
  return Object.keys(schema.types);
}

/**
 * Get enum values by name.
 */
export function getEnumValues(schema: Schema, enumName: string): string[] {
  return schema.enums?.[enumName] ?? [];
}

/**
 * Convert a type path (e.g., "objective/task") to an array of path segments.
 */
export function parseTypePath(typePath: string): string[] {
  return typePath.split('/').filter(Boolean);
}

/**
 * Navigate to a type definition by path segments.
 * Returns the type/subtype definition or undefined if not found.
 */
export function getTypeDefByPath(schema: Schema, typePath: string): TypeDef | undefined {
  const segments = parseTypePath(typePath);
  if (segments.length === 0) return undefined;

  const [family, ...rest] = segments;
  let current: TypeDef | undefined = family ? schema.types[family] : undefined;

  for (const segment of rest) {
    if (!current?.subtypes) return undefined;
    current = current.subtypes[segment];
  }

  return current;
}

/**
 * Check if a type definition has subtypes.
 */
export function hasSubtypes(typeDef: TypeDef): boolean {
  return Boolean(typeDef.subtypes && Object.keys(typeDef.subtypes).length > 0);
}

/**
 * Get subtype keys for a type definition.
 */
export function getSubtypeKeys(typeDef: TypeDef): string[] {
  return typeDef.subtypes ? Object.keys(typeDef.subtypes) : [];
}

/**
 * Get the discriminator field name for a type level.
 * Top-level uses "type", nested uses "<parent>-type".
 */
export function discriminatorName(parentName: string | undefined): string {
  if (!parentName || parentName === 'type') {
    return 'type';
  }
  return `${parentName}-type`;
}

/**
 * Get all frontmatter fields for a type, including inherited fields from parent types.
 * Walks up from the leaf type collecting fields.
 */
export function getFieldsForType(
  schema: Schema,
  typePath: string
): Record<string, Field> {
  const segments = parseTypePath(typePath);
  const fields: Record<string, Field> = {};

  // Start with shared fields
  if (schema.shared_fields) {
    Object.assign(fields, schema.shared_fields);
  }

  // Walk through the type path, collecting fields
  let current: TypeDef | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === 0) {
      current = segment ? schema.types[segment] : undefined;
    } else if (current?.subtypes && segment) {
      current = current.subtypes[segment];
    }

    if (current?.frontmatter) {
      Object.assign(fields, current.frontmatter);
    }
  }

  return fields;
}

/**
 * Get frontmatter field order for a type.
 * Uses explicit order if defined, otherwise returns field keys.
 */
export function getFrontmatterOrder(typeDef: TypeDef): string[] {
  if (typeDef.frontmatter_order) {
    return typeDef.frontmatter_order;
  }
  return typeDef.frontmatter ? Object.keys(typeDef.frontmatter) : [];
}

/**
 * Resolve a type path from frontmatter values.
 * Reads "type" and "<type>-type" fields to build the full path.
 */
export function resolveTypePathFromFrontmatter(
  schema: Schema,
  frontmatter: Record<string, unknown>
): string | undefined {
  const typeName = frontmatter['type'];
  if (typeof typeName !== 'string') return undefined;

  const segments = [typeName];
  let current: TypeDef | undefined = schema.types[typeName];
  let currentName = typeName;

  while (current && hasSubtypes(current)) {
    const discField = discriminatorName(currentName);
    const subValue = frontmatter[discField];
    if (typeof subValue !== 'string') break;

    segments.push(subValue);
    current = current.subtypes?.[subValue];
    currentName = subValue;
  }

  return segments.join('/');
}

/**
 * Collect all valid field names for a type and its subtypes recursively.
 */
export function getAllFieldsForType(schema: Schema, typePath: string): Set<string> {
  const fields = new Set<string>();

  function collectFields(typeDef: TypeDef | undefined): void {
    if (!typeDef) return;

    if (typeDef.frontmatter) {
      Object.keys(typeDef.frontmatter).forEach(f => fields.add(f));
    }

    if (typeDef.subtypes) {
      Object.values(typeDef.subtypes).forEach(sub => collectFields(sub as Subtype));
    }
  }

  // Add shared fields
  if (schema.shared_fields) {
    Object.keys(schema.shared_fields).forEach(f => fields.add(f));
  }

  const typeDef = getTypeDefByPath(schema, typePath);
  collectFields(typeDef);

  return fields;
}

/**
 * Get the enum name for a field in a type (if it references an enum).
 */
export function getEnumForField(
  schema: Schema,
  typePath: string,
  fieldName: string
): string | undefined {
  function findEnum(typeDef: TypeDef | undefined): string | undefined {
    if (!typeDef) return undefined;

    const field = typeDef.frontmatter?.[fieldName];
    if (field?.enum) return field.enum;

    if (typeDef.subtypes) {
      for (const sub of Object.values(typeDef.subtypes)) {
        const found = findEnum(sub as Subtype);
        if (found) return found;
      }
    }

    return undefined;
  }

  // Check shared fields first
  const sharedField = schema.shared_fields?.[fieldName];
  if (sharedField?.enum) return sharedField.enum;

  return findEnum(getTypeDefByPath(schema, typePath));
}

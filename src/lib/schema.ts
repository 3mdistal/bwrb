import { readFile } from 'fs/promises';
import { join } from 'path';
import { PikaSchema, type Schema, type TypeDef, type Field, type FieldOverride, type Subtype } from '../types/schema.js';

const SCHEMA_PATH = '.pika/schema.json';

/**
 * Load and validate the schema from a vault directory.
 */
export async function loadSchema(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return PikaSchema.parse(json);
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
 * Get all frontmatter fields for a type, using opt-in shared fields model.
 * 
 * Order of resolution:
 * 1. Collect shared fields that the leaf type opts into (via shared_fields array)
 * 2. Apply field_overrides from the leaf type
 * 3. Add type-specific frontmatter fields from the type hierarchy
 */
export function getFieldsForType(
  schema: Schema,
  typePath: string
): Record<string, Field> {
  const segments = parseTypePath(typePath);
  const fields: Record<string, Field> = {};

  // Find the leaf type definition
  let leafType: TypeDef | undefined;
  let current: TypeDef | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === 0) {
      current = segment ? schema.types[segment] : undefined;
    } else if (current?.subtypes && segment) {
      current = current.subtypes[segment];
    }
    leafType = current;
  }

  // 1. Add shared fields that the leaf type opts into
  const sharedFieldNames = getSharedFieldNames(leafType);
  if (schema.shared_fields && sharedFieldNames.length > 0) {
    for (const fieldName of sharedFieldNames) {
      const sharedField = schema.shared_fields[fieldName];
      if (sharedField) {
        fields[fieldName] = { ...sharedField };
      }
    }
  }

  // 2. Apply field_overrides from the leaf type
  const overrides = getFieldOverrides(leafType);
  for (const [fieldName, override] of Object.entries(overrides)) {
    if (fields[fieldName]) {
      fields[fieldName] = applyFieldOverride(fields[fieldName], override);
    }
  }

  // 3. Add type-specific frontmatter fields from the hierarchy
  current = undefined;
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
 * Get the shared field names a type opts into.
 */
function getSharedFieldNames(typeDef: TypeDef | undefined): string[] {
  if (!typeDef) return [];
  // TypeDef could be Type or Subtype, both now have shared_fields
  return (typeDef as { shared_fields?: string[] }).shared_fields ?? [];
}

/**
 * Get field overrides for a type.
 */
function getFieldOverrides(typeDef: TypeDef | undefined): Record<string, FieldOverride> {
  if (!typeDef) return {};
  return (typeDef as { field_overrides?: Record<string, FieldOverride> }).field_overrides ?? {};
}

/**
 * Apply a field override to a shared field.
 * Only default, required, and label can be overridden.
 */
function applyFieldOverride(field: Field, override: FieldOverride): Field {
  return {
    ...field,
    ...(override.default !== undefined && { default: override.default }),
    ...(override.required !== undefined && { required: override.required }),
    ...(override.label !== undefined && { label: override.label }),
  };
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
 * Get ordered field names for a type.
 * If frontmatter_order is defined, uses that.
 * Otherwise: shared fields first (in opt-in order), then type-specific fields.
 */
export function getOrderedFieldNames(
  schema: Schema,
  typePath: string,
  typeDef: TypeDef
): string[] {
  // If explicit order is defined, use it
  if (typeDef.frontmatter_order && typeDef.frontmatter_order.length > 0) {
    return typeDef.frontmatter_order;
  }

  const fields = getFieldsForType(schema, typePath);
  const allFieldNames = Object.keys(fields);

  // Get shared field names in opt-in order
  const sharedFieldNames = getSharedFieldNames(typeDef);
  const sharedInOrder = sharedFieldNames.filter(f => allFieldNames.includes(f));

  // Get type-specific fields (everything not in shared)
  const typeSpecific = allFieldNames.filter(f => !sharedFieldNames.includes(f));

  return [...sharedInOrder, ...typeSpecific];
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

/**
 * Convert a type path (e.g., "objective/task") into discriminator field values.
 * Returns an object like { type: 'objective', 'objective-type': 'task' }.
 */
export function getDiscriminatorFieldsFromTypePath(
  typePath: string
): Record<string, string> {
  const segments = parseTypePath(typePath);
  const fields: Record<string, string> = {};

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;

    if (i === 0) {
      // First segment is always 'type'
      fields['type'] = segment;
    } else {
      // Subsequent segments use '<parent>-type' naming
      const parentSegment = segments[i - 1];
      if (parentSegment) {
        fields[`${parentSegment}-type`] = segment;
      }
    }
  }

  return fields;
}

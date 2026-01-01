import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  PikaSchema,
  LegacyPikaSchema,
  type Schema,
  type Type,
  type Field,
  type BodySection,
  type DynamicSource,
  type ResolvedType,
  type LoadedSchema,
  type LegacySchema,
  type LegacyType,
  type LegacySubtype,
  type FieldOverride,
  type OwnershipMap,
  type OwnedFieldInfo,
  type OwnerInfo,
} from '../types/schema.js';

const SCHEMA_PATH = '.pika/schema.json';
const META_TYPE = 'meta';

// ============================================================================
// Pluralization
// ============================================================================

/**
 * Auto-pluralise a type name for folder naming.
 * 
 * Rules:
 * - Words ending in 's', 'x', 'z', 'ch', 'sh' → add 'es' (bus → buses)
 * - Words ending in consonant + 'y' → change 'y' to 'ies' (story → stories)
 * - Special cases that don't pluralise (research, software, etc.) should use
 *   the explicit 'plural' property in the schema
 * - Everything else → add 's' (task → tasks)
 */
function autoPluralise(singular: string): string {
  if (!singular) return singular;
  
  const lower = singular.toLowerCase();
  
  // Words ending in s, x, z, ch, sh → add 'es'
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z') ||
      lower.endsWith('ch') || lower.endsWith('sh')) {
    return singular + 'es';
  }
  
  // Words ending in consonant + y → change y to ies
  if (lower.endsWith('y')) {
    const beforeY = lower[lower.length - 2];
    const vowels = ['a', 'e', 'i', 'o', 'u'];
    if (beforeY && !vowels.includes(beforeY)) {
      return singular.slice(0, -1) + 'ies';
    }
  }
  
  // Default: add 's'
  return singular + 's';
}

// ============================================================================
// Schema Loading
// ============================================================================

/**
 * Load, validate, and resolve a schema from a vault directory.
 * This handles both v1 (legacy) and v2 (inheritance) schema formats.
 */
export async function loadSchema(vaultDir: string): Promise<LoadedSchema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  
  // Detect schema version and parse accordingly
  const version = (json as { version?: number }).version;
  
  if (version === 1 || isLegacySchema(json)) {
    // Parse as legacy schema and convert
    const legacySchema = LegacyPikaSchema.parse(json);
    const schema = convertLegacySchema(legacySchema);
    return resolveSchema(schema);
  } else {
    // Parse as v2 schema
    const schema = PikaSchema.parse(json);
    return resolveSchema(schema);
  }
}

/**
 * Load raw schema without resolving inheritance (for migration tools).
 */
export async function loadRawSchema(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return PikaSchema.parse(json);
}

/**
 * Check if a JSON object looks like a legacy (v1) schema.
 */
function isLegacySchema(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const obj = json as Record<string, unknown>;
  
  // Check for legacy indicators
  if (obj.shared_fields) return true;
  
  // Check if any type has 'subtypes' or 'frontmatter' (legacy) vs 'extends' or 'fields' (v2)
  const types = obj.types as Record<string, unknown> | undefined;
  if (types) {
    for (const typeDef of Object.values(types)) {
      if (typeof typeDef === 'object' && typeDef !== null) {
        const t = typeDef as Record<string, unknown>;
        if (t.subtypes || t.frontmatter || t.shared_fields || t.field_overrides) {
          return true;
        }
      }
    }
  }
  
  return false;
}

// ============================================================================
// Schema Resolution (Inheritance Tree Building)
// ============================================================================

/**
 * Resolve a parsed schema into a LoadedSchema with computed inheritance.
 */
export function resolveSchema(schema: Schema): LoadedSchema {
  const types = new Map<string, ResolvedType>();
  const enums = new Map<string, string[]>();
  const dynamicSources = new Map<string, DynamicSource>();
  
  // Copy enums
  if (schema.enums) {
    for (const [name, values] of Object.entries(schema.enums)) {
      enums.set(name, values);
    }
  }
  
  // Copy dynamic sources
  if (schema.dynamic_sources) {
    for (const [name, source] of Object.entries(schema.dynamic_sources)) {
      dynamicSources.set(name, source);
    }
  }
  
  // Create implicit meta type if not defined
  if (!schema.types[META_TYPE]) {
    types.set(META_TYPE, createImplicitMeta());
  }
  
  // First pass: create base ResolvedType entries
  for (const [name, typeDef] of Object.entries(schema.types)) {
    types.set(name, {
      name,
      parent: typeDef.extends ?? (name === META_TYPE ? undefined : META_TYPE),
      children: [],
      fields: { ...typeDef.fields },
      fieldOrder: typeDef.field_order ?? (typeDef.fields ? Object.keys(typeDef.fields) : []),
      bodySections: typeDef.body_sections ?? [],
      recursive: typeDef.recursive ?? false,
      outputDir: typeDef.output_dir,
      filename: typeDef.filename,
      ancestors: [],
      plural: typeDef.plural ?? autoPluralise(name),
    });
  }
  
  // Validate inheritance relationships
  validateInheritance(types);
  
  // Second pass: build children lists and ancestor chains
  for (const [name, type] of types) {
    if (type.parent && type.parent !== name) {
      const parent = types.get(type.parent);
      if (parent) {
        parent.children.push(name);
      }
    }
    type.ancestors = computeAncestors(types, name);
  }
  
  // Third pass: compute effective fields (inherit from ancestors)
  for (const type of types.values()) {
    type.fields = computeEffectiveFields(types, type);
    type.fieldOrder = computeFieldOrder(types, type);
  }
  
  // Fourth pass: add implied parent field for recursive types
  for (const type of types.values()) {
    if (type.recursive && !type.fields['parent']) {
      // Auto-create the parent field for recursive types
      type.fields['parent'] = {
        prompt: 'dynamic',
        source: type.name,
        format: 'wikilink',
        required: false,
      };
      // Add parent to field order if not already present
      if (!type.fieldOrder.includes('parent')) {
        type.fieldOrder.push('parent');
      }
    }
  }
  
  // Fifth pass: build ownership map
  const ownership = buildOwnershipMap(types);
  
  return { raw: schema, types, enums, dynamicSources, ownership };
}

/**
 * Create the implicit meta type.
 */
function createImplicitMeta(): ResolvedType {
  return {
    name: META_TYPE,
    parent: undefined,
    children: [],
    fields: {},
    fieldOrder: [],
    bodySections: [],
    recursive: false,
    outputDir: undefined,
    filename: undefined,
    ancestors: [],
    plural: META_TYPE, // 'meta' doesn't need pluralization
  };
}

/**
 * Validate inheritance relationships.
 * Throws if there are cycles or invalid extends targets.
 */
function validateInheritance(types: Map<string, ResolvedType>): void {
  // Check for duplicate type names (already handled by Map)
  
  // Check for invalid extends targets
  for (const [name, type] of types) {
    if (type.parent && !types.has(type.parent)) {
      throw new Error(
        `Type "${name}" extends unknown type "${type.parent}". ` +
        `Available types: ${Array.from(types.keys()).join(', ')}`
      );
    }
  }
  
  // Check for cycles
  for (const name of types.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = name;
    
    while (current) {
      if (visited.has(current)) {
        const cycle = Array.from(visited).concat(current).join(' -> ');
        throw new Error(`Circular inheritance detected: ${cycle}`);
      }
      visited.add(current);
      current = types.get(current)?.parent;
    }
  }
}

/**
 * Compute the ancestor chain for a type (parent first, meta last).
 */
function computeAncestors(types: Map<string, ResolvedType>, typeName: string): string[] {
  const ancestors: string[] = [];
  let current = types.get(typeName)?.parent;
  
  while (current) {
    ancestors.push(current);
    current = types.get(current)?.parent;
  }
  
  return ancestors;
}

/**
 * Compute effective fields by merging ancestor fields.
 * Ancestor fields come first, child fields override.
 */
function computeEffectiveFields(
  types: Map<string, ResolvedType>,
  type: ResolvedType
): Record<string, Field> {
  const fields: Record<string, Field> = {};
  
  // Start from the root and work down (so child fields override)
  const chain = [...type.ancestors].reverse();
  
  for (const ancestorName of chain) {
    const ancestor = types.get(ancestorName);
    if (ancestor?.fields) {
      // Merge ancestor fields - but only copy the full field if not already present
      // If present, only allow 'default' override per spec
      for (const [fieldName, fieldDef] of Object.entries(ancestor.fields)) {
        if (!fields[fieldName]) {
          fields[fieldName] = { ...fieldDef };
        }
      }
    }
  }
  
  // Apply type's own fields (can override 'default' of inherited fields)
  const rawType = type as { fields?: Record<string, Field> };
  if (rawType.fields) {
    for (const [fieldName, fieldDef] of Object.entries(rawType.fields)) {
      if (fields[fieldName]) {
        // Field exists from ancestor - only allow 'default' override
        if (fieldDef.default !== undefined) {
          fields[fieldName] = { ...fields[fieldName], default: fieldDef.default };
        }
        // Note: per spec, other properties cannot be overridden
      } else {
        // New field
        fields[fieldName] = { ...fieldDef };
      }
    }
  }
  
  return fields;
}

/**
 * Compute field order by combining ancestor field orders.
 */
function computeFieldOrder(
  types: Map<string, ResolvedType>,
  type: ResolvedType
): string[] {
  // If type has explicit order, use it
  const rawType = types.get(type.name);
  if (rawType?.fieldOrder && rawType.fieldOrder.length > 0) {
    // Check if it's a complete order (includes all fields)
    const allFields = Object.keys(type.fields);
    const explicitOrder = rawType.fieldOrder;
    if (allFields.every(f => explicitOrder.includes(f))) {
      return explicitOrder;
    }
  }
  
  // Otherwise, build order from ancestor chain
  const order: string[] = [];
  const seen = new Set<string>();
  
  // Start from root, add fields in order
  const chain = [...type.ancestors].reverse();
  for (const ancestorName of chain) {
    const ancestor = types.get(ancestorName);
    if (ancestor?.fieldOrder) {
      for (const fieldName of ancestor.fieldOrder) {
        if (!seen.has(fieldName) && type.fields[fieldName]) {
          order.push(fieldName);
          seen.add(fieldName);
        }
      }
    }
  }
  
  // Add type's own fields
  if (type.fieldOrder) {
    for (const fieldName of type.fieldOrder) {
      if (!seen.has(fieldName) && type.fields[fieldName]) {
        order.push(fieldName);
        seen.add(fieldName);
      }
    }
  }
  
  // Add any remaining fields not in explicit orders
  for (const fieldName of Object.keys(type.fields)) {
    if (!seen.has(fieldName)) {
      order.push(fieldName);
      seen.add(fieldName);
    }
  }
  
  return order;
}

// ============================================================================
// Ownership Map Building
// ============================================================================

/**
 * Build the ownership map from resolved types.
 * Scans all fields with `owned: true` and builds bidirectional lookup maps.
 */
function buildOwnershipMap(types: Map<string, ResolvedType>): OwnershipMap {
  const canBeOwnedBy = new Map<string, OwnerInfo[]>();
  const owns = new Map<string, OwnedFieldInfo[]>();
  
  for (const [ownerTypeName, ownerType] of types) {
    for (const [fieldName, field] of Object.entries(ownerType.fields)) {
      // Check if this field declares ownership
      if (field.owned === true && field.source) {
        const childType = field.source;
        const multiple = field.multiple ?? false;
        
        // Add to owner's "owns" list
        const ownerOwns = owns.get(ownerTypeName) ?? [];
        ownerOwns.push({
          fieldName,
          ownerType: ownerTypeName,
          childType,
          multiple,
        });
        owns.set(ownerTypeName, ownerOwns);
        
        // Add to child's "canBeOwnedBy" list
        const childOwners = canBeOwnedBy.get(childType) ?? [];
        childOwners.push({
          ownerType: ownerTypeName,
          fieldName,
          multiple,
        });
        canBeOwnedBy.set(childType, childOwners);
      }
    }
  }
  
  return { canBeOwnedBy, owns };
}

// ============================================================================
// Legacy Schema Conversion
// ============================================================================

/**
 * Convert a legacy (v1) schema to the new (v2) format.
 */
function convertLegacySchema(legacy: LegacySchema): Schema {
  const types: Record<string, Type> = {};
  
  // Convert each top-level type and its subtypes
  for (const [name, legacyType] of Object.entries(legacy.types)) {
    convertLegacyType(types, name, legacyType, undefined, legacy);
  }
  
  return {
    version: 2,
    enums: legacy.enums,
    dynamic_sources: legacy.dynamic_sources,
    types,
    audit: legacy.audit,
  };
}

/**
 * Recursively convert a legacy type and its subtypes.
 */
function convertLegacyType(
  types: Record<string, Type>,
  name: string,
  legacyType: LegacyType | LegacySubtype,
  parentName: string | undefined,
  schema: LegacySchema
): void {
  // Convert frontmatter to fields, applying shared fields and overrides
  let fields: Record<string, Field> = {};
  
  // First, apply shared fields (legacy model)
  const sharedFieldNames = (legacyType as { shared_fields?: string[] }).shared_fields ?? [];
  if (schema.shared_fields && sharedFieldNames.length > 0) {
    for (const fieldName of sharedFieldNames) {
      const sharedField = schema.shared_fields[fieldName];
      if (sharedField) {
        fields[fieldName] = { ...sharedField };
      }
    }
  }
  
  // Apply field overrides
  const overrides = (legacyType as { field_overrides?: Record<string, FieldOverride> }).field_overrides ?? {};
  for (const [fieldName, override] of Object.entries(overrides)) {
    if (fields[fieldName]) {
      fields[fieldName] = {
        ...fields[fieldName],
        ...(override.default !== undefined && { default: override.default }),
        ...(override.required !== undefined && { required: override.required }),
        ...(override.label !== undefined && { label: override.label }),
      };
    }
  }
  
  // Add type's own frontmatter fields
  const frontmatter = (legacyType as { frontmatter?: Record<string, Field> }).frontmatter;
  if (frontmatter) {
    // Filter out discriminator fields (type, {parent}-type)
    for (const [fieldName, fieldDef] of Object.entries(frontmatter)) {
      if (fieldName === 'type' || fieldName.endsWith('-type')) {
        continue; // Skip legacy discriminator fields
      }
      fields[fieldName] = { ...fieldDef };
    }
  }
  
  // Create the new type
  types[name] = {
    extends: parentName,
    fields: Object.keys(fields).length > 0 ? fields : undefined,
    field_order: (legacyType as { frontmatter_order?: string[] }).frontmatter_order?.filter(
      f => f !== 'type' && !f.endsWith('-type')
    ),
    body_sections: legacyType.body_sections,
    output_dir: legacyType.output_dir,
    filename: (legacyType as { filename?: string }).filename,
  };
  
  // Recursively convert subtypes
  const subtypes = (legacyType as { subtypes?: Record<string, LegacySubtype> }).subtypes;
  if (subtypes) {
    for (const [subtypeName, subtype] of Object.entries(subtypes)) {
      convertLegacyType(types, subtypeName, subtype, name, schema);
    }
  }
}

// ============================================================================
// Type Lookup (New API)
// ============================================================================

/**
 * Get a resolved type by name.
 * Accepts both type names (e.g., "task") and legacy paths (e.g., "objective/task").
 */
export function getType(schema: LoadedSchema, typeName: string): ResolvedType | undefined {
  // Handle legacy path format (e.g., "objective/task" -> "task")
  const segments = typeName.split('/').filter(Boolean);
  const resolvedName = segments[segments.length - 1] ?? typeName;
  return schema.types.get(resolvedName);
}

/**
 * Get all type names.
 */
export function getTypeNames(schema: LoadedSchema): string[] {
  return Array.from(schema.types.keys());
}

/**
 * Get all leaf type names (types with no children).
 */
export function getLeafTypeNames(schema: LoadedSchema): string[] {
  return Array.from(schema.types.values())
    .filter(t => t.children.length === 0)
    .map(t => t.name);
}

/**
 * Get all concrete type names (types that can have instances).
 * In the new model, all types are potentially concrete.
 */
export function getConcreteTypeNames(schema: LoadedSchema): string[] {
  return Array.from(schema.types.keys()).filter(name => name !== META_TYPE);
}

/**
 * Get descendant type names for a type (all children, grandchildren, etc.).
 */
export function getDescendants(schema: LoadedSchema, typeName: string): string[] {
  const descendants: string[] = [];
  const type = schema.types.get(typeName);
  if (!type) return descendants;
  
  function collect(t: ResolvedType): void {
    for (const childName of t.children) {
      descendants.push(childName);
      const child = schema.types.get(childName);
      if (child) collect(child);
    }
  }
  
  collect(type);
  return descendants;
}

/**
 * Check if a type is a descendant of another type.
 */
export function isDescendantOf(schema: LoadedSchema, typeName: string, ancestorName: string): boolean {
  const type = schema.types.get(typeName);
  if (!type) return false;
  return type.ancestors.includes(ancestorName);
}

/**
 * Get enum values by name.
 */
export function getEnumValues(schema: LoadedSchema, enumName: string): string[] {
  return schema.enums.get(enumName) ?? [];
}

/**
 * Get the effective fields for a type (already computed).
 * Accepts both type names (e.g., "task") and legacy paths (e.g., "objective/task").
 */
export function getFieldsForType(schema: LoadedSchema, typeName: string): Record<string, Field> {
  const type = getType(schema, typeName);
  return type?.fields ?? {};
}

/**
 * Get the field order for a type (already computed).
 * Accepts both type names (e.g., "task") and legacy paths (e.g., "objective/task").
 */
export function getFieldOrder(schema: LoadedSchema, typeName: string): string[] {
  const type = getType(schema, typeName);
  return type?.fieldOrder ?? [];
}

/**
 * Get body sections for a type.
 * Inherits from ancestors if not defined on the type itself.
 */
export function getBodySections(schema: LoadedSchema, typeName: string): BodySection[] {
  const type = schema.types.get(typeName);
  if (!type) return [];
  
  // If type has body sections, use them
  if (type.bodySections.length > 0) {
    return type.bodySections;
  }
  
  // Otherwise, check ancestors
  for (const ancestorName of type.ancestors) {
    const ancestor = schema.types.get(ancestorName);
    if (ancestor && ancestor.bodySections.length > 0) {
      return ancestor.bodySections;
    }
  }
  
  return [];
}

/**
 * Resolve a type name from frontmatter.
 * Handles both new-style (single 'type' field) and legacy-style
 * (type + parent-type discriminator fields) frontmatter.
 */
export function resolveTypeFromFrontmatter(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>
): string | undefined {
  const typeName = frontmatter['type'];
  if (typeof typeName !== 'string') return undefined;
  
  // First, check for legacy-style discriminator fields
  // e.g., type: objective, objective-type: task -> returns 'task'
  // This must be checked first because the parent type also exists in the schema
  const childTypeField = `${typeName}-type`;
  const childTypeName = frontmatter[childTypeField];
  if (typeof childTypeName === 'string' && schema.types.has(childTypeName)) {
    return childTypeName;
  }
  
  // Check if the type itself exists (new-style or leaf type)
  if (schema.types.has(typeName)) {
    return typeName;
  }
  
  return undefined;
}

/**
 * Get all valid field names for a type and its descendants.
 * Useful for filter validation.
 * Accepts both type names (e.g., "task") and legacy paths (e.g., "objective/task").
 */
export function getAllFieldsForType(schema: LoadedSchema, typeName: string): Set<string> {
  const fields = new Set<string>();
  
  const type = getType(schema, typeName);
  if (!type) return fields;
  
  // Add type's fields
  for (const fieldName of Object.keys(type.fields)) {
    fields.add(fieldName);
  }
  
  // Add descendant fields
  const descendants = getDescendants(schema, typeName);
  for (const descendantName of descendants) {
    const descendant = schema.types.get(descendantName);
    if (descendant) {
      for (const fieldName of Object.keys(descendant.fields)) {
        fields.add(fieldName);
      }
    }
  }
  
  return fields;
}

/**
 * Get the enum name for a field in a type.
 */
export function getEnumForField(
  schema: LoadedSchema,
  typeName: string,
  fieldName: string
): string | undefined {
  const type = schema.types.get(typeName);
  if (!type) return undefined;
  
  const field = type.fields[fieldName];
  return field?.enum;
}

/**
 * Get the output directory for a type.
 * 
 * Resolution order:
 * 1. If the type has an explicit output_dir, use it
 * 2. If an ancestor has an explicit output_dir, use it
 * 3. Otherwise, compute from type hierarchy using pluralized names
 * 
 * Accepts both type names (e.g., "task") and legacy paths (e.g., "objective/task").
 */
export function getOutputDir(schema: LoadedSchema, typeName: string): string {
  // Handle legacy path format (e.g., "objective/task" -> "task")
  const segments = typeName.split('/').filter(Boolean);
  const resolvedName = segments[segments.length - 1] ?? typeName;
  
  const type = schema.types.get(resolvedName);
  if (!type) return autoPluralise(resolvedName); // Fallback for unknown types
  
  // If type has explicit output_dir, use it
  if (type.outputDir) return type.outputDir;
  
  // Otherwise, check ancestors for explicit output_dir
  for (const ancestorName of type.ancestors) {
    const ancestor = schema.types.get(ancestorName);
    if (ancestor?.outputDir) return ancestor.outputDir;
  }
  
  // No explicit output_dir found - compute from type hierarchy
  return computeDefaultOutputDir(schema, resolvedName);
}

/**
 * Compute the default output directory from the type hierarchy.
 * 
 * Example: task (extends objective, extends meta) → "objectives/tasks"
 * 
 * The path is built by:
 * 1. Taking the ancestor chain (excluding 'meta')
 * 2. Adding the type itself
 * 3. Using the plural form of each type name
 * 4. Joining with '/'
 */
export function computeDefaultOutputDir(schema: LoadedSchema, typeName: string): string {
  const type = schema.types.get(typeName);
  if (!type) return autoPluralise(typeName);
  
  // Build chain: ancestors (excluding meta) + self
  const chain = [...type.ancestors, typeName]
    .filter(t => t !== META_TYPE);
  
  // Map each type name to its plural form
  const plurals = chain.map(t => {
    const typeObj = schema.types.get(t);
    return typeObj?.plural ?? autoPluralise(t);
  });
  
  return plurals.join('/');
}

/**
 * Get the plural form of a type name.
 * Returns the custom plural if defined, otherwise auto-pluralises.
 */
export function getPluralName(schema: LoadedSchema, typeName: string): string {
  const type = schema.types.get(typeName);
  return type?.plural ?? autoPluralise(typeName);
}

// ============================================================================
// Legacy API Compatibility
// ============================================================================

// These functions maintain backward compatibility with code that uses the old API.
// They work with LoadedSchema instead of raw Schema.

/**
 * @deprecated Use getTypeNames(schema) instead
 */
export function getTypeFamilies(schema: LoadedSchema): string[] {
  // In the new model, "families" are top-level types (direct children of meta)
  const meta = schema.types.get(META_TYPE);
  return meta?.children ?? [];
}

/**
 * @deprecated Type paths are no longer used
 */
export function parseTypePath(typePath: string): string[] {
  return typePath.split('/').filter(Boolean);
}

/**
 * @deprecated Use getType(schema, typeName) instead
 */
export function getTypeDefByPath(schema: LoadedSchema, typePath: string): ResolvedType | undefined {
  // For backward compatibility, handle both paths and names
  const segments = parseTypePath(typePath);
  const typeName = segments[segments.length - 1];
  return typeName ? schema.types.get(typeName) : undefined;
}

/**
 * @deprecated Types no longer have nested subtypes
 */
export function hasSubtypes(type: ResolvedType): boolean {
  return type.children.length > 0;
}

/**
 * @deprecated Use type.children instead
 */
export function getSubtypeKeys(type: ResolvedType): string[] {
  return type.children;
}

/**
 * @deprecated Use single 'type' field
 */
export function discriminatorName(_parentName: string | undefined): string {
  return 'type';
}

/**
 * @deprecated Use getFieldOrder(schema, typeName) instead
 */
export function getFrontmatterOrder(type: ResolvedType): string[] {
  return type.fieldOrder;
}

/**
 * @deprecated Use getFieldOrder(schema, typeName) instead
 */
export function getOrderedFieldNames(
  _schema: LoadedSchema,
  _typePath: string,
  type: ResolvedType
): string[] {
  return type.fieldOrder;
}

/**
 * @deprecated Use resolveTypeFromFrontmatter(schema, frontmatter) instead
 */
export function resolveTypePathFromFrontmatter(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>
): string | undefined {
  return resolveTypeFromFrontmatter(schema, frontmatter);
}

/**
 * @deprecated Use single 'type' field
 */
export function getDiscriminatorFieldsFromTypePath(
  typePath: string
): Record<string, string> {
  const segments = parseTypePath(typePath);
  const typeName = segments[segments.length - 1];
  return typeName ? { type: typeName } : {};
}

// ============================================================================
// Ownership API
// ============================================================================

/**
 * Check if a type can be owned by any other type.
 * Returns true if any type has an `owned: true` field that references this type.
 */
export function canTypeBeOwned(schema: LoadedSchema, typeName: string): boolean {
  return schema.ownership.canBeOwnedBy.has(typeName);
}

/**
 * Get all types that can own a given child type.
 * Returns owner info sorted alphabetically by owner type name.
 */
export function getOwnerTypes(schema: LoadedSchema, childTypeName: string): OwnerInfo[] {
  const owners = schema.ownership.canBeOwnedBy.get(childTypeName) ?? [];
  // Sort alphabetically by owner type name
  return [...owners].sort((a, b) => a.ownerType.localeCompare(b.ownerType));
}

/**
 * Get all owned fields for a given owner type.
 * Returns info about what child types this type can own.
 */
export function getOwnedFields(schema: LoadedSchema, ownerTypeName: string): OwnedFieldInfo[] {
  return schema.ownership.owns.get(ownerTypeName) ?? [];
}

/**
 * Check if a specific type owns another specific type.
 */
export function doesTypeOwn(
  schema: LoadedSchema,
  ownerTypeName: string,
  childTypeName: string
): boolean {
  const ownedFields = schema.ownership.owns.get(ownerTypeName) ?? [];
  return ownedFields.some(f => f.childType === childTypeName);
}

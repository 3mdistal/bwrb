import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  BwrbSchema,
  type Schema,
  type Field,
  type BodySection,
  type ResolvedType,
  type LoadedSchema,
  type OwnershipMap,
  type OwnedFieldInfo,
  type OwnerInfo,
} from '../types/schema.js';

const SCHEMA_PATH = '.bwrb/schema.json';
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
 */
export async function loadSchema(vaultDir: string): Promise<LoadedSchema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  
  // Parse as v2 schema
  const schema = BwrbSchema.parse(json);
  return resolveSchema(schema);
}

/**
 * Load raw schema without resolving inheritance (for migration tools).
 */
export async function loadRawSchema(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return BwrbSchema.parse(json);
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
  
  // Copy enums
  if (schema.enums) {
    for (const [name, values] of Object.entries(schema.enums)) {
      enums.set(name, values);
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
      // If the type extends another type, parent can be either the extended type OR same type
      // This enables mixed hierarchies like: scene -> chapter OR scene -> scene
      let source: string | string[];
      if (type.parent && type.parent !== META_TYPE) {
        // Type extends another type - allow both as valid parents
        source = [type.parent, type.name];
      } else {
        // No extends (or extends meta) - parent can only be same type
        source = type.name;
      }
      
      type.fields['parent'] = {
        prompt: 'dynamic',
        source,
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
  
  return { raw: schema, types, enums, ownership };
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
  
  // Apply type's own fields (can override inherited fields in specific ways)
  const rawType = type as { fields?: Record<string, Field> };
  if (rawType.fields) {
    for (const [fieldName, fieldDef] of Object.entries(rawType.fields)) {
      if (fields[fieldName]) {
        // Field exists from ancestor
        // Allow 'default' override per spec
        if (fieldDef.default !== undefined) {
          fields[fieldName] = { ...fields[fieldName], default: fieldDef.default };
        }
        // Also allow 'value' override - this is needed for type identity fields
        // where each type has its own fixed value (e.g., type: task vs type: objective)
        if (fieldDef.value !== undefined) {
          fields[fieldName] = { ...fields[fieldName], value: fieldDef.value };
        }
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
        // For ownership, use the first source type (arrays are for parent field accepting multiple types)
        const childType = Array.isArray(field.source) ? field.source[0] : field.source;
        if (!childType) continue;
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
// Type Lookup (New API)
// ============================================================================

/**
 * Get a resolved type by name.
 */
export function getType(schema: LoadedSchema, typeName: string): ResolvedType | undefined {
  return schema.types.get(typeName);
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
 */
export function getFieldsForType(schema: LoadedSchema, typeName: string): Record<string, Field> {
  const type = getType(schema, typeName);
  return type?.fields ?? {};
}

/**
 * Get the field order for a type (already computed).
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
 * Uses the 'type' field to identify the type.
 */
export function resolveTypeFromFrontmatter(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>
): string | undefined {
  const typeName = frontmatter['type'];
  if (typeof typeName !== 'string') return undefined;
  
  // Check if the type exists in the schema
  if (schema.types.has(typeName)) {
    return typeName;
  }
  
  return undefined;
}

/**
 * Get all valid field names for a type and its descendants.
 * Useful for filter validation.
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
 */
export function getOutputDir(schema: LoadedSchema, typeName: string): string {
  const type = schema.types.get(typeName);
  if (!type) return autoPluralise(typeName); // Fallback for unknown types
  
  // If type has explicit output_dir, use it
  if (type.outputDir) return type.outputDir;
  
  // Otherwise, check ancestors for explicit output_dir
  for (const ancestorName of type.ancestors) {
    const ancestor = schema.types.get(ancestorName);
    if (ancestor?.outputDir) return ancestor.outputDir;
  }
  
  // No explicit output_dir found - compute from type hierarchy
  return computeDefaultOutputDir(schema, typeName);
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
 * @deprecated Type paths are no longer used. Just returns [typeName].
 */
export function parseTypePath(typePath: string): string[] {
  return [typePath];
}

/**
 * @deprecated Use getType(schema, typeName) instead
 */
export function getTypeDefByPath(schema: LoadedSchema, typePath: string): ResolvedType | undefined {
  return schema.types.get(typePath);
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
  typeName: string
): Record<string, string> {
  return { type: typeName };
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

// ============================================================================
// Source Type Resolution (for dynamic fields)
// ============================================================================

/**
 * Result of resolving a source type name.
 */
export type SourceTypeResolution =
  | { success: true; typeName: string }
  | { success: false; error: string; suggestions?: string[] };

/**
 * Calculate Levenshtein distance between two strings.
 * Used for fuzzy matching to suggest corrections for typos.
 */
function levenshteinDistance(a: string, b: string): number {
  // Create matrix with proper initialization
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0)
  );

  // Initialize first column
  for (let i = 0; i <= a.length; i++) {
    matrix[i]![0] = i;
  }
  // Initialize first row
  for (let j = 0; j <= b.length; j++) {
    matrix[0]![j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = matrix[i]!;
      const prevRow = matrix[i - 1]!;
      row[j] = Math.min(
        prevRow[j]! + 1,        // deletion
        row[j - 1]! + 1,        // insertion
        prevRow[j - 1]! + cost  // substitution
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

/**
 * Find close matches for a string within a list of candidates.
 * Returns candidates within the specified maximum distance, sorted by distance.
 */
function findCloseMatches(target: string, candidates: string[], maxDistance: number): string[] {
  const matches: Array<{ candidate: string; distance: number }> = [];

  for (const candidate of candidates) {
    const distance = levenshteinDistance(target.toLowerCase(), candidate.toLowerCase());
    if (distance <= maxDistance && distance > 0) {
      matches.push({ candidate, distance });
    }
  }

  // Sort by distance (closest first)
  matches.sort((a, b) => a.distance - b.distance);

  return matches.map(m => m.candidate);
}

/**
 * Check if a value matches any enum value in the schema.
 * Returns the enum name if found, undefined otherwise.
 */
function findEnumContainingValue(schema: LoadedSchema, value: string): string | undefined {
  for (const [enumName, values] of schema.enums) {
    if (values.includes(value)) {
      return enumName;
    }
  }
  return undefined;
}

/**
 * Resolve a source type name with helpful error messages.
 * 
 * This function validates that a source type exists and provides
 * actionable error messages when it doesn't, including:
 * - Detecting enum value confusion (e.g., "person" being an enum value, not a type)
 * - Suggesting similar type names for typos
 * - Listing available types when no close match is found
 */
export function resolveSourceType(
  schema: LoadedSchema,
  source: string
): SourceTypeResolution {
  // Direct match - source is a valid type
  if (schema.types.has(source)) {
    return { success: true, typeName: source };
  }

  const availableTypes = getConcreteTypeNames(schema);

  // Check for old path format (e.g., "note/task" or "foo/bar")
  // V2 uses flat type names, not paths
  if (source.includes('/')) {
    const parts = source.split('/');
    const lastPart = parts[parts.length - 1] ?? '';
    
    // Check if the last segment is a valid type
    if (lastPart && schema.types.has(lastPart)) {
      return {
        success: false,
        error: `Source "${source}" uses path format which is no longer supported.\n` +
          `Use just the type name: "${lastPart}"`,
        suggestions: [lastPart],
      };
    }
    
    // Neither segment is valid - generic path format error
    return {
      success: false,
      error: `Source "${source}" uses path format which is not supported.\n` +
        `Available types: ${availableTypes.join(', ')}`,
    };
  }

  // Check if the source matches an enum value
  const enumName = findEnumContainingValue(schema, source);
  if (enumName) {
    return {
      success: false,
      error: `"${source}" is a value in the "${enumName}" enum, not a type name.\n` +
        `Dynamic sources must reference types.\n` +
        `Available types: ${availableTypes.join(', ')}\n\n` +
        `Hint: If you want to filter by this enum value, set the source to the ` +
        `parent type and add a filter in the schema.`,
    };
  }

  // Check for typos using fuzzy matching
  const closeMatches = findCloseMatches(source, availableTypes, 3);

  if (closeMatches.length > 0) {
    return {
      success: false,
      error: `Source type "${source}" does not exist.\n` +
        `Did you mean: ${closeMatches.join(', ')}?`,
      suggestions: closeMatches,
    };
  }

  // No close match - list all available types
  return {
    success: false,
    error: `Source type "${source}" does not exist.\n` +
      `Available types: ${availableTypes.join(', ')}`,
  };
}

// ============================================================================
// Field Origin Tracking (for schema show inheritance display)
// ============================================================================

/**
 * Fields grouped by their origin type.
 * Used by `schema show` to display own vs inherited fields.
 */
export interface FieldsByOrigin {
  /** Fields defined directly on this type */
  ownFields: Record<string, Field>;
  /** Fields inherited from ancestors, grouped by the type that defined them */
  inheritedFields: Map<string, Record<string, Field>>;
}

/**
 * Get fields for a type grouped by their origin (own vs inherited).
 * 
 * This function analyzes where each field in a type's effective field set
 * was originally defined, grouping them into:
 * - ownFields: fields defined directly in this type's raw schema
 * - inheritedFields: fields from ancestors, keyed by the ancestor that defined them
 * 
 * @param schema The loaded schema
 * @param typeName The type to analyze
 * @returns Fields grouped by origin
 */
export function getFieldsByOrigin(
  schema: LoadedSchema,
  typeName: string
): FieldsByOrigin {
  const type = getType(schema, typeName);
  if (!type) {
    return { ownFields: {}, inheritedFields: new Map() };
  }

  // Get raw type definition to find own fields
  const rawType = schema.raw.types[typeName];
  const ownFieldNames = new Set(Object.keys(rawType?.fields ?? {}));

  const ownFields: Record<string, Field> = {};
  const inheritedFields = new Map<string, Record<string, Field>>();

  // Get effective (merged) fields from the resolved type
  const effectiveFields = type.fields;

  for (const [fieldName, field] of Object.entries(effectiveFields)) {
    if (ownFieldNames.has(fieldName)) {
      ownFields[fieldName] = field;
    } else {
      // Find which ancestor defined this field
      const origin = findFieldOrigin(schema, type.ancestors, fieldName);
      if (origin) {
        if (!inheritedFields.has(origin)) {
          inheritedFields.set(origin, {});
        }
        inheritedFields.get(origin)![fieldName] = field;
      }
    }
  }

  return { ownFields, inheritedFields };
}

/**
 * Find which ancestor type originally defined a field.
 * Walks the ancestor chain from parent to root, returning the first
 * type that has this field in its raw definition.
 */
function findFieldOrigin(
  schema: LoadedSchema,
  ancestors: string[],
  fieldName: string
): string | undefined {
  // Walk ancestors from parent to root
  for (const ancestorName of ancestors) {
    const rawAncestor = schema.raw.types[ancestorName];
    if (rawAncestor?.fields?.[fieldName]) {
      return ancestorName;
    }
  }
  return undefined;
}

/**
 * Get the field order for a specific origin type's fields.
 * Returns fields in the order they were defined on that type.
 */
export function getFieldOrderForOrigin(
  schema: LoadedSchema,
  originTypeName: string,
  fieldNames: string[]
): string[] {
  const originType = schema.types.get(originTypeName);
  if (!originType) {
    return fieldNames;
  }

  // Use the origin type's field order to sort
  const orderedFields: string[] = [];
  for (const fieldName of originType.fieldOrder) {
    if (fieldNames.includes(fieldName)) {
      orderedFields.push(fieldName);
    }
  }

  // Add any remaining fields not in the explicit order
  for (const fieldName of fieldNames) {
    if (!orderedFields.includes(fieldName)) {
      orderedFields.push(fieldName);
    }
  }

  return orderedFields;
}

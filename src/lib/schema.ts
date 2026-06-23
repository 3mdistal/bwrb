import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { basename } from 'path';
import { SCHEMA_RELATIVE_PATH } from './bwrb-paths.js';
import { closeMatchValues } from './close-match.js';
import type { DatePrecision } from './local-date.js';
import {
  BwrbSchema,
  type Schema,
  type Field,
  type Trait,
  type Recurrence,
  type ResolvedType,
  type ResolvedConfig,
  type LoadedSchema,
  type OwnershipMap,
  type OwnedFieldInfo,
  type OwnerInfo,
  getOptionValues,
} from '../types/schema.js';

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
export async function loadCurrentSchema(vaultDir: string): Promise<LoadedSchema> {
  const schemaPath = join(vaultDir, SCHEMA_RELATIVE_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  
  // Parse as v2 schema
  const schema = BwrbSchema.parse(json);
  return resolveSchema(schema);
}

/**
 * Backwards-compatible alias for loading the current schema.
 */
export async function loadSchema(vaultDir: string): Promise<LoadedSchema> {
  return loadCurrentSchema(vaultDir);
}

// ============================================================================
// Schema Resolution (Inheritance Tree Building)
// ============================================================================

/**
 * Resolve a parsed schema into a LoadedSchema with computed inheritance.
 */
export function resolveSchema(schema: Schema): LoadedSchema {
  const types = new Map<string, ResolvedType>();
  
  // Create implicit meta type if not defined
  if (!schema.types[META_TYPE]) {
    types.set(META_TYPE, createImplicitMeta());
  }
  
  // First pass: create base ResolvedType entries
  for (const [name, typeDef] of Object.entries(schema.types)) {
    types.set(name, {
      name,
      description: typeDef.description,
      parent: typeDef.extends ?? (name === META_TYPE ? undefined : META_TYPE),
      traits: typeDef.traits ?? [],
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

  // Validate trait references: every trait a type composes must be declared.
  validateTraits(types, schema.traits);
  
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
  
  // Third pass: compute effective fields (inherit from ancestors, then compose
  // traits, then apply the type's own fields). See computeEffectiveFields for
  // the exact precedence order.
  const traits = schema.traits ?? {};
  for (const type of types.values()) {
    type.fields = computeEffectiveFields(types, type, traits);
    type.fieldOrder = computeFieldOrder(types, type, traits);
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
        prompt: 'relation',
        source,
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
  
  // Sixth pass: resolve configuration with defaults
  const config = resolveConfig(schema.config);
  
  return { raw: schema, types, ownership, config };
}

/**
 * Create the implicit meta type.
 */
function createImplicitMeta(): ResolvedType {
  return {
    name: META_TYPE,
    description: undefined,
    parent: undefined,
    traits: [],
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
 * Validate trait references.
 *
 * A type that composes an unknown trait is a deterministic schema error — the
 * same class of failure as `extends` pointing at an unknown type. Traits are
 * flat (a trait cannot compose other traits or extend a type), so the only
 * thing to check here is that every referenced trait is declared.
 */
function validateTraits(
  types: Map<string, ResolvedType>,
  traits: Record<string, Trait> | undefined
): void {
  const declared = traits ?? {};
  const available = Object.keys(declared);

  for (const [name, type] of types) {
    for (const traitName of type.traits) {
      if (!(traitName in declared)) {
        const hint = available.length > 0
          ? `Available traits: ${available.join(', ')}`
          : 'No traits are declared. Add a top-level "traits" object to the schema.';
        throw new Error(
          `Type "${name}" composes unknown trait "${traitName}". ${hint}`
        );
      }
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
 * Compute effective fields for a type.
 *
 * Resolution layers fields from least- to most-specific source, so a later
 * layer fully replaces a same-named field from an earlier one. Final precedence
 * (highest wins):
 *
 *   own type fields  >  traits  >  inherited (parent chain)
 *
 * - **Inherited** fields come first (root ancestor → parent). Within the chain,
 *   a closer ancestor's field replaces a farther one (existing behavior).
 * - **Traits** are composed next, in the order the type lists them. A trait
 *   field fully replaces an inherited field of the same name, and a *later*
 *   trait in the array fully replaces an earlier trait's field (last-wins).
 * - **Own fields** are applied last and depend on what the colliding field's
 *   origin is:
 *   - colliding field came from a **trait** → own **fully replaces** it (the
 *     "own wins over traits" guarantee — own's `prompt`/`options`/`label`/etc.
 *     all win).
 *   - colliding field came from **inheritance** (parent chain, no trait
 *     involved) → keep the historical **restricted merge**: only
 *     `default`/`value`/`description`/`granularity` merge onto the inherited
 *     definition; structural keys stay inherited.
 *   - no collision → it is simply a new field.
 *
 *   Note: when a trait already fully replaced a parent field, that field's
 *   tracked origin is `trait`, so an own field full-overrides it (own's label
 *   wins, no trait leak).
 */
function computeEffectiveFields(
  types: Map<string, ResolvedType>,
  type: ResolvedType,
  traits: Record<string, Trait>
): Record<string, Field> {
  const fields: Record<string, Field> = {};
  // Track the origin of each accumulated field so own-field collisions can
  // distinguish "came from a trait" (full override) from "came from
  // inheritance" (restricted merge). Own fields never land here mid-loop.
  const origin = new Map<string, 'inherited' | 'trait'>();

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
          origin.set(fieldName, 'inherited');
        }
      }
    }
  }

  // Compose traits in declaration order. A trait field fully replaces a
  // same-named inherited field; later traits replace earlier ones (last-wins).
  for (const traitName of type.traits) {
    const trait = traits[traitName];
    if (trait?.fields) {
      for (const [fieldName, fieldDef] of Object.entries(trait.fields)) {
        fields[fieldName] = { ...fieldDef };
        origin.set(fieldName, 'trait');
      }
    }
  }

  // Apply type's own fields.
  const rawType = type as { fields?: Record<string, Field> };
  if (rawType.fields) {
    for (const [fieldName, fieldDef] of Object.entries(rawType.fields)) {
      const existingOrigin = fields[fieldName] ? origin.get(fieldName) : undefined;

      if (existingOrigin === 'inherited') {
        // Collision with an INHERITED field → historical restricted merge:
        // only default/value/description/granularity merge; structural keys
        // (prompt/options/label/...) stay inherited.
        if (fieldDef.default !== undefined) {
          fields[fieldName] = { ...fields[fieldName], default: fieldDef.default };
        }
        // Also allow 'value' override - this is needed for type identity fields
        // where each type has its own fixed value (e.g., type: task vs type: objective)
        if (fieldDef.value !== undefined) {
          fields[fieldName] = { ...fields[fieldName], value: fieldDef.value };
        }
        // Allow 'description' override - a subtype can document an inherited
        // field with meaning specific to its context.
        if (fieldDef.description !== undefined) {
          fields[fieldName] = { ...fields[fieldName], description: fieldDef.description };
        }
        // Allow 'granularity' override - a subtype can loosen or tighten the
        // precision required for an inherited date field.
        if (fieldDef.granularity !== undefined) {
          fields[fieldName] = { ...fields[fieldName], granularity: fieldDef.granularity };
        }
      } else {
        // Collision with a TRAIT field (existingOrigin === 'trait') → own FULLY
        // replaces it. Also the no-collision case → new own field. Either way
        // the own definition stands on its own.
        fields[fieldName] = { ...fieldDef };
      }
    }
  }

  return fields;
}

/**
 * Compute field order by combining ancestor field orders.
 *
 * Order follows resolution layering: inherited (root → parent), then
 * trait-contributed fields (in trait declaration order), then the type's own
 * fields. An explicit, complete `field_order` on the type overrides all of this.
 */
function computeFieldOrder(
  types: Map<string, ResolvedType>,
  type: ResolvedType,
  traits: Record<string, Trait>
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

  // Add trait-contributed fields next, in trait declaration order.
  for (const traitName of type.traits) {
    const trait = traits[traitName];
    if (trait?.fields) {
      for (const fieldName of Object.keys(trait.fields)) {
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
// Configuration Resolution
// ============================================================================

/**
 * Resolve configuration with defaults.
 * Falls back to environment variables and sensible defaults.
 */
function resolveConfig(config: Schema['config']): ResolvedConfig {
  return {
    linkFormat: config?.link_format ?? 'wikilink',
    editor: config?.editor ?? process.env.EDITOR,
    visual: config?.visual ?? process.env.VISUAL,
    openWith: config?.open_with ?? 'system',
    obsidianVault: config?.obsidian_vault,
    defaultDashboard: config?.default_dashboard,
    dateFormat: config?.date_format ?? 'YYYY-MM-DD',
    dateGranularity: config?.date_granularity ?? 'day',
    // Default mirrors DEFAULT_FUZZY_MAX_DISTANCE in audit/unlinked-mention.ts.
    // Inlined to avoid importing the audit module into the schema loader (#622).
    mentionFuzzyThreshold: config?.mention_fuzzy_threshold ?? 2,
  };
}

/**
 * Detect Obsidian vault name from a vault directory.
 * Looks for .obsidian folder and tries to extract vault name.
 */
export function detectObsidianVault(vaultDir: string): string | undefined {
  const obsidianDir = join(vaultDir, '.obsidian');
  if (!existsSync(obsidianDir)) {
    return undefined;
  }
  
  // Use the vault directory name as the vault name
  // This matches how Obsidian typically names vaults
  return basename(vaultDir);
}

// ============================================================================
// Type Lookup (New API)
// ============================================================================

/**
 * Get a resolved type by name.
 */
export function getType(schema: LoadedSchema, typeName: string): ResolvedType | undefined {
  const direct = schema.types.get(typeName);
  if (direct) return direct;

  // Support legacy slash-notation (e.g. "objective/task" → "task").
  if (typeName.includes('/')) {
    const segments = typeName.split('/');
    const leafName = segments[segments.length - 1]!;
    const resolved = schema.types.get(leafName);
    if (resolved) {
      const ancestors = new Set(resolved.ancestors);
      const parentSegments = segments.slice(0, -1);
      if (parentSegments.every(seg => ancestors.has(seg))) return resolved;
    }
  }

  return undefined;
}

/**
 * Get all type names.
 */
export function getTypeNames(schema: LoadedSchema): string[] {
  return Array.from(schema.types.keys());
}

/**
 * Get all concrete type names (types that can have instances).
 * In the new model, all types are potentially concrete.
 */
export function getConcreteTypeNames(schema: LoadedSchema): string[] {
  return Array.from(schema.types.keys()).filter(name => name !== META_TYPE);
}

/**
 * Get all unique field names defined directly on any type (own fields only).
 * This returns field names that can be edited/deleted in the schema.
 * Does not include inherited fields - only fields defined directly on types.
 */
export function getAllOwnFieldNames(schema: LoadedSchema): string[] {
  const fieldNames = new Set<string>();
  
  for (const typeDef of Object.values(schema.raw.types)) {
    if (typeDef.fields) {
      for (const fieldName of Object.keys(typeDef.fields)) {
        fieldNames.add(fieldName);
      }
    }
  }
  
  return Array.from(fieldNames);
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
 * Get options for a select field.
 * Options are defined inline on the field.
 */
export function getFieldOptions(field: Field): string[] {
  return getOptionValues(field.options);
}

/**
 * Resolve the effective date granularity for a field.
 * A field's own `granularity` overrides the global `config.date_granularity`,
 * which defaults to 'day' (strict full YYYY-MM-DD).
 */
export function resolveDateGranularity(
  field: Field,
  config: ResolvedConfig
): DatePrecision {
  return field.granularity ?? config.dateGranularity;
}

/**
 * Get the effective fields for a type (already computed).
 */
export function getFieldsForType(schema: LoadedSchema, typeName: string): Record<string, Field> {
  const type = getType(schema, typeName);
  return type?.fields ?? {};
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
    const legacySubtype = frontmatter[`${typeName}-type`];
    if (typeof legacySubtype === 'string') {
      const subtype = schema.types.get(legacySubtype);
      if (subtype?.parent === typeName) {
        return legacySubtype;
      }
    }

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
 * Get field options for a field in a type (for select prompts).
 */
export function getOptionsForField(
  schema: LoadedSchema,
  typeName: string,
  fieldName: string
): string[] {
  const type = schema.types.get(typeName);
  if (!type) return [];
  
  const field = type.fields[fieldName];
  return getOptionValues(field?.options);
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
  // Direct lookup first (most common case)
  const direct = schema.types.get(typePath);
  if (direct) return direct;

  // Support legacy slash-notation (e.g. "objective/task" → "task").
  // Types are flat with inheritance; the last segment is the actual type name.
  if (typePath.includes('/')) {
    const segments = typePath.split('/');
    const typeName = segments[segments.length - 1]!;
    const resolved = schema.types.get(typeName);
    if (resolved) {
      // Validate that the ancestor chain is consistent with the slash path
      // e.g. "objective/task" is valid only if task's ancestor chain includes "objective"
      const ancestors = new Set(resolved.ancestors);
      const parentSegments = segments.slice(0, -1);
      const chainValid = parentSegments.every(seg => ancestors.has(seg));
      if (chainValid) return resolved;
    }
  }

  return undefined;
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

// ============================================================================
// Alias Role API
// ============================================================================

/**
 * Find the name of the field that carries the `alias` role for a type, if any.
 *
 * Aliases are a recognized field role (like `owned`): a type may declare at most
 * one field with `alias: true`, and that field holds the entity's alternate
 * names. Resolved fields are consulted so inherited alias fields are honored.
 *
 * If more than one field declares the role (a schema mistake), the first in
 * resolved field order wins, keeping resolution deterministic.
 */
export function getAliasFieldName(schema: LoadedSchema, typeName: string): string | undefined {
  const fields = getFieldsForType(schema, typeName);
  for (const [fieldName, field] of Object.entries(fields)) {
    if (field.alias === true) return fieldName;
  }
  return undefined;
}

/**
 * Extract an entity's declared aliases from its frontmatter.
 *
 * Reads the value of the type's alias-role field (see {@link getAliasFieldName})
 * and returns it as a deduplicated list of non-empty, trimmed strings. Returns
 * an empty array when the type declares no alias field, the field is absent, or
 * the value is malformed — callers get a clean list to match against regardless
 * of how the underlying note is shaped (back-compat safe).
 *
 * This is the single accessor that name-resolution and linking use to learn an
 * entity's aliases, and the hook later work (search --fuzzy, audit
 * unlinked-mention) builds on.
 */
export function getEntityAliases(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>
): string[] {
  const aliasField = getAliasFieldName(schema, typeName);
  if (!aliasField) return [];

  const raw = frontmatter[aliasField];
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    aliases.push(trimmed);
  }
  return aliases;
}

// ============================================================================
// Unknown Type Suggestions ("did you mean a type?")
// ============================================================================

/**
 * Suggest the closest concrete type name for a (likely-misspelled) type name.
 *
 * Used to surface a "Did you mean 'X'?" hint when a user supplies an unknown
 * type on the CLI (`--type`, a positional type arg, etc.). Mirrors the
 * field/option typo-suggestion behavior used elsewhere:
 * - Returns undefined for an exact match (nothing to suggest) or when no
 *   candidate is within a sensible edit-distance threshold.
 * - The threshold scales with the input length (so short type names like
 *   `ide`→`idea` still match) but is capped so wildly-different input
 *   (`completely-unknown`) yields no bogus suggestion.
 *
 * Returns only the single closest match to keep the hint focused and
 * consistent with `suggestFieldName`.
 */
export function suggestTypeName(
  schema: LoadedSchema,
  typeName: string
): string | undefined {
  if (schema.types.has(typeName)) return undefined;

  const availableTypes = getConcreteTypeNames(schema);

  // Case-only mismatch: if the input matches a real type name except for
  // casing (e.g. `TASK` → `task`), the canonical-case name is the single most
  // useful "did you mean" — surface it directly. The distance-based path below
  // can't, because it case-folds both sides and then drops the resulting
  // distance-0 row via `excludeExact`. Valid correct-case types already
  // returned above, so this never fires for a genuinely valid type.
  const lowered = typeName.toLowerCase();
  const caseMatch = availableTypes.find((t) => t.toLowerCase() === lowered);
  if (caseMatch) return caseMatch;

  // Threshold: at most 3 edits, but never more than 60% of the input length so
  // very short inputs don't match unrelated types and long gibberish is rejected.
  const maxDistance = Math.min(3, Math.ceil(typeName.length * 0.6));
  const matches = closeMatchValues(typeName, availableTypes, {
    maxDistance,
    excludeExact: true,
  });
  return matches[0];
}

/**
 * Build the standard "Unknown type" error message, appending a
 * "Did you mean 'X'?" hint when a close match exists.
 *
 * This is the single shared formatter used by every command that accepts a
 * type name (`list`/`recent`/`search`/`audit`/`bulk`/`dashboard`/`new`/
 * `schema list`/`edit`/`template *`). Keeping the `Unknown type: <name>` prefix preserves
 * the existing message shape (and JSON error payload), only adding the
 * suggestion — so valid types are unaffected and JSON consumers get the hint
 * inline in the error string.
 */
export function formatUnknownTypeError(
  schema: LoadedSchema,
  typeName: string
): string {
  const suggestion = suggestTypeName(schema, typeName);
  const base = `Unknown type: ${typeName}`;
  return suggestion ? `${base}. Did you mean '${suggestion}'?` : base;
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
  /**
   * Fields contributed by composed traits, grouped by the trait that provided
   * the effective definition. A field appears under exactly one trait — the one
   * that won precedence (later traits in the array win) — and only when no own
   * field of the same name shadowed it.
   */
  traitFields: Map<string, Record<string, Field>>;
}

/**
 * Get fields for a type grouped by their origin (own vs inherited).
 * 
 * This function analyzes where each field in a type's effective field set
 * was originally defined, grouping them into:
 * - ownFields: fields defined directly in this type's raw schema
 * - traitFields: fields contributed by a composed trait, keyed by the winning
 *   trait (last in the array for a colliding name)
 * - inheritedFields: fields from ancestors, keyed by the ancestor that defined them
 *
 * Attribution priority matches resolution precedence (own > trait > inherited):
 * a field declared on the type itself is always attributed to `own` (even when
 * it restricted-merged onto an inherited field), and the field OBJECT returned
 * for every group is the resolved *winner's* definition from `type.fields`.
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
    return { ownFields: {}, inheritedFields: new Map(), traitFields: new Map() };
  }

  // Get raw type definition to find own fields
  const rawType = schema.raw.types[typeName];
  const ownFieldNames = new Set(Object.keys(rawType?.fields ?? {}));

  const ownFields: Record<string, Field> = {};
  const inheritedFields = new Map<string, Record<string, Field>>();
  const traitFields = new Map<string, Record<string, Field>>();

  // Get effective (merged) fields from the resolved type
  const effectiveFields = type.fields;

  for (const [fieldName, field] of Object.entries(effectiveFields)) {
    if (ownFieldNames.has(fieldName)) {
      ownFields[fieldName] = field;
      continue;
    }

    // Traits take precedence over inheritance, so attribute to the winning
    // trait (last in the array) before falling back to an ancestor.
    const traitOrigin = findTraitOrigin(schema, type.traits, fieldName);
    if (traitOrigin) {
      if (!traitFields.has(traitOrigin)) {
        traitFields.set(traitOrigin, {});
      }
      traitFields.get(traitOrigin)![fieldName] = field;
      continue;
    }

    // Find which ancestor defined this field
    const origin = findFieldOrigin(schema, type.ancestors, fieldName);
    if (origin) {
      if (!inheritedFields.has(origin)) {
        inheritedFields.set(origin, {});
      }
      inheritedFields.get(origin)![fieldName] = field;
    }
  }

  return { ownFields, inheritedFields, traitFields };
}

/**
 * Find which composed trait provides a field, honoring precedence.
 *
 * Later traits in the array win, so we scan the type's trait list in reverse
 * and return the first trait that declares the field. Returns undefined when no
 * composed trait contributes the field.
 */
function findTraitOrigin(
  schema: LoadedSchema,
  typeTraits: string[],
  fieldName: string
): string | undefined {
  const declared = schema.raw.traits ?? {};
  for (let i = typeTraits.length - 1; i >= 0; i--) {
    const traitName = typeTraits[i]!;
    if (declared[traitName]?.fields?.[fieldName]) {
      return traitName;
    }
  }
  return undefined;
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

/**
 * Order a trait's contributed field names by the trait's own declaration order.
 * Mirrors {@link getFieldOrderForOrigin} but resolves against the trait map
 * rather than the type map. Fields not present in the trait definition are
 * appended in their incoming order to stay deterministic.
 */
export function getFieldOrderForTrait(
  schema: LoadedSchema,
  traitName: string,
  fieldNames: string[]
): string[] {
  const trait = schema.raw.traits?.[traitName];
  if (!trait?.fields) {
    return fieldNames;
  }

  const ordered: string[] = [];
  for (const fieldName of Object.keys(trait.fields)) {
    if (fieldNames.includes(fieldName)) {
      ordered.push(fieldName);
    }
  }
  for (const fieldName of fieldNames) {
    if (!ordered.includes(fieldName)) {
      ordered.push(fieldName);
    }
  }
  return ordered;
}

/**
 * Get all declared trait names in the schema.
 */
export function getTraitNames(schema: LoadedSchema): string[] {
  return Object.keys(schema.raw.traits ?? {});
}

// ============================================================================
// Recurrence (Task System, #107)
// ============================================================================

/**
 * Resolve the recurrence configuration for a type, if any of its composed
 * traits carry one.
 *
 * Recurrence rides on a trait (the `recurring` trait). A type can compose
 * multiple traits; if more than one carries a `recurrence` block, the LATER
 * trait in the type's `traits` array wins — matching the last-wins precedence
 * used for trait fields. Returns the resolved recurrence config plus the name
 * of the trait that provided it, or undefined when the type recurs through no
 * trait.
 */
export function getRecurrenceForType(
  schema: LoadedSchema,
  typeName: string
): { recurrence: Recurrence; trait: string } | undefined {
  const type = getType(schema, typeName);
  if (!type) return undefined;

  const declared = schema.raw.traits ?? {};
  // Scan in reverse so the last trait that declares recurrence wins.
  for (let i = type.traits.length - 1; i >= 0; i--) {
    const traitName = type.traits[i]!;
    const recurrence = declared[traitName]?.recurrence;
    if (recurrence) {
      return { recurrence, trait: traitName };
    }
  }
  return undefined;
}

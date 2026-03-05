import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import { getAllFieldsForType, getType, resolveTypeFromFrontmatter } from './schema.js';
import { matchesExpression, buildEvalContext, type HierarchyData } from './expression.js';
import { collectFrontmatterKeys, normalizeWhereExpressions } from './where-normalize.js';
import { extractLinkTarget } from './links.js';

/**
 * Validate that a field name is valid for a type.
 */
export function validateFieldForType(
  schema: LoadedSchema,
  typeName: string,
  fieldName: string
): { valid: boolean; error?: string } {
  const validFields = getAllFieldsForType(schema, typeName);

  if (!validFields.has(fieldName)) {
    const fieldList = Array.from(validFields).join(', ');
    return {
      valid: false,
      error: `Unknown field '${fieldName}' for type '${typeName}'. Valid fields: ${fieldList}`,
    };
  }

  return { valid: true };
}

/**
 * Options for applyFrontmatterFilters.
 */
export interface FrontmatterFilterOptions {
  /** Expression-based filters (--where) */
  whereExpressions: string[];
  /** Vault directory for building eval context */
  vaultDir: string;
  /** Optional known frontmatter keys for normalization */
  knownKeys?: Set<string>;
  /** Optional schema for resolving parent-like hierarchy fields */
  schema?: LoadedSchema;
  /** Optional type path for type-aware hierarchy resolution */
  typePath?: string;
}

// ============================================================================
// Hierarchy Function Support
// ============================================================================

/** Names of functions that require hierarchy data */
const HIERARCHY_FUNCTIONS = ['isRoot', 'isChildOf', 'isDescendantOf'];

/**
 * Check if any expression uses hierarchy functions.
 * This is used to determine if we need to build hierarchy data before evaluation.
 */
function expressionsUseHierarchyFunctions(expressions: string[]): boolean {
  return expressions.some(expr =>
    HIERARCHY_FUNCTIONS.some(fn => expr.includes(fn + '('))
  );
}

/**
 * Build hierarchy data from a set of files for use in expression evaluation.
 * This builds the parent and children maps needed for isRoot, isChildOf, isDescendantOf.
 */
function buildHierarchyDataFromFiles(
  files: FileWithFrontmatter[],
  options: Pick<FrontmatterFilterOptions, 'schema' | 'typePath'>
): HierarchyData {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, Set<string>>();
  const hierarchyFieldCache = new Map<string, string[]>();

  for (const file of files) {
    const noteName = basename(file.path, '.md');
    const typeName = resolveHierarchyType(file.frontmatter, options);
    const hierarchyFields = getHierarchyFields(typeName, options.schema, hierarchyFieldCache);
    const parentValue = getHierarchyParentValue(file.frontmatter, hierarchyFields);

    if (parentValue) {
      const parentTarget = extractLinkTarget(String(parentValue)) ?? String(parentValue).trim();
      if (parentTarget) {
        // Set parent relationship
        parentMap.set(noteName, parentTarget);

        // Build reverse children relationship
        if (!childrenMap.has(parentTarget)) {
          childrenMap.set(parentTarget, new Set());
        }
        childrenMap.get(parentTarget)!.add(noteName);
      }
    }
  }

  return { parentMap, childrenMap };
}

function resolveHierarchyType(
  frontmatter: Record<string, unknown>,
  options: Pick<FrontmatterFilterOptions, 'schema' | 'typePath'>
): string | undefined {
  if (options.typePath) {
    return options.typePath;
  }

  if (!options.schema) {
    return undefined;
  }

  return resolveTypeFromFrontmatter(options.schema, frontmatter);
}

function getHierarchyFields(
  typeName: string | undefined,
  schema: LoadedSchema | undefined,
  cache: Map<string, string[]>
): string[] {
  if (!typeName || !schema) {
    return ['parent', 'owner'];
  }

  const cached = cache.get(typeName);
  if (cached) {
    return cached;
  }

  const type = getType(schema, typeName);
  if (!type) {
    return ['parent', 'owner'];
  }

  const fields = new Set<string>(['parent']);
  const ancestry = new Set(type.ancestors.filter(ancestor => ancestor !== 'meta'));

  if (schema.ownership.canBeOwnedBy.has(typeName)) {
    fields.add('owner');
  }

  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (fieldName === 'parent' || fieldName === 'owner') continue;
    if (field.prompt !== 'relation' || field.multiple === true || !field.source) continue;

    const sources = Array.isArray(field.source) ? field.source : [field.source];
    const matchesParentLikeRelation = sources.some(sourceName => {
      if (fieldName !== sourceName) {
        return false;
      }

      if (sourceName === typeName || ancestry.has(sourceName)) {
        return true;
      }

      const sourceType = getType(schema, sourceName);
      if (!sourceType) {
        return false;
      }

      return sourceType.ancestors.some(
        ancestor => ancestor !== 'meta' && ancestry.has(ancestor)
      );
    });

    if (matchesParentLikeRelation) {
      fields.add(fieldName);
    }
  }

  const resolved = Array.from(fields);
  cache.set(typeName, resolved);
  return resolved;
}

function getHierarchyParentValue(
  frontmatter: Record<string, unknown>,
  hierarchyFields: string[]
): unknown {
  for (const fieldName of hierarchyFields) {
    const value = frontmatter[fieldName];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return undefined;
}

/**
 * A file with its parsed frontmatter.
 */
export interface FileWithFrontmatter {
  path: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Apply frontmatter filters to a list of files.
 * 
 * Filters files using expression filters (--where).
 * Returns only files that match all criteria.
 * 
 * @param files - Array of objects with path and frontmatter
 * @param options - Filter options
 * @returns Filtered array of files
 */
export async function applyFrontmatterFilters<T extends FileWithFrontmatter>(
  files: T[],
  options: FrontmatterFilterOptions
): Promise<T[]> {
  const { whereExpressions, vaultDir, knownKeys, schema, typePath } = options;
  const result: T[] = [];
  const effectiveKnownKeys =
    knownKeys ?? collectFrontmatterKeys(files.map(file => file.frontmatter));
  const normalizedExpressions = normalizeWhereExpressions(
    whereExpressions,
    effectiveKnownKeys
  );
  const expressionPairs = normalizedExpressions.map((normalized, index) => ({
    normalized,
    original: whereExpressions[index] ?? normalized,
  }));

  // Build hierarchy data if any expression uses hierarchy functions
  // This is done once before the loop for efficiency
  let hierarchyData: HierarchyData | undefined;
  if (
    normalizedExpressions.length > 0 &&
    expressionsUseHierarchyFunctions(normalizedExpressions)
  ) {
    hierarchyData = buildHierarchyDataFromFiles(files, {
      ...(schema ? { schema } : {}),
      ...(typePath ? { typePath } : {}),
    });
  }

  for (const file of files) {
    // Apply expression filters (--where style)
    if (expressionPairs.length > 0) {
      const context = await buildEvalContext(file.path, vaultDir, file.frontmatter);
      // Add hierarchy data to context if available
      if (hierarchyData) {
        context.hierarchyData = hierarchyData;
      }
      let allMatch = true;
      for (const { normalized, original } of expressionPairs) {
        try {
          if (!matchesExpression(normalized, context)) {
            allMatch = false;
            break;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(`Expression error in "${original}": ${message}`);
        }
      }

      if (!allMatch) {
        continue;
      }
    }

    result.push(file);
  }

  return result;
}

import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import { getAllFieldsForType, getOptionsForField } from './schema.js';
import { matchesExpression, buildEvalContext, type HierarchyData } from './expression.js';
import { printError } from './prompt.js';
import { extractWikilinkTarget } from './audit/types.js';

export interface Filter {
  field: string;
  operator: 'eq' | 'neq';
  values: string[];
}

/**
 * Parse filter arguments from CLI (e.g., --status=active, --status!=done).
 */
export function parseFilters(args: string[]): Filter[] {
  const filters: Filter[] = [];

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;

    const withoutPrefix = arg.slice(2);

    // Check for negation filter: --field!=value
    if (withoutPrefix.includes('!=')) {
      const [field, value] = withoutPrefix.split('!=', 2);
      if (field) {
        filters.push({
          field,
          operator: 'neq',
          values: value ? value.split(',') : [],
        });
      }
    }
    // Check for equality filter: --field=value
    else if (withoutPrefix.includes('=')) {
      const [field, value] = withoutPrefix.split('=', 2);
      if (field) {
        filters.push({
          field,
          operator: 'eq',
          values: value ? value.split(',') : [],
        });
      }
    }
  }

  return filters;
}

/**
 * Check if a single filter matches a frontmatter value.
 */
export function matchesFilter(
  frontmatterValue: unknown,
  filter: Filter
): boolean {
  const strValue = String(frontmatterValue ?? '');
  const isEmpty = frontmatterValue === undefined || frontmatterValue === null || frontmatterValue === '';

  // Handle empty filter value (checking for missing/empty field)
  if (filter.values.length === 0) {
    if (filter.operator === 'eq') {
      // --field= : match if field is empty/missing
      return isEmpty;
    } else {
      // --field!= : match if field is NOT empty (exists with value)
      return !isEmpty;
    }
  }

  // Check if value is in the filter values
  const found = filter.values.includes(strValue);

  if (filter.operator === 'eq') {
    // --field=val : match if value is in list
    return found;
  } else {
    // --field!=val : match if value is NOT in list
    return !found;
  }
}

/**
 * Check if all filters match a frontmatter object.
 */
export function matchesAllFilters(
  frontmatter: Record<string, unknown>,
  filters: Filter[]
): boolean {
  for (const filter of filters) {
    if (!matchesFilter(frontmatter[filter.field], filter)) {
      return false;
    }
  }
  return true;
}

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
 * Validate that filter values are valid for a field (if it's an enum field).
 */
export function validateFilterValues(
  schema: LoadedSchema,
  typeName: string,
  fieldName: string,
  values: string[]
): { valid: boolean; error?: string } {
  // Empty values are always valid (means "field is missing")
  if (values.length === 0) {
    return { valid: true };
  }

  const validOptions = getOptionsForField(schema, typeName, fieldName);
  if (validOptions.length === 0) {
    // Not a select field with options, any value is valid
    return { valid: true };
  }

  for (const val of values) {
    if (!validOptions.includes(val)) {
      const validList = validOptions.join(', ');
      return {
        valid: false,
        error: `Invalid value '${val}' for field '${fieldName}'. Valid values: ${validList}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate all filters for a type.
 */
export function validateFilters(
  schema: LoadedSchema,
  typeName: string,
  filters: Filter[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const filter of filters) {
    // Validate field name
    const fieldResult = validateFieldForType(schema, typeName, filter.field);
    if (!fieldResult.valid && fieldResult.error) {
      errors.push(fieldResult.error);
      continue;
    }

    // Validate filter values
    const valuesResult = validateFilterValues(schema, typeName, filter.field, filter.values);
    if (!valuesResult.valid && valuesResult.error) {
      errors.push(valuesResult.error);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Options for applyFrontmatterFilters.
 */
export interface FrontmatterFilterOptions {
  /** Simple field=value filters */
  filters: Filter[];
  /** Expression-based filters (--where) */
  whereExpressions: string[];
  /** Vault directory for building eval context */
  vaultDir: string;
  /** Whether to suppress error output (for JSON mode) */
  silent?: boolean;
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
  files: FileWithFrontmatter[]
): HierarchyData {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, Set<string>>();

  for (const file of files) {
    const noteName = basename(file.path, '.md');
    const parentValue = file.frontmatter['parent'];

    if (parentValue) {
      const parentTarget = extractWikilinkTarget(String(parentValue));
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
 * Filters files using both simple filters (--field=value) and 
 * expression filters (--where). Returns only files that match all criteria.
 * 
 * @param files - Array of objects with path and frontmatter
 * @param options - Filter options
 * @returns Filtered array of files
 */
export async function applyFrontmatterFilters<T extends FileWithFrontmatter>(
  files: T[],
  options: FrontmatterFilterOptions
): Promise<T[]> {
  const { filters, whereExpressions, vaultDir, silent = false } = options;
  const result: T[] = [];

  // Build hierarchy data if any expression uses hierarchy functions
  // This is done once before the loop for efficiency
  let hierarchyData: HierarchyData | undefined;
  if (whereExpressions.length > 0 && expressionsUseHierarchyFunctions(whereExpressions)) {
    hierarchyData = buildHierarchyDataFromFiles(files);
  }

  for (const file of files) {
    // Apply simple filters first (--field=value style)
    if (!matchesAllFilters(file.frontmatter, filters)) {
      continue;
    }

    // Apply expression filters (--where style)
    if (whereExpressions.length > 0) {
      const context = await buildEvalContext(file.path, vaultDir, file.frontmatter);
      // Add hierarchy data to context if available
      if (hierarchyData) {
        context.hierarchyData = hierarchyData;
      }
      const allMatch = whereExpressions.every(expr => {
        try {
          return matchesExpression(expr, context);
        } catch (e) {
          if (!silent) {
            printError(`Expression error in "${expr}": ${(e as Error).message}`);
          }
          return false;
        }
      });

      if (!allMatch) {
        continue;
      }
    }

    result.push(file);
  }

  return result;
}

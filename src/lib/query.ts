import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import { getAllFieldsForType } from './schema.js';
import { matchesExpression, buildEvalContext, type HierarchyData } from './expression.js';
import { printError } from './prompt.js';
import { extractWikilinkTarget } from './audit/types.js';

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
  const { whereExpressions, vaultDir, silent = false } = options;
  const result: T[] = [];

  // Build hierarchy data if any expression uses hierarchy functions
  // This is done once before the loop for efficiency
  let hierarchyData: HierarchyData | undefined;
  if (whereExpressions.length > 0 && expressionsUseHierarchyFunctions(whereExpressions)) {
    hierarchyData = buildHierarchyDataFromFiles(files);
  }

  for (const file of files) {
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

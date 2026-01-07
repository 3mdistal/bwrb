/**
 * Unified CLI targeting module.
 *
 * This module provides a consistent targeting model across all commands that
 * operate on sets of notes. It supports four selectors that compose via AND:
 * - --type: Filter by note type (e.g., 'task', 'idea')
 * - --path: Filter by file path glob (e.g., 'Projects/**')
 * - --where: Filter by frontmatter expression (e.g., 'status=active')
 * - --body: Filter by body content search
 *
 * Safety model:
 * - Read-only commands: implicit --all (no targeting = all notes)
 * - Destructive commands: require explicit targeting OR --all, plus --execute
 */

import { minimatch } from 'minimatch';
import type { LoadedSchema } from '../types/schema.js';
import type { ManagedFile } from './discovery.js';
import {
  discoverManagedFiles,
  collectAllMarkdownFiles,
  getExcludedDirectories,
  loadGitignore,
} from './discovery.js';
import { parseNote } from './frontmatter.js';
import { applyFrontmatterFilters } from './query.js';
import { searchContent } from './content-search.js';
import { getTypeNames } from './schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Targeting options that can be passed to commands.
 */
export interface TargetingOptions {
  /** Filter by note type (e.g., 'task', 'objective/milestone') */
  type?: string;
  /** Filter by file path glob pattern (e.g., 'Projects/**', '*.md') */
  path?: string;
  /** Filter by frontmatter expression (e.g., 'status=active') */
  where?: string[];
  /** Filter by body content search pattern */
  body?: string;
  /** @deprecated Use `body` instead */
  text?: string;
  /** Explicit flag to target all notes (required for destructive commands without other targeting) */
  all?: boolean;
}

/**
 * A managed file with its parsed frontmatter.
 */
export interface TargetedFile extends ManagedFile {
  frontmatter: Record<string, unknown>;
}

/**
 * Result of resolving targets.
 */
export interface TargetingResult {
  /** Successfully targeted files */
  files: TargetedFile[];
  /** Whether any targeting options were specified */
  hasTargeting: boolean;
  /** Error message if targeting failed */
  error?: string;
}

/**
 * Safety validation result.
 */
export interface SafetyValidation {
  /** Whether the targeting is safe to proceed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

// ============================================================================
// Smart Positional Detection
// ============================================================================

/**
 * Detect what kind of selector a positional argument represents.
 *
 * Detection rules:
 * - Contains '/' or '*' or '**' → path
 * - Matches a known type name → type
 * - Contains operators (=, !=, >, <, >=, <=, ~) → where expression
 * - Otherwise → ambiguous (return null)
 */
export function detectPositionalType(
  arg: string,
  schema: LoadedSchema
): 'type' | 'path' | 'where' | null {
  // Check for path indicators first (most specific)
  if (arg.includes('/') || arg.includes('*')) {
    return 'path';
  }

  // Check for where expression operators
  if (/[=!><~]/.test(arg)) {
    return 'where';
  }

  // Check if it matches a known type name
  const typeNames = getTypeNames(schema);
  if (typeNames.includes(arg)) {
    return 'type';
  }

  // Ambiguous - could be anything
  return null;
}

/**
 * Result of parsing a positional argument.
 */
export interface ParsePositionalResult {
  options: TargetingOptions;
  detectedAs?: 'type' | 'path' | 'where';
  error?: string;
}

/**
 * Parse a positional argument into targeting options.
 * Returns updated options, detected type, and any error message.
 */
export function parsePositionalArg(
  arg: string,
  schema: LoadedSchema,
  existingOptions: TargetingOptions
): ParsePositionalResult {
  const detected = detectPositionalType(arg, schema);

  if (detected === null) {
    const typeNames = getTypeNames(schema);
    return {
      options: existingOptions,
      error: `Ambiguous argument '${arg}'. Use explicit flags:\n` +
        `  --type=${arg}   (if it's a type)\n` +
        `  --path='${arg}' (if it's a path pattern)\n` +
        `  --where='${arg}' (if it's a filter expression)\n\n` +
        `Known types: ${typeNames.join(', ')}`,
    };
  }

  const options = { ...existingOptions };

  switch (detected) {
    case 'type':
      if (options.type) {
        return {
          options,
          detectedAs: detected,
          error: `Type already specified as '${options.type}'. Cannot also use '${arg}'.`,
        };
      }
      options.type = arg;
      break;

    case 'path':
      if (options.path) {
        return {
          options,
          detectedAs: detected,
          error: `Path already specified as '${options.path}'. Cannot also use '${arg}'.`,
        };
      }
      options.path = arg;
      break;

    case 'where':
      options.where = options.where || [];
      options.where.push(arg);
      break;
  }

  return { options, detectedAs: detected };
}

// ============================================================================
// Path Filtering
// ============================================================================

/**
 * Filter files by path glob pattern.
 */
export function filterByPath(
  files: ManagedFile[],
  pathPattern: string
): ManagedFile[] {
  // Normalize the pattern - if it doesn't have an extension, match .md files
  let pattern = pathPattern;
  if (!pattern.includes('.') && !pattern.endsWith('*')) {
    // Pattern like 'Projects/**' should match 'Projects/**/*.md'
    if (pattern.endsWith('/')) {
      pattern = pattern + '**/*.md';
    } else if (pattern.endsWith('**')) {
      pattern = pattern + '/*.md';
    } else {
      // Pattern like 'Projects' should match 'Projects/**/*.md'
      pattern = pattern + '/**/*.md';
    }
  }

  return files.filter(file => {
    // Match against relative path
    return minimatch(file.relativePath, pattern, {
      matchBase: true,
      nocase: true,
    });
  });
}

// ============================================================================
// Main Targeting Resolution
// ============================================================================

/**
 * Resolve targeting options to a list of files.
 *
 * This is the main entry point for the targeting system. It:
 * 1. Discovers files based on type (or all files if no type)
 * 2. Filters by path glob
 * 3. Parses frontmatter and filters by --where expressions
 * 4. Filters by content search (--text)
 *
 * All selectors compose via AND.
 */
export async function resolveTargets(
  options: TargetingOptions,
  schema: LoadedSchema,
  vaultDir: string
): Promise<TargetingResult> {
  const bodyFilter = options.body ?? options.text;
  const hasTargeting = !!(options.type || options.path || options.where?.length || bodyFilter);

  try {
    // Step 1: Discover base files
    let files: ManagedFile[];

    if (options.type) {
      // Type-specific discovery
      files = await discoverManagedFiles(schema, vaultDir, options.type);
    } else {
      // Vault-wide discovery
      const excluded = getExcludedDirectories(schema);
      const gitignore = await loadGitignore(vaultDir);
      files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
    }

    if (files.length === 0) {
      return { files: [], hasTargeting };
    }

    // Step 2: Filter by path glob
    if (options.path) {
      files = filterByPath(files, options.path);
      if (files.length === 0) {
        return { files: [], hasTargeting };
      }
    }

    // Step 3: Filter by content search (--body)
    // Do this BEFORE frontmatter parsing to reduce the set of files we need to parse
    if (bodyFilter) {
      const searchOpts: Parameters<typeof searchContent>[0] = {
        pattern: bodyFilter,
        vaultDir,
        schema,
        contextLines: 0, // We don't need context for filtering
        caseSensitive: false,
        regex: false,
        limit: 10000, // High limit for filtering
      };
      if (options.type) {
        searchOpts.typePath = options.type;
      }
      const searchResult = await searchContent(searchOpts);

      if (!searchResult.success) {
        const result: TargetingResult = {
          files: [],
          hasTargeting,
        };
        if (searchResult.error) {
          result.error = searchResult.error;
        }
        return result;
      }

      // Create a set of matching paths for fast lookup
      const matchingPaths = new Set(
        searchResult.results.map(r => r.file.relativePath)
      );

      // Filter to only files that matched the content search
      files = files.filter(f => matchingPaths.has(f.relativePath));

      if (files.length === 0) {
        return { files: [], hasTargeting };
      }
    }

    // Step 4: Parse frontmatter for remaining files
    const filesWithFrontmatter: TargetedFile[] = [];

    for (const file of files) {
      try {
        const { frontmatter } = await parseNote(file.path);
        filesWithFrontmatter.push({
          ...file,
          frontmatter,
        });
      } catch {
        // Skip files that can't be parsed
        // This could be files without frontmatter or malformed YAML
      }
    }

    // Step 5: Filter by --where expressions
    if (options.where && options.where.length > 0) {
      const filtered = await applyFrontmatterFilters(filesWithFrontmatter, {
        whereExpressions: options.where,
        vaultDir,
        silent: true,
      });

      return {
        files: filtered as TargetedFile[],
        hasTargeting,
      };
    }

    return {
      files: filesWithFrontmatter,
      hasTargeting,
    };
  } catch (err) {
    return {
      files: [],
      hasTargeting,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Safety Validation
// ============================================================================

/**
 * Validate that targeting is safe for a destructive command.
 *
 * Destructive commands require:
 * 1. Explicit targeting (at least one of --type, --path, --where, --text) OR --all flag
 * 2. --execute flag to actually perform the operation
 *
 * This function validates the first requirement. The --execute flag
 * should be checked by the command itself.
 */
export function validateDestructiveTargeting(
  options: TargetingOptions
): SafetyValidation {
  const hasTargeting = !!(
    options.type ||
    options.path ||
    options.where?.length ||
    options.body ||
    options.text
  );

  if (!hasTargeting && !options.all) {
    return {
      valid: false,
      error:
        'Destructive commands require explicit targeting.\n\n' +
        'Specify at least one of:\n' +
        '  --type <type>     Filter by note type\n' +
        '  --path <glob>     Filter by file path\n' +
        '  --where <expr>    Filter by frontmatter\n' +
        '  --body <query>    Filter by content\n' +
        '  --all             Target all notes\n\n' +
        'Then add --execute to apply changes.',
    };
  }

  return { valid: true };
}

/**
 * Validate that targeting is safe for a read-only command.
 *
 * Read-only commands have implicit --all, so no validation is needed.
 * This function is provided for consistency and future extensibility.
 */
export function validateReadOnlyTargeting(
  _options: TargetingOptions
): SafetyValidation {
  // Read-only commands always pass validation
  return { valid: true };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a summary of the current targeting for display.
 */
export function formatTargetingSummary(options: TargetingOptions): string {
  const parts: string[] = [];

  if (options.all) {
    parts.push('all notes');
  }
  if (options.type) {
    parts.push(`type=${options.type}`);
  }
  if (options.path) {
    parts.push(`path=${options.path}`);
  }
  if (options.where && options.where.length > 0) {
    parts.push(`where=(${options.where.join(' AND ')})`);
  }
  if (options.body || options.text) {
    parts.push(`body="${options.body ?? options.text}"`);
  }

  if (parts.length === 0) {
    return 'all notes (no filters)';
  }

  return parts.join(' AND ');
}

/**
 * Check if any targeting options are specified.
 */
export function hasAnyTargeting(options: TargetingOptions): boolean {
  return !!(
    options.type ||
    options.path ||
    options.where?.length ||
    options.body ||
    options.text ||
    options.all
  );
}

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { parseNote } from './frontmatter.js';
import type { Schema, DynamicSource, FilterCondition } from '../types/schema.js';

/**
 * Resolve vault directory from options, env, or cwd.
 */
export function resolveVaultDir(options: { vault?: string }): string {
  if (options.vault) {
    return options.vault;
  }
  if (process.env['OVAULT_VAULT']) {
    return process.env['OVAULT_VAULT'];
  }
  return process.cwd();
}

/**
 * List all .md files in a directory.
 */
export async function listFilesInDir(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(join(dirPath, entry.name));
    }
  }

  return files;
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a file.
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Format a value for frontmatter based on format type.
 */
export function formatValue(value: string, format?: string): string {
  if (!value) return '';

  switch (format) {
    case 'wikilink':
      return `[[${value}]]`;
    case 'quoted-wikilink':
      return `"[[${value}]]"`;
    default:
      return value;
  }
}

/**
 * Check if a filter condition matches a value.
 */
function matchesCondition(value: unknown, condition: FilterCondition): boolean {
  const strValue = String(value ?? '');

  if (condition.equals !== undefined) {
    return strValue === condition.equals;
  }
  if (condition.not_equals !== undefined) {
    return strValue !== condition.not_equals;
  }
  if (condition.in !== undefined) {
    return condition.in.includes(strValue);
  }
  if (condition.not_in !== undefined) {
    return !condition.not_in.includes(strValue);
  }

  return true;
}

/**
 * Query a dynamic source and return matching note names.
 */
export async function queryDynamicSource(
  schema: Schema,
  vaultDir: string,
  sourceName: string
): Promise<string[]> {
  const source: DynamicSource | undefined = schema.dynamic_sources?.[sourceName];
  if (!source) {
    return [];
  }

  const fullDir = join(vaultDir, source.dir);
  const files = await listFilesInDir(fullDir);
  const results: string[] = [];

  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file);

      // Apply filters
      let matches = true;
      if (source.filter) {
        for (const [field, condition] of Object.entries(source.filter)) {
          if (!matchesCondition(frontmatter[field], condition)) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        results.push(basename(file, '.md'));
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return results;
}

/**
 * Get output directory for a type, walking up the type hierarchy.
 */
export function getOutputDir(
  schema: Schema,
  typePath: string
): string | undefined {
  const segments = typePath.split('/').filter(Boolean);
  let outputDir: string | undefined;

  // Walk through segments, keeping track of most recent output_dir
  let current: { output_dir?: string; subtypes?: Record<string, unknown> } | undefined;
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === 0) {
      current = segment ? schema.types[segment] : undefined;
    } else if (current?.subtypes && segment) {
      current = current.subtypes[segment] as typeof current;
    }

    if (current?.output_dir) {
      outputDir = current.output_dir;
    }
  }

  return outputDir;
}

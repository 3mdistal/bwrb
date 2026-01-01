import { readdir, stat, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { parseNote } from './frontmatter.js';
import type { LoadedSchema, FilterCondition, DynamicSource, ResolvedType } from '../types/schema.js';
import { getOutputDir as getOutputDirFromSchema, getType } from './schema.js';

/**
 * Resolve vault directory from options, env, or cwd.
 */
export function resolveVaultDir(options: { vault?: string }): string {
  if (options.vault) {
    return options.vault;
  }
  if (process.env['PIKA_VAULT']) {
    return process.env['PIKA_VAULT'];
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
  schema: LoadedSchema,
  vaultDir: string,
  sourceName: string
): Promise<string[]> {
  const source: DynamicSource | undefined = schema.dynamicSources.get(sourceName);
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
 * Get output directory for a type.
 */
export function getOutputDir(
  schema: LoadedSchema,
  typeName: string
): string | undefined {
  return getOutputDirFromSchema(schema, typeName);
}

// ============================================================================
// Directory Mode Support (Legacy - to be removed when ownership is implemented)
// ============================================================================

/**
 * Get directory mode for a type.
 * In the new model, this is determined by ownership, not dir_mode.
 * For now, return 'pooled' by default.
 */
export function getDirMode(
  _schema: LoadedSchema,
  _typeName: string
): 'pooled' | 'instance-grouped' {
  // TODO: Implement based on ownership model
  return 'pooled';
}

/**
 * Check if a type is a subtype of an instance-grouped type.
 * @deprecated Use ownership model instead
 */
export function isInstanceGroupedSubtype(
  _schema: LoadedSchema,
  _typeName: string
): boolean {
  // In new model, this is determined by ownership
  return false;
}

/**
 * Get the parent type name for an owned type.
 */
export function getParentTypeName(
  schema: LoadedSchema,
  typeName: string
): string | undefined {
  const type = getType(schema, typeName);
  return type?.parent;
}

/**
 * List all instance folders for an instance-grouped type.
 */
export async function listInstanceFolders(
  vaultDir: string,
  outputDir: string
): Promise<string[]> {
  const fullDir = join(vaultDir, outputDir);
  if (!existsSync(fullDir)) return [];

  const entries = await readdir(fullDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/**
 * Get the path to an instance folder.
 */
export function getInstanceFolderPath(
  vaultDir: string,
  outputDir: string,
  instanceName: string
): string {
  return join(vaultDir, outputDir, instanceName);
}

/**
 * Get the path to the parent note (index file) for an instance.
 * The parent note has the same name as the folder.
 */
export function getParentNotePath(
  vaultDir: string,
  outputDir: string,
  instanceName: string
): string {
  return join(vaultDir, outputDir, instanceName, `${instanceName}.md`);
}

/**
 * Create an instance folder and its parent note.
 */
export async function createInstanceFolder(
  vaultDir: string,
  outputDir: string,
  instanceName: string
): Promise<string> {
  const folderPath = getInstanceFolderPath(vaultDir, outputDir, instanceName);
  await mkdir(folderPath, { recursive: true });
  return folderPath;
}

/**
 * Generate a filename from a pattern.
 * Patterns:
 *   {title} - Note title
 *   {n} - Auto-incrementing number
 *   {date} - Today's date (YYYY-MM-DD)
 *   {date:format} - Formatted date
 *   Static - Literal filename
 */
export async function generateFilename(
  pattern: string | undefined,
  instanceDir: string,
  title: string
): Promise<string> {
  if (!pattern) {
    return `${title}.md`;
  }

  let filename = pattern;

  // Replace {title}
  filename = filename.replace('{title}', title);

  // Replace {date} or {date:format}
  const now = new Date();
  filename = filename.replace(/{date(?::([^}]+))?}/g, (_, format) => {
    if (format) {
      return formatDate(now, format);
    }
    return now.toISOString().split('T')[0] ?? '';
  });

  // Replace {n} with auto-incrementing number
  if (filename.includes('{n}')) {
    const n = await findNextNumber(instanceDir, pattern);
    filename = filename.replace('{n}', String(n));
  }

  // Ensure .md extension
  if (!filename.endsWith('.md')) {
    filename += '.md';
  }

  return filename;
}

/**
 * Find the next number for {n} pattern in a directory.
 */
async function findNextNumber(dir: string, pattern: string): Promise<number> {
  if (!existsSync(dir)) return 1;

  const entries = await readdir(dir);
  const mdFiles = entries.filter(f => f.endsWith('.md'));

  // Extract the number part from existing files
  // Convert pattern to regex: "Draft v{n}.md" -> /Draft v(\d+)\.md/
  const regexPattern = pattern
    .replace('{title}', '.*')
    .replace('{n}', '(\\d+)')
    .replace(/{date(?::[^}]+)?}/g, '\\d{4}-\\d{2}-\\d{2}')
    .replace(/\.md$/, '')
    + '\\.md$';

  const regex = new RegExp(regexPattern);
  let maxN = 0;

  for (const file of mdFiles) {
    const match = file.match(regex);
    if (match && match[1]) {
      const n = parseInt(match[1], 10);
      if (n > maxN) maxN = n;
    }
  }

  return maxN + 1;
}

/**
 * Format a date with a simple format string.
 */
function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0');

  return format
    .replace('YYYY', date.getFullYear().toString())
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()));
}

/**
 * Get the filename pattern for a type.
 */
export function getFilenamePattern(
  schema: LoadedSchema,
  typeName: string
): string | undefined {
  const type: ResolvedType | undefined = getType(schema, typeName);
  return type?.filename;
}

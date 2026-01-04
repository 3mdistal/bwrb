import { readdir, stat, mkdir } from 'fs/promises';
import { join, basename, relative } from 'path';
import { existsSync } from 'fs';
import { parseNote } from './frontmatter.js';
import type { LoadedSchema, FilterCondition, ResolvedType, OwnerInfo } from '../types/schema.js';
import { 
  getOutputDir as getOutputDirFromSchema, 
  getType, 
  getDescendants,
  canTypeBeOwned, 
  getOwnerTypes,
  resolveTypeFromFrontmatter,
} from './schema.js';

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
 * Check if all filter conditions match a frontmatter object.
 */
function matchesAllConditions(
  frontmatter: Record<string, unknown>,
  filter: Record<string, FilterCondition>
): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    if (!matchesCondition(frontmatter[field], condition)) {
      return false;
    }
  }
  return true;
}

/**
 * Query notes by type name, including all descendant types.
 * 
 * This replaces the legacy `dynamic_sources` system. Instead of configuring
 * named sources with directories and filters, you now specify a type name
 * directly as the `source` on a field, with optional `filter` conditions.
 * 
 * **Ownership Exclusion**: Owned notes are automatically excluded from results.
 * This is by design - owned notes live in their owner's folder (e.g., 
 * `drafts/My Novel/research/`) rather than the type's `output_dir` (e.g., 
 * `research/`), so they're not found when scanning the type's directory.
 * This enforces the rule that owned notes cannot be referenced by other 
 * notes' frontmatter fields.
 * 
 * @param schema - The loaded schema
 * @param vaultDir - The vault root directory  
 * @param typeName - The type to query (e.g., "milestone", "objective")
 * @param filter - Optional filter conditions to apply to frontmatter
 * @returns Array of note names (basenames without .md) that match the type and filter
 * 
 * @example
 * // Get all milestones
 * queryByType(schema, vaultDir, 'milestone')
 * 
 * @example
 * // Get all objectives (including tasks, milestones, etc.)
 * queryByType(schema, vaultDir, 'objective')
 * 
 * @example
 * // Get active milestones (with filter)
 * queryByType(schema, vaultDir, 'milestone', { status: { not_in: ['settled'] } })
 */
export async function queryByType(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string | string[],
  filter?: Record<string, FilterCondition>
): Promise<string[]> {
  // Normalize to array of type names
  const typeNames = Array.isArray(typeName) ? typeName : [typeName];
  
  // Collect all types to query: each specified type + all their descendants
  const typesToQuery = new Set<string>();
  for (const name of typeNames) {
    const type = getType(schema, name);
    if (type) {
      typesToQuery.add(name);
      for (const descendant of getDescendants(schema, name)) {
        typesToQuery.add(descendant);
      }
    }
  }
  
  if (typesToQuery.size === 0) {
    return [];
  }

  const typesToQueryArray = Array.from(typesToQuery);
  const results: string[] = [];

  for (const queryType of typesToQueryArray) {
    const outputDir = getOutputDirFromSchema(schema, queryType);
    if (!outputDir) continue;

    const fullDir = join(vaultDir, outputDir);
    const files = await listFilesInDir(fullDir);

    for (const file of files) {
      try {
        const { frontmatter } = await parseNote(file);
        
        // Verify the note is actually the type we expect
        const actualType = resolveTypeFromFrontmatter(schema, frontmatter);
        if (!typesToQuery.has(actualType ?? '')) {
          continue;
        }

        // Apply filter conditions if provided
        if (filter && !matchesAllConditions(frontmatter, filter)) {
          continue;
        }

        results.push(basename(file, '.md'));
      } catch {
        // Skip files that can't be parsed
      }
    }
  }

  // Sort results alphabetically for consistent ordering
  results.sort((a, b) => a.localeCompare(b));

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
// Directory Mode Support
// ============================================================================

/**
 * Get directory mode for a type.
 * 
 * In the ownership model, notes are either:
 * - "pooled": Live in the type's output_dir (default)
 * - "owned": Live in their owner's folder (determined by `owned: true` on parent's field)
 * 
 * This function returns 'pooled' because the ownership model handles colocation
 * through the ownership system rather than a separate dir_mode property.
 * See docs/technical/inheritance.md for ownership semantics.
 * 
 * @deprecated Consider using canTypeBeOwned() or getOwnerTypes() for ownership checks
 */
export function getDirMode(
  _schema: LoadedSchema,
  _typeName: string
): 'pooled' | 'instance-grouped' {
  // Ownership model supersedes dir_mode - owned notes colocate with owner,
  // all other notes are pooled in their type's output_dir
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

// ============================================================================
// Ownership-Based Path Computation
// ============================================================================

/**
 * Reference to an owner note for path computation.
 */
export interface OwnerNoteRef {
  /** The owner type name (e.g., "draft") */
  ownerType: string;
  /** The owner note's name (used for folder name) */
  ownerName: string;
  /** The owner note's path (for computing owned note location) */
  ownerPath: string;
}

/**
 * Check if a type can be owned by any other type.
 */
export function typeCanBeOwned(schema: LoadedSchema, typeName: string): boolean {
  return canTypeBeOwned(schema, typeName);
}

/**
 * Get all owner types for a child type, sorted alphabetically.
 */
export function getPossibleOwnerTypes(schema: LoadedSchema, childTypeName: string): OwnerInfo[] {
  return getOwnerTypes(schema, childTypeName);
}

/**
 * Compute the output directory for an owned note.
 * Owned notes live in: {owner_folder}/{child_type}/
 * 
 * Example: If "My Novel" is a draft at "drafts/My Novel/My Novel.md",
 * and research is owned by draft, then owned research goes to:
 * "drafts/My Novel/research/"
 * 
 * @param ownerPath - Absolute path to the owner note file
 * @param childTypeName - The type name of the owned child (e.g., "research")
 * @returns The absolute path to the directory where owned notes should live
 */
export function computeOwnedOutputDir(
  ownerPath: string,
  childTypeName: string
): string {
  // Owner path is like: /vault/drafts/My Novel/My Novel.md
  // We want: /vault/drafts/My Novel/research/
  const ownerDir = join(ownerPath, '..'); // Get parent directory of owner note
  return join(ownerDir, childTypeName);
}

/**
 * Compute the relative output directory for an owned note (relative to vault).
 * 
 * @param vaultDir - The vault root directory
 * @param ownerPath - Absolute path to the owner note file
 * @param childTypeName - The type name of the owned child
 * @returns Path relative to vault root
 */
export function computeOwnedOutputDirRelative(
  vaultDir: string,
  ownerPath: string,
  childTypeName: string
): string {
  const fullPath = computeOwnedOutputDir(ownerPath, childTypeName);
  return relative(vaultDir, fullPath);
}

/**
 * Find all notes of a given owner type in the vault.
 * Used for presenting owner selection options.
 * 
 * @param schema - The loaded schema
 * @param vaultDir - The vault root directory  
 * @param ownerTypeName - The type of owner to find (e.g., "draft")
 * @returns List of owner note references
 */
export async function findOwnerNotes(
  schema: LoadedSchema,
  vaultDir: string,
  ownerTypeName: string
): Promise<OwnerNoteRef[]> {
  const ownerType = getType(schema, ownerTypeName);
  if (!ownerType) return [];
  
  const outputDir = getOutputDirFromSchema(schema, ownerTypeName);
  if (!outputDir) return [];
  
  const results: OwnerNoteRef[] = [];
  const fullDir = join(vaultDir, outputDir);
  
  if (!existsSync(fullDir)) return [];
  
  // Scan the output directory for notes of this type
  // Owner notes can be:
  // 1. Flat: drafts/My Novel.md (note name is filename)
  // 2. In folders: drafts/My Novel/My Novel.md (note name matches folder)
  
  const entries = await readdir(fullDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      // Flat structure: drafts/My Novel.md
      const filePath = join(fullDir, entry.name);
      const noteName = basename(entry.name, '.md');
      
      // Verify it's the right type
      if (await isNoteOfType(filePath, schema, ownerTypeName)) {
        results.push({
          ownerType: ownerTypeName,
          ownerName: noteName,
          ownerPath: filePath,
        });
      }
    } else if (entry.isDirectory()) {
      // Folder structure: drafts/My Novel/My Novel.md
      const folderPath = join(fullDir, entry.name);
      const expectedNotePath = join(folderPath, `${entry.name}.md`);
      
      if (existsSync(expectedNotePath)) {
        // Verify it's the right type
        if (await isNoteOfType(expectedNotePath, schema, ownerTypeName)) {
          results.push({
            ownerType: ownerTypeName,
            ownerName: entry.name,
            ownerPath: expectedNotePath,
          });
        }
      }
    }
  }
  
  // Sort alphabetically by owner name
  results.sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  
  return results;
}

/**
 * Check if a note file is of a specific type.
 */
async function isNoteOfType(
  filePath: string,
  schema: LoadedSchema,
  expectedType: string
): Promise<boolean> {
  try {
    const { frontmatter } = await parseNote(filePath);
    const actualType = resolveTypeFromFrontmatter(schema, frontmatter);
    return actualType === expectedType;
  } catch {
    return false;
  }
}

/**
 * Ensure the owned output directory exists, creating it if necessary.
 */
export async function ensureOwnedOutputDir(
  ownerPath: string,
  childTypeName: string
): Promise<string> {
  const dir = computeOwnedOutputDir(ownerPath, childTypeName);
  await mkdir(dir, { recursive: true });
  return dir;
}

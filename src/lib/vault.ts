import { readdir, stat, mkdir } from 'fs/promises';
import { join, basename, dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { parseNote } from './frontmatter.js';
import { getOwnedChildFolder } from './ownership-paths.js';
import type { LoadedSchema, FilterCondition, OwnerInfo } from '../types/schema.js';
import {
  getOutputDir as getOutputDirFromSchema,
  getType,
  getDescendants,
  canTypeBeOwned,
  getOwnerTypes,
  resolveTypeFromFrontmatter,
} from './schema.js';

const SCHEMA_RELATIVE_PATH = '.bwrb/schema.json';
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_MAX_DIRS_VISITED = 5000;

function hasVaultSchema(vaultDir: string): boolean {
  return existsSync(join(vaultDir, SCHEMA_RELATIVE_PATH));
}

function findUpVaultDir(startDir: string): string | null {
  let currentDir = resolve(startDir);
  while (true) {
    if (hasVaultSchema(currentDir)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export class VaultResolutionError extends Error {
  candidates: string[];
  cwd: string;
  truncated: boolean;

  constructor(cwd: string, candidates: string[], truncated: boolean) {
    super(`Multiple vaults found under ${cwd}. Re-run with --vault <path>.`);
    this.name = 'VaultResolutionError';
    this.candidates = candidates;
    this.cwd = cwd;
    this.truncated = truncated;
  }
}

export interface DiscoverVaultOptions {
  maxDepth?: number;
  maxCandidates?: number;
  maxDirsVisited?: number;
}

export interface DiscoverVaultResult {
  candidates: string[];
  truncated: boolean;
}

async function discoverVaultRootsDown(
  startDir: string,
  options: DiscoverVaultOptions = {}
): Promise<DiscoverVaultResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxDirsVisited = options.maxDirsVisited ?? DEFAULT_MAX_DIRS_VISITED;
  const rootDir = resolve(startDir);
  const candidates: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && candidates.length < maxCandidates && visited < maxDirsVisited) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    visited += 1;
    const { dir, depth } = next;

    if (hasVaultSchema(dir)) {
      candidates.push(dir);
      continue;
    }

    if (depth >= maxDepth) {
      continue;
    }

    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }

      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }

  const truncated = queue.length > 0 && (candidates.length >= maxCandidates || visited >= maxDirsVisited);
  return { candidates, truncated };
}

export interface ResolveVaultOptions {
  vault?: string;
  cwd?: string;
  allowFindDown?: boolean;
  maxDepth?: number;
  maxCandidates?: number;
  maxDirsVisited?: number;
}

/**
 * Resolve vault directory.
 *
 * Precedence (authoritative):
 * 1) --vault option
 * 2) find-up nearest ancestor containing .bwrb/schema.json
 * 3) BWRB_VAULT env var
 * 4) find-down under cwd (Phase 2)
 */
export async function resolveVaultDir(options: ResolveVaultOptions = {}): Promise<string> {
  if (options.vault) {
    if (!hasVaultSchema(options.vault)) {
      throw new Error(
        `Invalid --vault path: "${options.vault}" (expected ${SCHEMA_RELATIVE_PATH})`
      );
    }
    return options.vault;
  }

  const cwd = options.cwd ?? process.cwd();
  const found = findUpVaultDir(cwd);
  if (found) {
    return found;
  }

  const envVault = process.env['BWRB_VAULT'];
  if (envVault) {
    if (!hasVaultSchema(envVault)) {
      throw new Error(
        `Invalid BWRB_VAULT: "${envVault}" (expected ${SCHEMA_RELATIVE_PATH})`
      );
    }
    return envVault;
  }

  if (options.allowFindDown === false) {
    throw new Error(
      `Could not resolve vault: searched upward from "${cwd}" for ${SCHEMA_RELATIVE_PATH}. ` +
        `Try "--vault <path>" or run "bwrb init".`
    );
  }

  const discoverOptions: DiscoverVaultOptions = {};
  if (options.maxDepth !== undefined) discoverOptions.maxDepth = options.maxDepth;
  if (options.maxCandidates !== undefined) discoverOptions.maxCandidates = options.maxCandidates;
  if (options.maxDirsVisited !== undefined) discoverOptions.maxDirsVisited = options.maxDirsVisited;

  const { candidates, truncated } = await discoverVaultRootsDown(cwd, discoverOptions);

  if (candidates.length === 0) {
    throw new Error(
      `Could not resolve vault: searched upward from "${cwd}" for ${SCHEMA_RELATIVE_PATH} ` +
        `and downward for vaults. Try "--vault <path>" or run "bwrb init".`
    );
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  throw new VaultResolutionError(cwd, candidates, truncated);
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
 * Format a value for frontmatter based on link format.
 * 
 * Link formats:
 * - wikilink: "[[Note Name]]" (quoted for YAML safety, Obsidian-compatible)
 * - markdown: "[Note Name](Note Name.md)" (standard markdown)
 * 
 * @param value The note name to format
 * @param linkFormat The link format to use (defaults to 'wikilink')
 */
export function formatValue(value: string, linkFormat: 'wikilink' | 'markdown' = 'wikilink'): string {
  if (!value) return '';

  switch (linkFormat) {
    case 'wikilink':
      // Always quote wikilinks for YAML safety (unquoted [[ is interpreted as array start)
      return `"[[${value}]]"`;
    case 'markdown':
      return `"[${value}](${value}.md)"`;
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
// Ownership Support
// ============================================================================

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
  ownedFieldName: string
): Promise<string> {
  const dir = getOwnedChildFolder(ownerPath, ownedFieldName);
  await mkdir(dir, { recursive: true });
  return dir;
}

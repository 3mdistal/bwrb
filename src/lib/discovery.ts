/**
 * File discovery and management logic.
 * 
 * This module handles discovery of managed files within the vault,
 * respecting ignore rules and schema configurations.
 */

import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import { readdir, readFile, realpath } from 'fs/promises';
import { join, basename, relative } from 'path';
import { existsSync } from 'fs';
import {
  getType,
  getDescendants,
  getOutputDir as getOutputDirFromSchema,
  getOwnedFields,
  canTypeBeOwned,
  resolveTypeFromFrontmatter,
  getConcreteTypeNames,
  getTypeFamilies,
  getEntityAliases,
} from './schema.js';
import { parseNote } from './frontmatter.js';
import { getOwnedChildFolderFromOwnerDir } from './ownership-paths.js';
import { levenshteinDistance } from './levenshtein.js';
import type { LoadedSchema, OwnedFieldInfo } from '../types/schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Managed file with expected type context.
 */
export interface ManagedFile {
  path: string;
  relativePath: string;
  expectedType?: string;
  instance?: string;
  /** If this file is owned, info about the owner */
  ownership?: {
    /** Path to the owner note (relative to vault) */
    ownerPath: string;
    /** Type of the owner */
    ownerType: string;
    /** Field on owner that declares ownership */
    fieldName: string;
  };
}

/**
 * Parsed note metadata captured during a single vault scan.
 */
export interface VaultNoteSnapshotEntry {
  path: string;
  relativePath: string;
  frontmatter?: Record<string, unknown>;
  resolvedType?: string;
}

/**
 * Snapshot of vault notes built from one discovery pass.
 */
export interface VaultNoteSnapshot {
  notes: VaultNoteSnapshotEntry[];
}

/**
 * Unified note index used by audit and relation checks.
 */
export interface VaultNoteIndex {
  snapshot: VaultNoteSnapshot;
  allFiles: Set<string>;
  notePathMap: Map<string, string>;
  noteTypeMap: Map<string, string>;
  noteTargetIndex: NoteTargetIndex;
}

// ============================================================================
// Sorting Helpers
// ============================================================================

/**
 * Locale-stable comparator for deterministic file ordering across platforms.
 * Uses 'en' locale to ensure consistent ordering regardless of system locale.
 * 
 * All discovery functions return ManagedFile[] sorted by relativePath (ascending).
 * This ensures consistent behavior across macOS (APFS), Linux (ext4), and Windows (NTFS).
 */
const stablePathCompare = (a: ManagedFile, b: ManagedFile): number =>
  a.relativePath.localeCompare(b.relativePath, 'en');

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Load and parse `.gitignore` file if it exists.
 *
 * Note: this does NOT include `.bwrbignore` rules.
 * Prefer `loadIgnoreMatcher()` for vault traversal.
 */
export async function loadGitignore(vaultDir: string): Promise<Ignore | null> {
  const gitignorePath = join(vaultDir, '.gitignore');
  try {
    const content = await readFile(gitignorePath, 'utf-8');
    return ignore().add(content);
  } catch {
    return null; // No .gitignore or can't read it
  }
}

const BWRBIGNORE_FILENAME = '.bwrbignore';

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function transformBwrbignoreLine(line: string, dirRelPosix: string): string | null {
  // Preserve comment/blank handling from the `ignore` library by passing them through.
  // We only transform actual patterns when the ignore file is not at the vault root.
  if (!dirRelPosix) return line;

  if (line.trim() === '') return line;
  if (line.startsWith('#')) return line;

  // Only treat leading '!' as negation when it's not escaped.
  const isNegated = line.startsWith('!') && !line.startsWith('\\!');
  const prefix = isNegated ? '!' : '';
  const pattern = isNegated ? line.slice(1) : line;

  if (pattern.trim() === '') return line;

  const trailingSlash = pattern.endsWith('/');
  const patternNoTrail = trailingSlash ? pattern.slice(0, -1) : pattern;

  // Anchored pattern (relative to the directory containing this .bwrbignore)
  if (patternNoTrail.startsWith('/')) {
    const anchored = patternNoTrail.slice(1);
    if (!anchored) return null;
    return `${prefix}${dirRelPosix}/${anchored}${trailingSlash ? '/' : ''}`;
  }

  // If the pattern contains a path separator (excluding a trailing slash), treat it as path-relative.
  const hasInternalSlash = patternNoTrail.includes('/');
  if (hasInternalSlash) {
    return `${prefix}${dirRelPosix}/${patternNoTrail}${trailingSlash ? '/' : ''}`;
  }

  // Otherwise, match at any depth under this directory.
  return `${prefix}${dirRelPosix}/**/${patternNoTrail}${trailingSlash ? '/' : ''}`;
}

async function addBwrbignoreIfPresent(
  ignoreMatcher: Ignore,
  dirFull: string,
  dirRelPosix: string
): Promise<void> {
  const bwrbignorePath = join(dirFull, BWRBIGNORE_FILENAME);

  try {
    const content = await readFile(bwrbignorePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const transformed = lines
      .map((line: string) => transformBwrbignoreLine(line, dirRelPosix))
      .filter((line: string | null): line is string => line !== null);

    ignoreMatcher.add(transformed);
  } catch {
    // No .bwrbignore or can't read it
  }
}

async function populateHierarchicalBwrbignore(
  ignoreMatcher: Ignore,
  vaultDir: string,
  dirFull: string,
  excluded: Set<string>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirFull, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // includes .git

    const childFull = join(dirFull, entry.name);
    const childRelPosix = toPosixPath(relative(vaultDir, childFull));

    // Respect bwrb's hard exclusions before traversing.
    const excludedByConfig = Array.from(excluded).some(excl =>
      childRelPosix === excl || childRelPosix.startsWith(excl + '/')
    );
    if (excludedByConfig) continue;

    // Respect current ignore rules (gitignore + any already-loaded .bwrbignore).
    if (ignoreMatcher.ignores(childRelPosix) || ignoreMatcher.ignores(childRelPosix + '/')) continue;

    await addBwrbignoreIfPresent(ignoreMatcher, childFull, childRelPosix);
    await populateHierarchicalBwrbignore(ignoreMatcher, vaultDir, childFull, excluded);
  }
}

/**
 * Load ignore rules for traversing a vault.
 *
 * - Starts with `.gitignore` at vault root (if present)
 * - Adds hierarchical `.bwrbignore` files, allowing negation (e.g. `!dist/**`)
 */
export async function loadIgnoreMatcher(vaultDir: string, excluded: Set<string>): Promise<Ignore> {
  const ignoreMatcher = ignore();

  try {
    const content = await readFile(join(vaultDir, '.gitignore'), 'utf-8');
    ignoreMatcher.add(content);
  } catch {
    // No .gitignore or can't read it
  }

  // Root .bwrbignore (highest-level overrides for .gitignore)
  await addBwrbignoreIfPresent(ignoreMatcher, vaultDir, '');

  // Discover deeper .bwrbignore files using current ignore rules.
  await populateHierarchicalBwrbignore(ignoreMatcher, vaultDir, vaultDir, excluded);

  return ignoreMatcher;
}

/**
 * Get directories to exclude from all discovery/targeting operations.
 *
 * Exclusions combine as a union across all sources:
 * - Always: `.bwrb`
 * - Canonical schema config: `config.excluded_directories`
 * - Legacy schema alias: `audit.ignored_directories`
 * - Canonical env var: `BWRB_EXCLUDE` (comma-separated)
 * - Legacy env var alias: `BWRB_AUDIT_EXCLUDE` (comma-separated)
 *
 * Values are treated as vault-root-relative directory prefixes.
 */
export function getExcludedDirectories(schema: LoadedSchema): Set<string> {
  const excluded = new Set<string>();

  // Always exclude .bwrb
  excluded.add('.bwrb');

  const addDir = (dir: string): void => {
    const normalized = dir.trim().replace(/\/$/, '');
    if (normalized) excluded.add(normalized);
  };

  const configExclusions = schema.raw.config?.excluded_directories;
  if (Array.isArray(configExclusions)) {
    for (const dir of configExclusions) {
      addDir(dir);
    }
  }

  // Legacy schema alias
  const legacySchemaExclusions = schema.raw.audit?.ignored_directories;
  if (Array.isArray(legacySchemaExclusions)) {
    for (const dir of legacySchemaExclusions) {
      addDir(dir);
    }
  }

  // Env vars (comma-separated). Treat BWRB_AUDIT_EXCLUDE as an alias.
  const envParts = [process.env.BWRB_EXCLUDE, process.env.BWRB_AUDIT_EXCLUDE].filter(Boolean) as string[];
  if (envParts.length > 0) {
    for (const dir of envParts.join(',').split(',')) {
      addDir(dir);
    }
  }

  return excluded;
}

function shouldExcludePath(
  relativePath: string,
  excluded: Set<string>,
  ignoreMatcher: Ignore | null,
  isDirectory = false
): boolean {
  const relativePathPosix = toPosixPath(relativePath).replace(/\/$/, '');

  const excludedByConfig = Array.from(excluded).some(excl =>
    relativePathPosix === excl || relativePathPosix.startsWith(excl + '/')
  );
  if (excludedByConfig) return true;

  if (!ignoreMatcher) return false;

  if (ignoreMatcher.ignores(relativePathPosix)) return true;
  if (isDirectory && ignoreMatcher.ignores(relativePathPosix + '/')) return true;

  return false;
}

/**
 * Recursively collect all markdown files in a directory.
 */
export async function collectAllMarkdownFiles(
  dir: string,
  baseDir: string,
  excluded: Set<string>,
  ignoreMatcher: Ignore | null
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];
  
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // Directory doesn't exist or can't be read
  }
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);
    
    // Skip hidden directories (starting with .)
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;

    const isDirectory = entry.isDirectory();
    if (shouldExcludePath(relativePath, excluded, ignoreMatcher, isDirectory)) continue;
    
    if (isDirectory) {
      const subFiles = await collectAllMarkdownFiles(fullPath, baseDir, excluded, ignoreMatcher);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push({
        path: fullPath,
        relativePath,
      });
    }
  }
  
  // Sort for deterministic ordering across platforms (readdir order varies by filesystem)
  return files.sort(stablePathCompare);
}

/**
 * Collect all markdown filenames for stale reference checking.
 * Returns a set of basenames (without .md extension) for fast lookup.
 */
export async function collectAllMarkdownFilenames(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Set<string>> {
  const index = await buildVaultNoteIndex(schema, vaultDir);
  return index.allFiles;
}

/**
 * Build a map from note basenames to their full relative paths.
 * Used for resolving wikilink references to actual file paths.
 */
export async function buildNotePathMap(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Map<string, string>> {
  const index = await buildVaultNoteIndex(schema, vaultDir);
  return index.notePathMap;
}

/**
 * Build a map from note basenames to their resolved type names.
 * Used for context field validation (checking that wikilinks point to correct types).
 */
export async function buildNoteTypeMap(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Map<string, string>> {
  const index = await buildVaultNoteIndex(schema, vaultDir);
  return index.noteTypeMap;
}

export type NoteTargetIndex = {
  /**
   * Maps a lowercased target name/path/alias to every note it could resolve to.
   * Keys are lowercased so relation resolution is case-insensitive (consistent
   * with `open`/navigation); look up with `key.toLowerCase()`.
   */
  targetToPaths: Map<string, string[]>;
  pathToType: Map<string, string>;
  pathNoExtToType: Map<string, string>;
};

/**
 * Build target indexes for resolving note references.
 */
export async function buildNoteTargetIndex(
  schema: LoadedSchema,
  vaultDir: string
): Promise<NoteTargetIndex> {
  const index = await buildVaultNoteIndex(schema, vaultDir);
  return index.noteTargetIndex;
}

/**
 * Build a vault-wide note snapshot with one vault walk and parse pass.
 */
export async function buildVaultNoteSnapshot(
  schema: LoadedSchema,
  vaultDir: string
): Promise<VaultNoteSnapshot> {
  const excluded = getExcludedDirectories(schema);
  const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);
  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, ignoreMatcher);

  const notes: VaultNoteSnapshotEntry[] = [];

  for (const file of allFiles) {
    const entry: VaultNoteSnapshotEntry = {
      path: file.path,
      relativePath: file.relativePath,
    };

    try {
      const { frontmatter } = await parseNote(file.path);
      entry.frontmatter = frontmatter;
      const resolvedType = resolveTypeFromFrontmatter(schema, frontmatter);
      if (resolvedType) {
        entry.resolvedType = resolvedType;
      }
    } catch {
      // Skip parse metadata for files that can't be parsed.
    }

    notes.push(entry);
  }

  return { notes };
}

/**
 * Derive stale-reference lookup keys from snapshot data.
 */
export function deriveAllFiles(snapshot: VaultNoteSnapshot): Set<string> {
  const filenames = new Set<string>();

  for (const note of snapshot.notes) {
    filenames.add(basename(note.relativePath, '.md'));
    filenames.add(note.relativePath.replace(/\.md$/, ''));
  }

  return filenames;
}

/**
 * Derive note path map from snapshot data.
 *
 * When a schema is supplied, an entity's declared aliases are also registered as
 * resolution keys, so a reference written as `[[An Alias]]` resolves to the
 * entity's note wherever its basename does. Aliases never shadow a real
 * basename/path key (those win), and the first entity to claim an alias keeps it
 * — deterministic given the snapshot's stable ordering.
 */
export function deriveNotePathMap(
  snapshot: VaultNoteSnapshot,
  schema?: LoadedSchema
): Map<string, string> {
  const pathMap = new Map<string, string>();
  // Real note name/path keys, lowercased: a real note wins over an alias even
  // when they differ only by case, consistent with the case-insensitive lookups
  // elsewhere in resolution.
  const realKeysLower = new Set<string>();

  for (const note of snapshot.notes) {
    const noteName = basename(note.relativePath, '.md');
    const pathKey = note.relativePath.replace(/\.md$/, '');
    pathMap.set(noteName, note.relativePath);
    pathMap.set(pathKey, note.relativePath);
    realKeysLower.add(noteName.toLowerCase());
    realKeysLower.add(pathKey.toLowerCase());
  }

  if (schema) {
    for (const note of snapshot.notes) {
      if (!note.resolvedType || !note.frontmatter) continue;
      const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
      for (const alias of aliases) {
        // Never let an alias shadow a real note name/path (case-insensitively),
        // and keep the first claimant when two entities share an alias.
        if (realKeysLower.has(alias.toLowerCase()) || pathMap.has(alias)) continue;
        pathMap.set(alias, note.relativePath);
      }
    }
  }

  return pathMap;
}

/**
 * Derive note type map from snapshot data.
 */
export function deriveNoteTypeMap(snapshot: VaultNoteSnapshot): Map<string, string> {
  const typeMap = new Map<string, string>();

  for (const note of snapshot.notes) {
    if (!note.resolvedType) continue;

    const noteName = basename(note.relativePath, '.md');
    const pathKey = note.relativePath.replace(/\.md$/, '');
    typeMap.set(noteName, note.resolvedType);
    typeMap.set(pathKey, note.resolvedType);
  }

  return typeMap;
}

/**
 * Derive relation target index from snapshot data.
 *
 * When a schema is supplied, an entity's declared aliases are registered as
 * relation targets, so a relation/link written as `[[An Alias]]` resolves to the
 * aliased entity — making an entity linkable by its aliases wherever it is
 * linkable by its name. Aliases are added as additional candidates: an alias
 * shared by two entities surfaces as an ambiguous (multi-candidate) target,
 * which callers already refuse to auto-resolve, preserving the deterministic
 * "never auto-resolve ambiguity" guarantee.
 *
 * Keys are lowercased so relation resolution is case-insensitive, consistent
 * with `open`/navigation (`resolveNoteQuery`): a `[[Steve]]` reference resolves
 * to a real `steve` note, and a real note name still wins over an alias even
 * when they differ only by case. A lowercased key that genuinely maps to more
 * than one note (two real notes differing only by case, or a shared alias)
 * keeps every path so ambiguity stays detectable.
 */
export function deriveNoteTargetIndex(
  snapshot: VaultNoteSnapshot,
  schema?: LoadedSchema
): NoteTargetIndex {
  const targetToPaths = new Map<string, string[]>();
  const pathToType = new Map<string, string>();
  const pathNoExtToType = new Map<string, string>();
  // Real note name/path keys, lowercased: a real note wins over an alias even
  // when they differ only by case, consistent with case-insensitive resolution.
  const realKeysLower = new Set<string>();

  // Keys are lowercased to match the case-insensitive lookup in
  // `resolveRelationTarget`. Distinct notes that collapse to the same lowercased
  // key are all preserved so ambiguity remains detectable.
  const addTarget = (key: string, relativePath: string) => {
    const lowerKey = key.toLowerCase();
    const existing = targetToPaths.get(lowerKey);
    if (existing) {
      if (!existing.includes(relativePath)) {
        existing.push(relativePath);
      }
      return;
    }
    targetToPaths.set(lowerKey, [relativePath]);
  };

  for (const note of snapshot.notes) {
    const relativePath = note.relativePath;
    const basenameKey = basename(relativePath, '.md');
    const pathKey = relativePath.replace(/\.md$/, '');

    addTarget(basenameKey, relativePath);
    addTarget(pathKey, relativePath);
    realKeysLower.add(basenameKey.toLowerCase());
    realKeysLower.add(pathKey.toLowerCase());

    if (note.resolvedType) {
      pathToType.set(relativePath, note.resolvedType);
      pathNoExtToType.set(pathKey, note.resolvedType);
    }
  }

  if (schema) {
    for (const note of snapshot.notes) {
      if (!note.resolvedType || !note.frontmatter) continue;
      const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
      for (const alias of aliases) {
        // Never let an alias shadow a real note name/path key (case-insensitively).
        if (realKeysLower.has(alias.toLowerCase())) continue;
        addTarget(alias, note.relativePath);
      }
    }
  }

  return { targetToPaths, pathToType, pathNoExtToType };
}

/**
 * Build a unified vault note index from a single snapshot pass.
 */
export async function buildVaultNoteIndex(
  schema: LoadedSchema,
  vaultDir: string
): Promise<VaultNoteIndex> {
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  return {
    snapshot,
    allFiles: deriveAllFiles(snapshot),
    notePathMap: deriveNotePathMap(snapshot, schema),
    noteTypeMap: deriveNoteTypeMap(snapshot),
    noteTargetIndex: deriveNoteTargetIndex(snapshot, schema),
  };
}

/**
 * Discover files to audit.
 * When no type is specified, scans the entire vault.
 * When a type is specified, only scans that type's directories.
 */
export async function discoverManagedFiles(
  schema: LoadedSchema,
  vaultDir: string,
  typeName?: string
): Promise<ManagedFile[]> {
  if (typeName) {
    // Specific type - only check that type's files
    return collectFilesForType(schema, vaultDir, typeName);
  }

  return discoverFilesForQueryResolution(schema, vaultDir);
}

/**
 * Collapse a list of {@link ManagedFile}s that resolve to the SAME canonical
 * on-disk path to a single entry, keyed on `fs.realpath`.
 *
 * On a case-insensitive filesystem (e.g. macOS APFS, Windows NTFS) a single note
 * can be enumerated under two different path casings — for example a type whose
 * `output_dir` is declared `Tasks` but lives on disk as `tasks/`, where the
 * managed-type walk roots the path at `Tasks/...` while the unmanaged vault walk
 * sees the real `tasks/...`. Both casings name the SAME directory entry, so
 * `realpath('Tasks/X.md')` and `realpath('tasks/X.md')` resolve to one canonical
 * path and collapse — a consumer like `bulk` then writes/reports that note once.
 *
 * We key on the canonical PATH rather than `stat().dev:ino` precisely so that
 * genuine HARDLINKS are NOT collapsed: two hardlinked notes share an inode but
 * are DISTINCT directory entries with DISTINCT realpaths. A bulk `move` is
 * path-based — `rename` only relocates the one kept directory entry — so keying
 * on inode would silently leave the other hardlink unmoved and omit it from the
 * candidate count/results. Distinct realpaths keep both, so each is moved and
 * reported. (Genuinely distinct files have distinct realpaths too, so they are
 * unaffected.)
 *
 * The first occurrence wins, so callers can pre-order to control which on-disk
 * casing is kept for display. Entries whose `path` cannot be resolved (e.g. a
 * race deletion, or a broken symlink) fall back to keying on the literal
 * normalized path so they are never silently dropped. Output order follows
 * first-seen order of the input.
 */
export async function dedupeByCanonicalPath(
  files: ManagedFile[]
): Promise<ManagedFile[]> {
  const seen = new Set<string>();
  const result: ManagedFile[] = [];

  for (const file of files) {
    let key: string;
    try {
      // Canonical on-disk path: collapses case-variant aliases of one directory
      // entry, keeps distinct hardlinked paths apart.
      key = `canonical:${await realpath(file.path)}`;
    } catch {
      // If we can't resolve (file vanished mid-run, broken symlink), fall back
      // to the literal path so distinct unresolved entries are preserved rather
      // than collapsed.
      key = `path:${file.path}`;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }

  return result;
}

// ============================================================================
// Path Glob Filtering
// ============================================================================

/**
 * Check if a pattern's last segment looks like it has a file extension.
 * e.g., '*.md', 'file.md', 'path/to/*.md' → true
 * e.g., 'Ideas', 'daily.notes/', 'Projects/**' → false
 */
function hasFileExtension(pattern: string): boolean {
  const lastSegment = pattern.split('/').pop() || pattern;
  // Match: dot followed by word characters at end (e.g., .md, .txt)
  // This correctly handles: *.md, file.md, but not: daily.notes (no extension at end)
  return /\.\w+$/.test(lastSegment);
}

/**
 * Check if a pattern contains glob metacharacters (*, ?, [).
 * Used to distinguish directory paths from glob patterns.
 */
function hasGlobMetacharacters(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * Filter files by path glob pattern.
 *
 * Normalizes directory-like patterns to match .md files:
 * - 'Ideas/' -> 'Ideas/**\/*.md' (trailing slash = directory)
 * - 'Ideas' -> 'Ideas/**\/*.md' (no extension, no globs = directory)
 * - 'Ideas/**' -> 'Ideas/**\/*.md' (glob without extension)
 * - 'Ideas/*.md' -> 'Ideas/*.md' (already has extension)
 * - 'Ideas/*' -> 'Ideas/*' (glob pattern, used as-is)
 * - 'daily.notes/' -> 'daily.notes/**\/*.md' (trailing slash = directory, even with dots)
 *
 * Note: 'daily.notes' (no trailing slash, dot in name) is ambiguous and treated
 * as a file pattern. Use 'daily.notes/' to explicitly target a directory with
 * dots in its name.
 */
export function filterByPath(
  files: ManagedFile[],
  pathPattern: string
): ManagedFile[] {
  let pattern = pathPattern;

  // Normalize directory-like patterns to match .md files
  if (pattern.endsWith('/')) {
    // Trailing slash explicitly indicates directory
    pattern = pattern + '**/*.md';
  } else if (pattern.endsWith('**')) {
    // Pattern like 'Projects/**' should match 'Projects/**/*.md'
    pattern = pattern + '/*.md';
  } else if (!hasFileExtension(pattern) && !hasGlobMetacharacters(pattern)) {
    // No file extension and no glob characters - treat as directory
    // Pattern like 'Projects' should match 'Projects/**/*.md'
    // But 'Ideas/*' stays as-is (it has a glob character)
    pattern = pattern + '/**/*.md';
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
// Type-Aware Discovery (for navigation/search)
// ============================================================================

/**
 * Get the output directories for all concrete types.
 * Returns a Set of relative paths (e.g., "Objectives/Tasks").
 */
export function getTypeOutputDirs(schema: LoadedSchema): Set<string> {
  const dirs = new Set<string>();
  const typeNames = getConcreteTypeNames(schema);
  
  for (const typeName of typeNames) {
    const outputDir = getOutputDirFromSchema(schema, typeName);
    if (outputDir) {
      // Normalize: remove trailing slash if present
      dirs.add(outputDir.replace(/\/$/, ''));
    }
  }
  
  return dirs;
}

/**
 * Check if a file path is within any type's output directory.
 * Handles nested directories correctly (e.g., "Objectives/Tasks/foo.md" is in "Objectives/Tasks").
 */
export function isInTypeOutputDir(relativePath: string, typeOutputDirs: Set<string>): boolean {
  for (const dir of typeOutputDirs) {
    // Check if the file is directly in the directory or in a subdirectory
    if (relativePath.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Discover all files from all types in the schema.
 *
 * Exclusions apply to type directories as well.
 */
export async function discoverAllTypeFiles(
  schema: LoadedSchema,
  vaultDir: string
): Promise<ManagedFile[]> {
  const allFiles = new Map<string, ManagedFile>(); // dedupe by path
  
  // Get root types (direct children of meta) to avoid duplicate collection
  // since collectFilesForType already includes descendants
  const rootTypes = getTypeFamilies(schema);
  
  for (const typeName of rootTypes) {
    const typeFiles = await collectFilesForType(schema, vaultDir, typeName);
    for (const file of typeFiles) {
      if (!allFiles.has(file.relativePath)) {
        allFiles.set(file.relativePath, file);
      }
    }
  }
  
  // Sort for deterministic ordering across platforms
  return Array.from(allFiles.values()).sort(stablePathCompare);
}

/**
 * Discover unmanaged files (markdown files not in any type's output directory).
 * These files respect exclusion rules since they're outside the schema's purview.
 * 
 * Used by navigation/search to support migration workflows and vault-wide discovery.
 */
export async function discoverUnmanagedFiles(
  schema: LoadedSchema,
  vaultDir: string
): Promise<ManagedFile[]> {
  const excluded = getExcludedDirectories(schema);
  const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);
  const typeOutputDirs = getTypeOutputDirs(schema);
  
  // Vault-wide scan with exclusions
  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, ignoreMatcher);
  
  // Filter to only files NOT in type output directories
  return allFiles.filter(f => !isInTypeOutputDir(f.relativePath, typeOutputDirs));
}

/**
 * Discover all files for navigation/search.
 *
 * This respects the global exclusion rules (config/env/.gitignore/hidden dirs).
 */
export async function discoverFilesForNavigation(
  schema: LoadedSchema,
  vaultDir: string
): Promise<ManagedFile[]> {
  return discoverFilesForQueryResolution(schema, vaultDir);
}

/**
 * Discover files for query resolution (open/search/edit targeting).
 *
 * This merges:
 * - All schema-managed type files (including dot-directory output dirs)
 * - Unmanaged markdown files outside type output dirs (vault-wide scan)
 *
 * Hidden directories are still skipped in the unmanaged scan.
 */
export async function discoverFilesForQueryResolution(
  schema: LoadedSchema,
  vaultDir: string
): Promise<ManagedFile[]> {
  const managed = await discoverAllTypeFiles(schema, vaultDir);
  const unmanaged = await discoverUnmanagedFiles(schema, vaultDir);

  const allFiles = new Map<string, ManagedFile>();
  for (const file of [...managed, ...unmanaged]) {
    if (!allFiles.has(file.relativePath)) {
      allFiles.set(file.relativePath, file);
    }
  }

  return Array.from(allFiles.values()).sort(stablePathCompare);
}

/**
 * Collect files for a type (and optionally its descendants).
 * Now includes owned notes that live with their owners.
 */
export async function collectFilesForType(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string
): Promise<ManagedFile[]> {
  const type = getType(schema, typeName);
  if (!type) return [];

  const files: ManagedFile[] = [];
  
  // Collect files for this type (including owned)
  const typeFiles = await collectFilesForTypeWithOwnership(schema, vaultDir, typeName);
  files.push(...typeFiles);
  
  // Also collect files for all descendants (including owned)
  const descendants = getDescendants(schema, typeName);
  for (const descendantName of descendants) {
    const descendantFiles = await collectFilesForTypeWithOwnership(schema, vaultDir, descendantName);
    files.push(...descendantFiles);
  }

  // Sort for deterministic ordering across platforms
  return files.sort(stablePathCompare);
}

/**
 * Boundaries that stop a recursive pooled scan from crossing into a subtree
 * that belongs to a *different* type's discovery path.
 *
 * - `claimedDirs`: relative paths that are another concrete type's `output_dir`.
 *   Those notes are assigned to that type by its own pooled scan, so we must not
 *   claim them here (avoids misassigning a nested type's notes to the parent).
 * - `ownedFieldFolders`: owned-field folder basenames (e.g. `research`). Owned
 *   notes live under `<owner>/<field>/` and are collected (with ownership
 *   metadata and the correct child type) by `collectOwnedFiles`. We must not
 *   descend into those folders here or we'd double-count them under the wrong
 *   type.
 */
export interface PooledScanBoundaries {
  claimedDirs: Set<string>;
  ownedFieldFolders: Set<string>;
}

/**
 * Compute the subtree boundaries for a recursive pooled scan of `typeName`.
 *
 * Other types' output directories that are nested *under* this type's output
 * directory are excluded so each note is claimed by the most specific type. The
 * type's own output_dir is never treated as a boundary against itself.
 */
function getPooledScanBoundaries(
  schema: LoadedSchema,
  typeName: string
): PooledScanBoundaries {
  const selfDir = (getOutputDirFromSchema(schema, typeName) ?? '').replace(/\/$/, '');

  const claimedDirs = new Set<string>();
  for (const other of getConcreteTypeNames(schema)) {
    if (other === typeName) continue;
    const dir = getOutputDirFromSchema(schema, other);
    if (!dir) continue;
    const normalized = dir.replace(/\/$/, '');
    if (normalized && normalized !== selfDir) {
      claimedDirs.add(normalized);
    }
  }

  const ownedFieldFolders = new Set<string>();
  for (const [, ownedFields] of schema.ownership.owns) {
    for (const field of ownedFields as OwnedFieldInfo[]) {
      if (field.fieldName) ownedFieldFolders.add(field.fieldName);
    }
  }

  return { claimedDirs, ownedFieldFolders };
}

/**
 * Collect files from a type's output directory.
 *
 * Recurses into nested subdirectories so that notes filed in subfolders under a
 * type's `output_dir` (e.g. `People/Sub/X.md` for a `people` type rooted at
 * `People`) are discovered and associated with that type — consistent with how
 * `audit`'s wrong-directory check already treats a subdirectory of `output_dir`
 * as a correct location.
 *
 * Recursion stops at `boundaries` so notes belonging to a more specific nested
 * type, or owned notes living in owner folders, are not misassigned here.
 */
export async function collectPooledFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string,
  excluded: Set<string>,
  ignoreMatcher: Ignore | null,
  boundaries?: PooledScanBoundaries
): Promise<ManagedFile[]> {
  const normalizedOutputDir = outputDir.replace(/\/$/, '');
  const rootDir = join(vaultDir, normalizedOutputDir);
  if (!existsSync(rootDir)) return [];

  if (shouldExcludePath(normalizedOutputDir, excluded, ignoreMatcher, true)) return [];

  const claimedDirs = boundaries?.claimedDirs ?? new Set<string>();
  const ownedFieldFolders = boundaries?.ownedFieldFolders ?? new Set<string>();
  const files: ManagedFile[] = [];

  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryRel = join(relDir, entry.name);

      if (entry.isDirectory()) {
        // Never descend into hidden/system directories.
        if (entry.name.startsWith('.')) continue;
        // Stop at another type's output directory (it owns its own notes).
        if (claimedDirs.has(entryRel)) continue;
        // Stop at owned-field folders (owned notes are collected elsewhere with
        // their correct child type and ownership metadata).
        if (ownedFieldFolders.has(entry.name)) continue;
        if (shouldExcludePath(entryRel, excluded, ignoreMatcher, true)) continue;
        await walk(join(dir, entry.name), entryRel);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (shouldExcludePath(entryRel, excluded, ignoreMatcher)) continue;

      files.push({
        path: join(dir, entry.name),
        relativePath: entryRel,
        expectedType,
      });
    }
  };

  await walk(rootDir, normalizedOutputDir);

  // Sort for deterministic ordering across platforms
  return files.sort(stablePathCompare);
}

// ============================================================================
// Ownership-Aware Discovery
// ============================================================================

/**
 * Collect owned files for an owner type.
 * Owned notes live in: {owner_folder}/{child_type}/
 */
async function collectOwnedFiles(
  schema: LoadedSchema,
  vaultDir: string,
  ownerTypeName: string,
  excluded: Set<string>,
  ignoreMatcher: Ignore | null
): Promise<ManagedFile[]> {
  const ownedFields = getOwnedFields(schema, ownerTypeName);
  if (ownedFields.length === 0) return [];

  const ownerOutputDir = getOutputDirFromSchema(schema, ownerTypeName);
  if (!ownerOutputDir) return [];

  const normalizedOwnerOutputDir = ownerOutputDir.replace(/\/$/, '');
  const files: ManagedFile[] = [];
  const fullOwnerDir = join(vaultDir, normalizedOwnerOutputDir);

  if (!existsSync(fullOwnerDir)) return [];

  if (shouldExcludePath(normalizedOwnerOutputDir, excluded, ignoreMatcher, true)) return [];

  // Scan owner directory for owner folders (e.g., drafts/My Novel/)
  const entries = await readdir(fullOwnerDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith('.')) continue;

    const ownerFolderRel = join(normalizedOwnerOutputDir, entry.name);
    if (shouldExcludePath(ownerFolderRel, excluded, ignoreMatcher, true)) continue;

    // Check if this folder has an owner note (e.g., drafts/My Novel/My Novel.md)
    const ownerNotePath = join(fullOwnerDir, entry.name, `${entry.name}.md`);
    const ownerNoteRel = join(normalizedOwnerOutputDir, entry.name, `${entry.name}.md`);

    if (shouldExcludePath(ownerNoteRel, excluded, ignoreMatcher)) continue;
    if (!existsSync(ownerNotePath)) continue;

    // For each owned field, look for the owned field subfolder
    for (const ownedField of ownedFields) {
      const ownedFieldFolderRel = getOwnedChildFolderFromOwnerDir(
        join(normalizedOwnerOutputDir, entry.name),
        ownedField.fieldName
      );
      if (shouldExcludePath(ownedFieldFolderRel, excluded, ignoreMatcher, true)) continue;

      const ownedFieldFolder = getOwnedChildFolderFromOwnerDir(
        join(fullOwnerDir, entry.name),
        ownedField.fieldName
      );
      if (!existsSync(ownedFieldFolder)) continue;

      const childEntries = await readdir(ownedFieldFolder, { withFileTypes: true });

      for (const childEntry of childEntries) {
        if (!childEntry.isFile() || !childEntry.name.endsWith('.md')) continue;

        const relativePath = getOwnedChildFolderFromOwnerDir(
          join(normalizedOwnerOutputDir, entry.name),
          ownedField.fieldName
        );
        const ownedRelativePath = join(relativePath, childEntry.name);
        if (shouldExcludePath(ownedRelativePath, excluded, ignoreMatcher)) continue;

        files.push({
          path: join(ownedFieldFolder, childEntry.name),
          relativePath: ownedRelativePath,
          expectedType: ownedField.childType,
          ownership: {
            ownerPath: ownerNoteRel,
            ownerType: ownerTypeName,
            fieldName: ownedField.fieldName,
          },
        });
      }
    }
  }

  // Sort for deterministic ordering across platforms
  return files.sort(stablePathCompare);
}

/**
 * Collect all files for a type, including:
 * - Notes in the type's output_dir
 * - Owned notes that live with their owners
 */
async function collectFilesForTypeWithOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string
): Promise<ManagedFile[]> {
  const type = getType(schema, typeName);
  if (!type) return [];

  const files: ManagedFile[] = [];

  const excluded = getExcludedDirectories(schema);
  const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);

  // Collect files in the type's output_dir (non-owned notes), recursing into
  // nested subdirectories while skipping subtrees owned by other types or
  // ownership folders.
  const outputDir = getOutputDirFromSchema(schema, typeName);
  if (outputDir) {
    const boundaries = getPooledScanBoundaries(schema, typeName);
    const typeFiles = await collectPooledFiles(
      vaultDir,
      outputDir,
      typeName,
      excluded,
      ignoreMatcher,
      boundaries
    );
    files.push(...typeFiles);
  }

  // If this type can be owned, also collect owned instances
  if (canTypeBeOwned(schema, typeName)) {
    // Find all owner types and collect owned files from each
    for (const [ownerTypeName, ownedFields] of schema.ownership.owns) {
      const ownsThisType = ownedFields.some((f: OwnedFieldInfo) => f.childType === typeName);
      if (ownsThisType) {
        const ownedFiles = await collectOwnedFiles(schema, vaultDir, ownerTypeName, excluded, ignoreMatcher);
        // Filter to only files of this type
        const relevantFiles = ownedFiles.filter(f => f.expectedType === typeName);
        files.push(...relevantFiles);
      }
    }
  }

  // Dedupe by path, preferring entries that carry ownership metadata so an owned
  // note is never represented by a plain pooled entry with the wrong type.
  const byPath = new Map<string, ManagedFile>();
  for (const file of files) {
    const existing = byPath.get(file.relativePath);
    if (!existing || (!existing.ownership && file.ownership)) {
      byPath.set(file.relativePath, file);
    }
  }

  // Sort for deterministic ordering across platforms
  return Array.from(byPath.values()).sort(stablePathCompare);
}

// ============================================================================
// Similarity / Fuzzy Matching
// ============================================================================

/**
 * Find files with similar names to a target.
 * Uses simple string matching for now.
 */
export function findSimilarFiles(target: string, allFiles: Set<string>, maxResults = 5): string[] {
  // Similarity scoring thresholds - named for maintainability
  const MIN_SUBSTANTIAL_LEN = 4;  // Minimum length for substring/prefix matching
  const MIN_WORD_LEN = 2;         // Minimum word length to consider in overlap
  const LEV_RATIO = 0.2;          // Max Levenshtein distance as ratio of shorter string
  const MIN_SCORE = 10;           // Minimum score to be considered similar

  const targetLower = target.trim().toLowerCase();
  
  // Early return for empty/whitespace-only targets
  if (!targetLower) return [];
  
  const results: { file: string; score: number }[] = [];
  
  for (const file of allFiles) {
    const fileLower = file.toLowerCase();
    const fileBasename = basename(file).toLowerCase();
    
    // Exact case-insensitive match (shouldn't happen if we're here, but just in case)
    if (fileLower === targetLower) continue;
    
    // Calculate similarity score
    let score = 0;
    
    // Prefix match - require substantial length to avoid short strings matching everything
    const bothSubstantialForPrefix = targetLower.length >= MIN_SUBSTANTIAL_LEN && fileBasename.length >= MIN_SUBSTANTIAL_LEN;
    if (bothSubstantialForPrefix && (fileBasename.startsWith(targetLower) || targetLower.startsWith(fileBasename))) {
      score += 50;
    }
    
    // Contains match - require both strings to be substantial to avoid
    // short strings like "ai" matching as substrings of longer words
    if (bothSubstantialForPrefix && (fileBasename.includes(targetLower) || targetLower.includes(fileBasename))) {
      score += 30;
    }
    
    // Word overlap - filter out empty strings and very short words to avoid false matches
    // (empty strings occur from leading/trailing/consecutive delimiters like "_daily-note")
    const targetWords = targetLower.split(/[\s\-_]+/).filter(w => w.length >= MIN_WORD_LEN);
    const fileWords = fileBasename.split(/[\s\-_]+/).filter(w => w.length >= MIN_WORD_LEN);
    // Require exact word match, or substantial substring match where BOTH words are >= 4 chars
    // This prevents "ai" in "Jailbirds" from matching the file "AI"
    const overlap = targetWords.filter(w => 
      fileWords.some(fw => 
        fw === w || (w.length >= MIN_SUBSTANTIAL_LEN && fw.length >= MIN_SUBSTANTIAL_LEN && (fw.includes(w) || w.includes(fw)))
      )
    );
    score += overlap.length * 10;
    
    // Levenshtein distance for short strings - scale threshold by string length
    // to avoid false positives like "README" matching "Resume" (dist 3)
    if (targetLower.length < 20 && fileBasename.length < 20) {
      const dist = levenshteinDistance(targetLower, fileBasename);
      const minLen = Math.min(targetLower.length, fileBasename.length);
      // Require edit distance to be at most 20% of the shorter string (min 1)
      const maxAllowedDist = Math.max(1, Math.floor(minLen * LEV_RATIO));
      if (dist <= maxAllowedDist) {
        score += (maxAllowedDist + 1 - dist) * 15;
      }
    }
    
    // Require a meaningful similarity score to avoid noise
    if (score >= MIN_SCORE) {
      results.push({ file, score });
    }
  }
  
  // Sort by score descending, then alphabetically for deterministic output
  results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return results.slice(0, maxResults).map(r => r.file);
}


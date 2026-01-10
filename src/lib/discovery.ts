/**
 * File discovery and management logic.
 * 
 * This module handles discovery of managed files within the vault,
 * respecting ignore rules and schema configurations.
 */

import ignore, { type Ignore } from 'ignore';
import { readdir, readFile } from 'fs/promises';
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
} from './schema.js';
import { parseNote } from './frontmatter.js';
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
 * Load and parse .gitignore file if it exists.
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
  gitignore: Ignore | null
): boolean {
  const excludedByConfig = Array.from(excluded).some(excl =>
    relativePath === excl || relativePath.startsWith(excl + '/')
  );
  if (excludedByConfig) return true;

  if (gitignore && gitignore.ignores(relativePath)) return true;

  return false;
}

/**
 * Recursively collect all markdown files in a directory.
 */
export async function collectAllMarkdownFiles(
  dir: string,
  baseDir: string,
  excluded: Set<string>,
  gitignore: Ignore | null
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

    if (shouldExcludePath(relativePath, excluded, gitignore)) continue;
    
    if (entry.isDirectory()) {
      const subFiles = await collectAllMarkdownFiles(fullPath, baseDir, excluded, gitignore);
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
  const filenames = new Set<string>();
  const excluded = getExcludedDirectories(schema);
  const gitignore = await loadGitignore(vaultDir);

  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
  for (const file of allFiles) {
    // Add basename without extension
    filenames.add(basename(file.relativePath, '.md'));
    // Also add relative path without extension for path-based links
    filenames.add(file.relativePath.replace(/\.md$/, ''));
  }
  
  return filenames;
}

/**
 * Build a map from note basenames to their full relative paths.
 * Used for resolving wikilink references to actual file paths.
 */
export async function buildNotePathMap(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Map<string, string>> {
  const pathMap = new Map<string, string>();
  const excluded = getExcludedDirectories(schema);
  const gitignore = await loadGitignore(vaultDir);

  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
  for (const file of allFiles) {
    // Map basename (without .md) to relative path (with .md)
    const noteName = basename(file.relativePath, '.md');
    pathMap.set(noteName, file.relativePath);
  }
  
  return pathMap;
}

/**
 * Build a map from note basenames to their resolved type names.
 * Used for context field validation (checking that wikilinks point to correct types).
 */
export async function buildNoteTypeMap(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Map<string, string>> {
  const typeMap = new Map<string, string>();
  const excluded = getExcludedDirectories(schema);
  const gitignore = await loadGitignore(vaultDir);
  
  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
  
  for (const file of allFiles) {
    const noteName = basename(file.relativePath, '.md');
    try {
      const { frontmatter } = await parseNote(file.path);
      const typeName = resolveTypeFromFrontmatter(schema, frontmatter);
      if (typeName) {
        typeMap.set(noteName, typeName);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }
  
  return typeMap;
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
  
  // No type specified - scan entire vault
  const excluded = getExcludedDirectories(schema);
  const gitignore = await loadGitignore(vaultDir);
  return collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
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
  const gitignore = await loadGitignore(vaultDir);
  const typeOutputDirs = getTypeOutputDirs(schema);
  
  // Vault-wide scan with exclusions
  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
  
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
  return discoverManagedFiles(schema, vaultDir);
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
 * Collect files from a pooled (flat) directory.
 */
export async function collectPooledFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string,
  excluded: Set<string>,
  gitignore: Ignore | null
): Promise<ManagedFile[]> {
  const normalizedOutputDir = outputDir.replace(/\/$/, '');
  const fullDir = join(vaultDir, normalizedOutputDir);
  if (!existsSync(fullDir)) return [];

  if (shouldExcludePath(normalizedOutputDir, excluded, gitignore)) return [];

  const files: ManagedFile[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const relativePath = join(normalizedOutputDir, entry.name);
    if (shouldExcludePath(relativePath, excluded, gitignore)) continue;

    files.push({
      path: join(fullDir, entry.name),
      relativePath,
      expectedType,
    });
  }

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
  gitignore: Ignore | null
): Promise<ManagedFile[]> {
  const ownedFields = getOwnedFields(schema, ownerTypeName);
  if (ownedFields.length === 0) return [];

  const ownerOutputDir = getOutputDirFromSchema(schema, ownerTypeName);
  if (!ownerOutputDir) return [];

  const normalizedOwnerOutputDir = ownerOutputDir.replace(/\/$/, '');
  const files: ManagedFile[] = [];
  const fullOwnerDir = join(vaultDir, normalizedOwnerOutputDir);

  if (!existsSync(fullOwnerDir)) return [];

  if (shouldExcludePath(normalizedOwnerOutputDir, excluded, gitignore)) return [];

  // Scan owner directory for owner folders (e.g., drafts/My Novel/)
  const entries = await readdir(fullOwnerDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith('.')) continue;

    const ownerFolderRel = join(normalizedOwnerOutputDir, entry.name);
    if (shouldExcludePath(ownerFolderRel, excluded, gitignore)) continue;

    // Check if this folder has an owner note (e.g., drafts/My Novel/My Novel.md)
    const ownerNotePath = join(fullOwnerDir, entry.name, `${entry.name}.md`);
    const ownerNoteRel = join(normalizedOwnerOutputDir, entry.name, `${entry.name}.md`);

    if (shouldExcludePath(ownerNoteRel, excluded, gitignore)) continue;
    if (!existsSync(ownerNotePath)) continue;

    // For each owned field, look for the child type subfolder
    for (const ownedField of ownedFields) {
      const childTypeFolderRel = join(normalizedOwnerOutputDir, entry.name, ownedField.childType);
      if (shouldExcludePath(childTypeFolderRel, excluded, gitignore)) continue;

      const childTypeFolder = join(fullOwnerDir, entry.name, ownedField.childType);
      if (!existsSync(childTypeFolder)) continue;

      const childEntries = await readdir(childTypeFolder, { withFileTypes: true });

      for (const childEntry of childEntries) {
        if (!childEntry.isFile() || !childEntry.name.endsWith('.md')) continue;

        const relativePath = join(normalizedOwnerOutputDir, entry.name, ownedField.childType, childEntry.name);
        if (shouldExcludePath(relativePath, excluded, gitignore)) continue;

        files.push({
          path: join(childTypeFolder, childEntry.name),
          relativePath,
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
  const gitignore = await loadGitignore(vaultDir);

  // Collect files in the type's output_dir (non-owned notes)
  const outputDir = getOutputDirFromSchema(schema, typeName);
  if (outputDir) {
    const typeFiles = await collectPooledFiles(vaultDir, outputDir, typeName, excluded, gitignore);
    files.push(...typeFiles);
  }
  
  // If this type can be owned, also collect owned instances
  if (canTypeBeOwned(schema, typeName)) {
    // Find all owner types and collect owned files from each
    for (const [ownerTypeName, ownedFields] of schema.ownership.owns) {
      const ownsThisType = ownedFields.some((f: OwnedFieldInfo) => f.childType === typeName);
      if (ownsThisType) {
        const ownedFiles = await collectOwnedFiles(schema, vaultDir, ownerTypeName, excluded, gitignore);
        // Filter to only files of this type
        const relevantFiles = ownedFiles.filter(f => f.expectedType === typeName);
        files.push(...relevantFiles);
      }
    }
  }
  
  // Sort for deterministic ordering across platforms
  return files.sort(stablePathCompare);
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

/**
 * Calculate Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  
  const matrix: number[][] = Array.from({ length: aLen + 1 }, () => 
    Array.from({ length: bLen + 1 }, () => 0)
  );

  for (let i = 0; i <= aLen; i++) {
    matrix[i]![0] = i;
  }
  
  for (let j = 0; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }

  return matrix[aLen]![bLen]!;
}

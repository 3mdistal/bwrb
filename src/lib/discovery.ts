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
} from './schema.js';
import { getDirMode } from './vault.js';
import type { LoadedSchema } from '../types/schema.js';

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
}

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
 * Get directories to exclude from vault-wide audit.
 * Combines defaults, schema config, and env var.
 */
export function getExcludedDirectories(schema: LoadedSchema): Set<string> {
  const excluded = new Set<string>();
  
  // Always exclude .pika
  excluded.add('.pika');
  
  // Add schema-configured exclusions
  const schemaExclusions = schema.raw.audit?.ignored_directories;
  if (schemaExclusions) {
    for (const dir of schemaExclusions) {
      excluded.add(dir.replace(/\/$/, '')); // Normalize trailing slash
    }
  }
  
  // Add env var exclusions (comma-separated)
  const envExclusions = process.env.PIKA_AUDIT_EXCLUDE;
  if (envExclusions) {
    for (const dir of envExclusions.split(',')) {
      const trimmed = dir.trim().replace(/\/$/, '');
      if (trimmed) excluded.add(trimmed);
    }
  }
  
  return excluded;
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
    
    // Check if this path should be excluded by explicit exclusions
    const shouldExclude = Array.from(excluded).some(excl => 
      relativePath === excl || relativePath.startsWith(excl + '/')
    );
    
    if (shouldExclude) continue;
    
    // Skip hidden directories (starting with .)
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;
    
    // Check gitignore
    if (gitignore && gitignore.ignores(relativePath)) continue;
    
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
  
  return files;
}

/**
 * Collect all markdown filenames for stale reference checking.
 * Returns a set of basenames (without .md extension) for fast lookup.
 */
export async function collectAllMarkdownFilenames(vaultDir: string): Promise<Set<string>> {
  const filenames = new Set<string>();
  const excluded = new Set(['.pika']);
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

/**
 * Collect files for a type (and optionally its descendants).
 */
export async function collectFilesForType(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string
): Promise<ManagedFile[]> {
  const type = getType(schema, typeName);
  if (!type) return [];

  const files: ManagedFile[] = [];
  
  // Collect files for this type
  const outputDir = getOutputDirFromSchema(schema, typeName);
  if (outputDir) {
    const dirMode = getDirMode(schema, typeName);
    if (dirMode === 'instance-grouped') {
      const typeFiles = await collectInstanceGroupedFiles(vaultDir, outputDir, typeName);
      files.push(...typeFiles);
    } else {
      const typeFiles = await collectPooledFiles(vaultDir, outputDir, typeName);
      files.push(...typeFiles);
    }
  }
  
  // Also collect files for all descendants
  const descendants = getDescendants(schema, typeName);
  for (const descendantName of descendants) {
    const descendantDir = getOutputDirFromSchema(schema, descendantName);
    if (descendantDir) {
      const dirMode = getDirMode(schema, descendantName);
      if (dirMode === 'instance-grouped') {
        const descendantFiles = await collectInstanceGroupedFiles(vaultDir, descendantDir, descendantName);
        files.push(...descendantFiles);
      } else {
        const descendantFiles = await collectPooledFiles(vaultDir, descendantDir, descendantName);
        files.push(...descendantFiles);
      }
    }
  }

  return files;
}

/**
 * Collect files from a pooled (flat) directory.
 */
export async function collectPooledFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string
): Promise<ManagedFile[]> {
  const fullDir = join(vaultDir, outputDir);
  if (!existsSync(fullDir)) return [];

  const files: ManagedFile[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const fullPath = join(fullDir, entry.name);
      files.push({
        path: fullPath,
        relativePath: join(outputDir, entry.name),
        expectedType,
      });
    }
  }

  return files;
}

/**
 * Collect files from instance-grouped directories.
 */
export async function collectInstanceGroupedFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string
): Promise<ManagedFile[]> {
  const fullDir = join(vaultDir, outputDir);
  if (!existsSync(fullDir)) return [];

  const files: ManagedFile[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const instanceDir = join(fullDir, entry.name);
      const instanceFiles = await readdir(instanceDir, { withFileTypes: true });

      for (const file of instanceFiles) {
        if (file.isFile() && file.name.endsWith('.md')) {
          const fullPath = join(instanceDir, file.name);
          files.push({
            path: fullPath,
            relativePath: join(outputDir, entry.name, file.name),
            expectedType,
            instance: entry.name,
          });
        }
      }
    }
  }

  return files;
}

// ============================================================================
// Similarity / Fuzzy Matching
// ============================================================================

/**
 * Find files with similar names to a target.
 * Uses simple string matching for now.
 */
export function findSimilarFiles(target: string, allFiles: Set<string>, maxResults = 5): string[] {
  const targetLower = target.toLowerCase();
  const results: { file: string; score: number }[] = [];
  
  for (const file of allFiles) {
    const fileLower = file.toLowerCase();
    const fileBasename = basename(file).toLowerCase();
    
    // Exact case-insensitive match (shouldn't happen if we're here, but just in case)
    if (fileLower === targetLower) continue;
    
    // Calculate similarity score
    let score = 0;
    
    // Prefix match
    if (fileBasename.startsWith(targetLower) || targetLower.startsWith(fileBasename)) {
      score += 50;
    }
    
    // Contains match
    if (fileBasename.includes(targetLower) || targetLower.includes(fileBasename)) {
      score += 30;
    }
    
    // Word overlap
    const targetWords = targetLower.split(/[\s\-_]+/);
    const fileWords = fileBasename.split(/[\s\-_]+/);
    const overlap = targetWords.filter(w => fileWords.some(fw => fw.includes(w) || w.includes(fw)));
    score += overlap.length * 10;
    
    // Levenshtein distance for short strings
    if (targetLower.length < 20 && fileBasename.length < 20) {
      const dist = levenshteinDistance(targetLower, fileBasename);
      if (dist <= 3) {
        score += (4 - dist) * 15;
      }
    }
    
    if (score > 0) {
      results.push({ file, score });
    }
  }
  
  // Sort by score descending and return top results
  results.sort((a, b) => b.score - a.score);
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

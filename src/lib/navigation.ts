/**
 * Navigation and file resolution logic.
 * 
 * This module handles building an index of vault files and resolving
 * user queries to specific files. It scans all vault markdown except
 * excluded directories (respects schema.audit.ignored_directories,
 * .gitignore, and PIKA_AUDIT_EXCLUDE env var).
 */

import { basename } from 'path';
import type { Schema } from '../types/schema.js';
import {
  discoverManagedFiles,
  findSimilarFiles,
  type ManagedFile
} from './discovery.js';

// ============================================================================
// Types
// ============================================================================

export interface NoteIndex {
  /** Map of relative path (with extension) to file */
  byPath: Map<string, ManagedFile>;
  /** Map of basename (no extension) to list of files */
  byBasename: Map<string, ManagedFile[]>;
  /** All discovered files */
  allFiles: ManagedFile[];
}

export interface ResolutionResult {
  /** The exact match if one was found and it's unambiguous */
  exact: ManagedFile | null;
  /** List of candidate files if ambiguous or fuzzy matched */
  candidates: ManagedFile[];
  /** Whether the query resulted in multiple valid candidates */
  isAmbiguous: boolean;
}

// Re-export ManagedFile for convenience
export type { ManagedFile };

// ============================================================================
// Indexing
// ============================================================================

/**
 * Build an index of all vault files for fast lookup.
 * 
 * Scans all markdown files in the vault except:
 * - .pika directory
 * - Hidden directories (starting with .)
 * - Directories in schema.audit.ignored_directories
 * - Directories in PIKA_AUDIT_EXCLUDE env var
 * - Files matching .gitignore patterns
 */
export async function buildNoteIndex(schema: Schema, vaultDir: string): Promise<NoteIndex> {
  // Pass no typePath to get vault-wide scan
  const files = await discoverManagedFiles(schema, vaultDir);
  
  const byPath = new Map<string, ManagedFile>();
  const byBasename = new Map<string, ManagedFile[]>();
  
  for (const file of files) {
    byPath.set(file.relativePath, file);
    
    const name = basename(file.relativePath, '.md');
    const existing = byBasename.get(name) || [];
    existing.push(file);
    byBasename.set(name, existing);
  }
  
  return { byPath, byBasename, allFiles: files };
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Resolve a query string to a file or list of candidates.
 * 
 * Query resolution order:
 * 1. Exact path match (with or without extension)
 * 2. Exact basename match (case-sensitive)
 * 3. Case-insensitive basename match
 * 4. Fuzzy/Partial match
 */
export function resolveNoteQuery(index: NoteIndex, query: string): ResolutionResult {
  const cleanQuery = query.replace(/\.md$/, '');
  const cleanQueryWithExt = cleanQuery + '.md';
  
  // 1. Exact path match
  if (index.byPath.has(query)) {
    return { exact: index.byPath.get(query)!, candidates: [], isAmbiguous: false };
  }
  if (index.byPath.has(cleanQueryWithExt)) {
    return { exact: index.byPath.get(cleanQueryWithExt)!, candidates: [], isAmbiguous: false };
  }
  
  // 2. Exact basename match (case-sensitive)
  const basenameMatches = index.byBasename.get(cleanQuery);
  if (basenameMatches) {
    if (basenameMatches.length === 1) {
      return { exact: basenameMatches[0]!, candidates: [], isAmbiguous: false };
    } else {
      return { exact: null, candidates: basenameMatches, isAmbiguous: true };
    }
  }
  
  // 3. Case-insensitive basename match
  const lowerQuery = cleanQuery.toLowerCase();
  const caseInsensitiveMatches: ManagedFile[] = [];
  
  for (const [name, files] of index.byBasename.entries()) {
    if (name.toLowerCase() === lowerQuery) {
      caseInsensitiveMatches.push(...files);
    }
  }
  
  if (caseInsensitiveMatches.length > 0) {
    if (caseInsensitiveMatches.length === 1) {
      return { exact: caseInsensitiveMatches[0]!, candidates: [], isAmbiguous: false };
    } else {
      return { exact: null, candidates: caseInsensitiveMatches, isAmbiguous: true };
    }
  }
  
  // 4. Fuzzy / Partial match
  const allBasenames = new Set(index.byBasename.keys());
  const similarNames = findSimilarFiles(cleanQuery, allBasenames, 10);
  
  const candidates: ManagedFile[] = [];
  // Use a set to avoid duplicates if multiple similar names map to same files (unlikely given logic, but safe)
  const seenPaths = new Set<string>();
  
  for (const name of similarNames) {
    const files = index.byBasename.get(name);
    if (files) {
      for (const file of files) {
        if (!seenPaths.has(file.path)) {
          candidates.push(file);
          seenPaths.add(file.path);
        }
      }
    }
  }
  
  return { exact: null, candidates, isAmbiguous: candidates.length > 0 };
}

// ============================================================================
// Wikilink Generation
// ============================================================================

/**
 * Generate the shortest unambiguous wikilink target for a file.
 * 
 * Uses the basename if it's unique across all files in the index,
 * otherwise uses the vault-relative path (without .md extension).
 * 
 * This is consistent with Obsidian's "shortest path when possible" behavior
 * and with the bulk move wikilink update logic.
 */
export function getShortestWikilinkTarget(index: NoteIndex, file: ManagedFile): string {
  const name = basename(file.relativePath, '.md');
  const filesWithSameName = index.byBasename.get(name);
  
  // If basename is unique, use just the basename
  if (filesWithSameName && filesWithSameName.length === 1) {
    return name;
  }
  
  // Otherwise use the full relative path without extension
  return file.relativePath.replace(/\.md$/, '');
}

/**
 * Generate a wikilink string for a file.
 */
export function generateWikilink(index: NoteIndex, file: ManagedFile): string {
  const target = getShortestWikilinkTarget(index, file);
  return `[[${target}]]`;
}

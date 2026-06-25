/**
 * Navigation and file resolution logic.
 * 
 * This module handles building an index of vault files and resolving
 * user queries to specific files. It scans vault markdown while respecting
 * global exclusion rules (config.excluded_directories, legacy audit.ignored_directories,
 * vault-root .gitignore, hidden dot-directories, and BWRB_EXCLUDE / BWRB_AUDIT_EXCLUDE).
 */

import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import {
  buildVaultNoteSnapshot,
  discoverFilesForNavigation,
  filterByPath,
  findSimilarFiles,
  type ManagedFile
} from './discovery.js';
import { getEntityAliases } from './schema.js';

// ============================================================================
// Types
// ============================================================================

export interface NoteIndex {
  /** Map of relative path (with extension) to file */
  byPath: Map<string, ManagedFile>;
  /** Map of basename (no extension) to list of files */
  byBasename: Map<string, ManagedFile[]>;
  /** Map of declared alias to the entity files it resolves to */
  byAlias: Map<string, ManagedFile[]>;
  /** All discovered files */
  allFiles: ManagedFile[];
  /**
   * Full-vault basename map used ONLY for wikilink disambiguation.
   *
   * When the index is path-filtered (`buildNoteIndex(..., pathFilter)`), the
   * `byBasename` map above is scoped to the in-path notes so resolution honors
   * `--path` (#705). But wikilink generation must NOT use that scoped map to
   * decide whether a basename is globally unique: a basename duplicated across
   * the vault but unique within the path glob would otherwise emit a bare
   * `[[Duplicate]]` that can resolve to the wrong note in Obsidian.
   *
   * This map always reflects the UNFILTERED vault, so `getShortestWikilinkTarget`
   * path-qualifies globally-duplicated basenames even under a path-scoped search.
   * It is only populated when a path filter is applied; otherwise `byBasename`
   * already covers the whole vault and disambiguation falls back to it.
   */
  fullByBasename?: Map<string, ManagedFile[]>;
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
  * Build an index of all discoverable vault files for fast lookup.
  *
  * Uses the same global discovery rules as the rest of the CLI (exclusions apply
  * consistently across list/search/open/edit/audit).
  *
  * When `pathFilter` is provided, the candidate file set is narrowed by the same
  * glob normalization used by content search and bulk commands (`filterByPath`)
  * BEFORE any maps are built. This scopes every downstream resolution (path,
  * basename, alias, and fuzzy/partial matching) to the path-filtered set, so
  * name-mode `search --path` behaves consistently with `search --body --path`.
  */
export async function buildNoteIndex(
  schema: LoadedSchema,
  vaultDir: string,
  pathFilter?: string
): Promise<NoteIndex> {
  const allDiscovered = await discoverFilesForNavigation(schema, vaultDir);

  // When a path filter is active, resolution maps are built over the in-path
  // subset only, but we ALSO retain a full-vault basename map (derived from the
  // unfiltered discovery already in memory — no extra IO) so wikilink generation
  // can detect globally-duplicated basenames and path-qualify them even though
  // resolution is scoped to the glob (#705 regression fix).
  const files = pathFilter ? filterByPath(allDiscovered, pathFilter) : allDiscovered;

  const byPath = new Map<string, ManagedFile>();
  const byBasename = new Map<string, ManagedFile[]>();

  for (const file of files) {
    byPath.set(file.relativePath, file);

    const name = basename(file.relativePath, '.md');
    const existing = byBasename.get(name) || [];
    existing.push(file);
    byBasename.set(name, existing);
  }

  // Full-vault basename map for wikilink disambiguation. Only needed when the
  // resolution maps above were scoped by a path filter; without a filter,
  // `byBasename` already spans the whole vault.
  let fullByBasename: Map<string, ManagedFile[]> | undefined;
  if (pathFilter) {
    fullByBasename = new Map<string, ManagedFile[]>();
    for (const file of allDiscovered) {
      const name = basename(file.relativePath, '.md');
      const existing = fullByBasename.get(name) || [];
      existing.push(file);
      fullByBasename.set(name, existing);
    }
  }

  // Index entity aliases as additional resolution keys, so notes are findable by
  // their declared aliases. Reuses the single parse pass from the vault snapshot;
  // aliases only exist on schema-typed entities.
  // Lowercased real-basename set so a real note wins over an alias even when they
  // differ only by case, consistent with the case-insensitive basename lookup in
  // resolveNoteQuery.
  const basenamesLower = new Set<string>();
  for (const name of byBasename.keys()) {
    basenamesLower.add(name.toLowerCase());
  }
  const byAlias = new Map<string, ManagedFile[]>();
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  for (const note of snapshot.notes) {
    if (!note.resolvedType || !note.frontmatter) continue;
    const file = byPath.get(note.relativePath);
    if (!file) continue;
    const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
    for (const alias of aliases) {
      // A real note name always wins over an alias of the same string
      // (case-insensitively).
      if (basenamesLower.has(alias.toLowerCase())) continue;
      const existing = byAlias.get(alias) || [];
      existing.push(file);
      byAlias.set(alias, existing);
    }
  }

  return {
    byPath,
    byBasename,
    byAlias,
    allFiles: files,
    ...(fullByBasename ? { fullByBasename } : {}),
  };
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
 * 4. Alias match (case-sensitive, then case-insensitive)
 * 5. Fuzzy/Partial match
 */
function resolveByAlias(index: NoteIndex, cleanQuery: string): ManagedFile[] {
  const direct = index.byAlias.get(cleanQuery);
  if (direct && direct.length > 0) return dedupeFiles(direct);

  const lowerQuery = cleanQuery.toLowerCase();
  const matches: ManagedFile[] = [];
  for (const [alias, files] of index.byAlias.entries()) {
    if (alias.toLowerCase() === lowerQuery) {
      matches.push(...files);
    }
  }
  return dedupeFiles(matches);
}

function dedupeFiles(files: ManagedFile[]): ManagedFile[] {
  const seen = new Set<string>();
  const result: ManagedFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

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

  // 4. Alias match (entity declared this query as one of its aliases).
  // Real note names always win over aliases, so this only runs once basename
  // matching has failed. An alias claimed by multiple entities is ambiguous and
  // is never auto-resolved.
  const aliasMatches = resolveByAlias(index, cleanQuery);
  if (aliasMatches.length > 0) {
    if (aliasMatches.length === 1) {
      return { exact: aliasMatches[0]!, candidates: [], isAmbiguous: false };
    }
    return { exact: null, candidates: aliasMatches, isAmbiguous: true };
  }

  // 5. Fuzzy / Partial match
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
  // Disambiguate against the FULL vault, not a path-filtered subset. When the
  // index was scoped by `--path` (#705), `byBasename` only contains in-path
  // notes; using it here would treat a globally-duplicated basename as unique
  // and emit a bare `[[Duplicate]]` that resolves ambiguously in Obsidian.
  // `fullByBasename` (when present) always spans the whole vault; otherwise the
  // index is already unfiltered and `byBasename` is the full-vault map.
  const disambiguationByBasename = index.fullByBasename ?? index.byBasename;
  const filesWithSameName = disambiguationByBasename.get(name);
  
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

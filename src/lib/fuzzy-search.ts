/**
 * Fuzzy entity/note lookup for `search --fuzzy`.
 *
 * Returns scored candidate matches so an AI agent (or human) can ask
 * "does an entity like X already exist?" before creating a new note.
 *
 * Unlike the default name search (exact/substring resolution), this returns a
 * ranked list of approximate matches with a visible score, consulting both the
 * note name (basename) and any declared aliases (the `alias` field role).
 *
 * Scoring is deterministic and AI-agnostic: it reuses the shared
 * {@link levenshteinDistance} util and normalizes edit distance into a 0..1
 * similarity. Substring containment is given a floor so that a query which is
 * fully contained in a candidate (or vice versa) still scores as a usable hint
 * even when the length difference would otherwise sink the Levenshtein ratio.
 */

import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import type { ManagedFile, NoteIndex } from './navigation.js';
import { buildVaultNoteSnapshot } from './discovery.js';
import { getEntityAliases } from './schema.js';
import { levenshteinDistance } from './levenshtein.js';

// ============================================================================
// Constants
// ============================================================================

/** Default minimum similarity (0..1) for a candidate to be returned. */
export const DEFAULT_FUZZY_THRESHOLD = 0.5;

/** Default maximum number of ranked results returned. */
export const DEFAULT_FUZZY_LIMIT = 10;

/**
 * Similarity floor applied when the query is a substring of a candidate (or
 * vice versa). Substring containment is a strong "might be the same entity"
 * signal that raw edit-distance ratios undervalue for short queries against
 * long names, so we never let a containment match score below this.
 */
const SUBSTRING_SCORE_FLOOR = 0.6;

// ============================================================================
// Types
// ============================================================================

/** Which field on the note produced the winning score. */
export type FuzzyMatchField = 'name' | 'alias';

export interface FuzzyMatch {
  /** Note basename (no extension). */
  name: string;
  /** Wikilink-friendly shortest target / `[[name]]` is built by the caller. */
  file: ManagedFile;
  /** Best similarity score in 0..1 (1 = exact, higher is better). */
  score: number;
  /** Whether the best score came from the name or one of the aliases. */
  matchedField: FuzzyMatchField;
  /** The actual string (name or specific alias) that produced the best score. */
  matchedValue: string;
  /** All aliases declared on the note (for agent context). */
  aliases: string[];
}

export interface FuzzySearchOptions {
  /** Minimum similarity (0..1). Defaults to {@link DEFAULT_FUZZY_THRESHOLD}. */
  threshold?: number;
  /** Max results. Defaults to {@link DEFAULT_FUZZY_LIMIT}. */
  limit?: number;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Similarity between two strings in 0..1 (1 = identical), case-insensitive.
 *
 * Combines a normalized Levenshtein ratio with a substring-containment floor.
 */
export function similarityScore(query: string, candidate: string): number {
  const a = query.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();

  if (a === '' || b === '') return 0;
  if (a === b) return 1;

  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const levRatio = maxLen === 0 ? 0 : 1 - dist / maxLen;

  // Substring containment is a strong signal; floor it so short-vs-long pairs
  // (e.g. "Steve" inside "Steve Yegge") still surface as candidates.
  if (b.includes(a) || a.includes(b)) {
    return Math.max(levRatio, SUBSTRING_SCORE_FLOOR);
  }

  return levRatio;
}

// ============================================================================
// Search
// ============================================================================

/**
 * Run a fuzzy search over the vault, returning ranked candidate matches.
 *
 * Fields that participate in matching:
 *  - the note name (file basename, sans `.md`) — always
 *  - every declared alias (via {@link getEntityAliases}) — for schema-typed
 *    entities that have an `alias`-role field
 *
 * Each note contributes its single best-scoring field. Results at or above the
 * threshold are returned best-first, then capped to `limit`.
 */
export async function fuzzySearch(
  index: NoteIndex,
  query: string,
  schema: LoadedSchema,
  vaultDir: string,
  options: FuzzySearchOptions = {}
): Promise<FuzzyMatch[]> {
  const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const limit = options.limit ?? DEFAULT_FUZZY_LIMIT;

  const cleanQuery = query.replace(/\.md$/, '').trim();
  if (cleanQuery === '') return [];

  // Build a single map of relativePath -> aliases from one parse pass.
  const aliasesByPath = new Map<string, string[]>();
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  for (const note of snapshot.notes) {
    if (!note.resolvedType || !note.frontmatter) continue;
    const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
    if (aliases.length > 0) {
      aliasesByPath.set(note.relativePath, aliases);
    }
  }

  const matches: FuzzyMatch[] = [];

  for (const file of index.allFiles) {
    const name = basename(file.relativePath, '.md');
    const aliases = aliasesByPath.get(file.relativePath) ?? [];

    // Score the name first; aliases only win on a strictly higher score so an
    // exact name match always beats an aliased near-match.
    let bestScore = similarityScore(cleanQuery, name);
    let bestField: FuzzyMatchField = 'name';
    let bestValue = name;

    for (const alias of aliases) {
      const aliasScore = similarityScore(cleanQuery, alias);
      if (aliasScore > bestScore) {
        bestScore = aliasScore;
        bestField = 'alias';
        bestValue = alias;
      }
    }

    if (bestScore >= threshold) {
      matches.push({
        name,
        file,
        score: bestScore,
        matchedField: bestField,
        matchedValue: bestValue,
        aliases,
      });
    }
  }

  // Best score first; tie-break by name for deterministic ordering.
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'en'));

  return matches.slice(0, limit);
}

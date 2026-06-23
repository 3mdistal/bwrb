/**
 * Shared "close match" (typo-suggestion) utility.
 *
 * Many call sites want the same primitive: take a (possibly misspelled) query,
 * compare it against a list of candidate strings via {@link levenshteinDistance},
 * keep the ones within an edit-distance threshold, and return them best-first.
 * Before this util that loop was copy-pasted in `schema.ts`
 * (`findCloseMatches`), `template.ts` (`findClosestMatch`), and the audit
 * detections, each with subtly different thresholds and return shapes.
 *
 * The legitimate per-caller differences are parameterized via {@link CloseMatchOptions}
 * (case handling, threshold, whether exact matches count, result cap) so each
 * caller keeps its EXACT prior behavior. This util deliberately does NOT cover
 * the richer scoring helpers that are a different contract:
 *  - `validation.ts` `suggestOptionValue`/`suggestFieldName` (tiered
 *    exact/prefix/contains-then-distance),
 *  - `audit/unknown-field.ts` `getSimilarFieldCandidates` (token normalization +
 *    singular/plural + type-mismatch priority),
 *  - `discovery.ts` `findSimilarFiles` (weighted multi-signal score),
 *  - `fuzzy-search.ts` `similarityScore` (0..1 score with a substring floor).
 */

import { levenshteinDistance } from './levenshtein.js';

/** A single close-match result: the original candidate and its edit distance. */
export interface CloseMatch {
  /** The candidate string, in its original casing. */
  value: string;
  /** Levenshtein distance from the query (after optional lowercasing). */
  distance: number;
}

export interface CloseMatchOptions {
  /**
   * Maximum (inclusive) Levenshtein distance for a candidate to be kept.
   * Required — thresholds differ per caller and there is no sensible default.
   */
  maxDistance: number;
  /**
   * Lowercase both the query and each candidate before comparing.
   * Defaults to `true` (the common typo-suggestion behavior).
   */
  caseInsensitive?: boolean;
  /**
   * Drop candidates whose distance is 0 (i.e. an exact, case-folded match).
   * Some callers only ever pass already-unknown queries and want to keep a
   * distance-0 row out of the results; others rely on exact matches never
   * occurring. Defaults to `false`.
   */
  excludeExact?: boolean;
  /** Cap the number of returned matches. Defaults to unlimited. */
  limit?: number;
}

/**
 * Return candidates within `maxDistance` of `query`, sorted closest-first.
 *
 * Ordering is by ascending distance; ties preserve the input order of
 * `candidates` (the sort is stable), matching the behavior of the hand-written
 * loops this replaces. Callers that need alphabetical tie-breaking should sort
 * the returned list themselves (or sort their candidate list beforehand).
 */
export function closeMatches(
  query: string,
  candidates: Iterable<string>,
  options: CloseMatchOptions
): CloseMatch[] {
  const { maxDistance, caseInsensitive = true, excludeExact = false, limit } = options;

  const normalizedQuery = caseInsensitive ? query.toLowerCase() : query;
  const matches: CloseMatch[] = [];

  for (const candidate of candidates) {
    const normalizedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
    const distance = levenshteinDistance(normalizedQuery, normalizedCandidate);
    if (distance > maxDistance) continue;
    if (excludeExact && distance === 0) continue;
    matches.push({ value: candidate, distance });
  }

  // Stable sort by distance keeps input order on ties.
  matches.sort((a, b) => a.distance - b.distance);

  return typeof limit === 'number' ? matches.slice(0, limit) : matches;
}

/**
 * Return only the candidate values within `maxDistance`, sorted closest-first.
 * Thin wrapper over {@link closeMatches} for callers that just want names.
 */
export function closeMatchValues(
  query: string,
  candidates: Iterable<string>,
  options: CloseMatchOptions
): string[] {
  return closeMatches(query, candidates, options).map((m) => m.value);
}

/**
 * Return the single closest candidate within `maxDistance`, or `undefined`.
 * On a distance tie the first-encountered candidate wins (stable order).
 */
export function closestMatch(
  query: string,
  candidates: Iterable<string>,
  options: CloseMatchOptions
): string | undefined {
  return closeMatches(query, candidates, { ...options, limit: 1 })[0]?.value;
}

/**
 * `unlinked-mention` audit detection — the web-integrity safety net.
 *
 * bwrb knows every note (by basename) and, via the alias field role (#266),
 * every declared alias. This detection scans note **bodies** for the literal
 * name or a registered alias of a known entity appearing as plain text but
 * **not** wikilinked, and flags it.
 *
 * The trust line (decided design, see plans/features/ingest-safety-net.md §3):
 *  - **Exact name or registered alias**, present as unlinked plain text, that
 *    resolves to exactly one entity → TRUSTED → auto-fixable. `--fix --auto`
 *    rewrites it to a wikilink, preserving the surface text via the alias
 *    display form (`[[Entity|surface]]`) when the surface differs from the
 *    canonical note name.
 *  - **Fuzzy near-match** (Levenshtein) → REVIEW ITEM ("did you mean?"),
 *    **never** auto-linked.
 *  - **Ambiguity** (a surface that matches multiple entities/aliases) → never
 *    auto-resolved → visible review item. Nothing is swept under the rug.
 *
 * False-positive guards: text already inside `[[...]]`, markdown links, fenced
 * code blocks, inline code, and bare URLs is masked before scanning. Matching
 * is word-boundary aware and case-insensitive, but the original surface casing
 * is preserved in the fix. A note never flags a mention of its own name/alias.
 *
 * Performance: the entity index is built once per audit run (not per file), and
 * each body is scanned with a single combined alternation regex over all known
 * surfaces rather than one pass per entity — keeping cost ~O(body length) per
 * note instead of O(notes × entities). See #500.
 */

import { basename } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import type { VaultNoteSnapshot } from '../discovery.js';
import { getEntityAliases } from '../schema.js';
import { levenshteinDistance } from '../levenshtein.js';
import type { AuditIssue } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum surface length (in characters) to consider for matching. Single- and
 * two-character names are too noisy to flag safely in prose.
 */
const MIN_SURFACE_LENGTH = 3;

/**
 * Fuzzy tier: default maximum Levenshtein distance (case-insensitive) between an
 * unmatched candidate phrase and a known entity surface for it to be offered as
 * a "did you mean?" review item. Kept small so only genuine near-misses surface.
 *
 * This is the *default*; it is configurable per run via
 * {@link UnlinkedMentionOptions.fuzzyThreshold} (CLI `--mention-fuzzy-threshold`
 * or schema `config.mention_fuzzy_threshold`). See #622.
 */
const DEFAULT_FUZZY_MAX_DISTANCE = 2;

/**
 * Inclusive bounds for a user-supplied fuzzy threshold. 0 disables the fuzzy
 * tier (no near-miss is ever within distance 0 of a non-exact surface); the
 * upper bound keeps the tier from degenerating into noise.
 */
const MIN_FUZZY_THRESHOLD = 0;
const MAX_FUZZY_THRESHOLD = 5;

/**
 * Fuzzy tier: a candidate must be at least this long to be eligible, so short
 * words don't fuzzy-match unrelated entities by coincidence.
 */
const FUZZY_MIN_CANDIDATE_LENGTH = 4;

/** Cap on how many distinct fuzzy "did you mean?" suggestions to list. */
const FUZZY_MAX_SUGGESTIONS = 3;

// ============================================================================
// Types
// ============================================================================

/**
 * Per-run tunables for the `unlinked-mention` fuzzy ("did you mean?") tier (#622).
 *
 * Both fields are optional and default to the conservative built-in behavior:
 * fuzzy enabled at distance {@link DEFAULT_FUZZY_MAX_DISTANCE}. The exact/alias
 * and ambiguous tiers are NOT affected by these options.
 */
export interface UnlinkedMentionOptions {
  /**
   * Maximum Levenshtein distance for a fuzzy near-match. Defaults to
   * {@link DEFAULT_FUZZY_MAX_DISTANCE}. A value of 0 effectively disables the
   * fuzzy tier (only an exact match has distance 0, and exact matches are
   * handled by the exact tier). Must be within
   * [{@link MIN_FUZZY_THRESHOLD}, {@link MAX_FUZZY_THRESHOLD}].
   */
  fuzzyThreshold?: number;
  /**
   * When false, the fuzzy ("did you mean?") tier is skipped entirely (the
   * capitalized-phrase heuristic never runs). Exact/alias auto-fix and ambiguous
   * flagging are unchanged. Defaults to true.
   */
  fuzzyEnabled?: boolean;
}

/**
 * Validate a user-supplied fuzzy threshold, returning the parsed integer or a
 * descriptive error. Accepts string (CLI) or number (config) input. Rejects
 * non-integers and out-of-range values with a clear message (#622).
 */
export function parseFuzzyThreshold(
  raw: string | number
): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      error: `Invalid fuzzy threshold '${raw}': must be an integer between ${MIN_FUZZY_THRESHOLD} and ${MAX_FUZZY_THRESHOLD}.`,
    };
  }
  if (n < MIN_FUZZY_THRESHOLD || n > MAX_FUZZY_THRESHOLD) {
    return {
      ok: false,
      error: `Invalid fuzzy threshold '${raw}': must be between ${MIN_FUZZY_THRESHOLD} and ${MAX_FUZZY_THRESHOLD}.`,
    };
  }
  return { ok: true, value: n };
}

/** How a known surface relates to its entity. */
export type SurfaceKind = 'name' | 'alias';

/** A single known surface string that can be mentioned in prose. */
interface EntitySurface {
  /** The matchable surface text (canonical note name or a declared alias). */
  surface: string;
  /** The canonical note name (basename, no extension) to link to. */
  canonicalName: string;
  /** Vault-relative path of the source note (used to skip self-mentions). */
  sourcePath: string;
  /** Whether this surface is the note name or one of its aliases. */
  kind: SurfaceKind;
}

/**
 * Precomputed index of every linkable surface in the vault, plus a single
 * combined matcher. Built once per audit run.
 */
export interface EntityMentionIndex {
  /** lowercased surface -> all entities that expose it. */
  bySurface: Map<string, EntitySurface[]>;
  /** All distinct entity names (for the fuzzy "did you mean?" tier). */
  allNames: string[];
  /**
   * Combined word-boundary alternation regex over all known surfaces, or null
   * when the vault exposes no surfaces. Created fresh per scan by the caller via
   * {@link matchSurfaces} (regex carries `lastIndex` state, so it is not reused).
   */
  readonly surfacePattern: string | null;
}

// ============================================================================
// Index construction
// ============================================================================

/**
 * Build the vault-wide entity-mention index from a note snapshot.
 *
 * Registers each note's basename as a `name` surface and every declared alias
 * (via {@link getEntityAliases}) as an `alias` surface. Surfaces shorter than
 * {@link MIN_SURFACE_LENGTH} are skipped to avoid noise.
 */
export function buildEntityMentionIndex(
  snapshot: VaultNoteSnapshot,
  schema: LoadedSchema
): EntityMentionIndex {
  const bySurface = new Map<string, EntitySurface[]>();
  const allNames: string[] = [];
  const surfaceSet = new Set<string>();

  const register = (surface: EntitySurface): void => {
    const trimmed = surface.surface.trim();
    if (trimmed.length < MIN_SURFACE_LENGTH) return;
    const key = trimmed.toLowerCase();
    const existing = bySurface.get(key);
    const entry: EntitySurface = { ...surface, surface: trimmed };
    if (existing) {
      // De-dup identical (surface, canonicalName, kind) pairs from the same note.
      if (
        !existing.some(
          (e) =>
            e.canonicalName === entry.canonicalName &&
            e.sourcePath === entry.sourcePath &&
            e.kind === entry.kind
        )
      ) {
        existing.push(entry);
      }
    } else {
      bySurface.set(key, [entry]);
    }
    surfaceSet.add(trimmed);
  };

  for (const note of snapshot.notes) {
    const name = basename(note.relativePath, '.md');
    if (name) {
      allNames.push(name);
      register({
        surface: name,
        canonicalName: name,
        sourcePath: note.relativePath,
        kind: 'name',
      });
    }

    if (note.resolvedType && note.frontmatter) {
      const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
      for (const alias of aliases) {
        register({
          surface: alias,
          canonicalName: name,
          sourcePath: note.relativePath,
          kind: 'alias',
        });
      }
    }
  }

  // Sort surfaces longest-first so the combined alternation prefers the longest
  // match (e.g. "Steve Yegge" wins over "Steve" at the same position).
  const surfaces = Array.from(surfaceSet).sort((a, b) => b.length - a.length);
  const surfacePattern =
    surfaces.length > 0
      ? surfaces.map((s) => escapeRegExp(s)).join('|')
      : null;

  return { bySurface, allNames, surfacePattern };
}

// ============================================================================
// Body masking (false-positive guards)
// ============================================================================

/**
 * Replace a matched region with same-length spaces, preserving newlines so line
 * numbers stay accurate. Masking (rather than deleting) keeps every character
 * offset stable for later word-boundary matching.
 */
function blankOut(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Mask ONLY code regions (fenced code blocks + inline code spans), leaving links
 * and prose intact. Returns a string of identical length/line structure with the
 * code regions blanked to spaces so character offsets and line numbers stay
 * accurate.
 *
 * This is the shared primitive behind {@link maskNonProse}. It is exported for
 * body-LINK validation (#652), which must still SEE wikilinks/markdown links
 * (they are exactly what it inspects) but must NOT flag links written inside
 * code fences or inline code.
 */
export function maskCodeSpans(body: string): string {
  let masked = body;

  const maskPattern = (pattern: RegExp): void => {
    masked = masked.replace(pattern, (m) => blankOut(m));
  };

  // Fenced code blocks (``` or ~~~), including the fences and content.
  maskPattern(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm);
  // Unterminated fence to end of document.
  maskPattern(/^[ \t]*(```|~~~)[\s\S]*$/gm);
  // Inline code spans.
  maskPattern(/`[^`\n]+`/g);

  return masked;
}

/**
 * Mask regions of the body where a literal name match must NOT be flagged:
 * fenced code blocks, inline code, existing wikilinks, markdown links, and bare
 * URLs. Returns a string of identical length/line structure with those regions
 * blanked to spaces.
 */
export function maskNonProse(body: string): string {
  // Reuse the shared code-span masking, then additionally blank out links/URLs
  // (which body-link validation deliberately keeps visible).
  let masked = maskCodeSpans(body);

  const maskPattern = (pattern: RegExp): void => {
    masked = masked.replace(pattern, (m) => blankOut(m));
  };

  // Existing wikilinks (including display-aliased form).
  maskPattern(/\[\[[^\]]*\]\]/g);
  // Markdown links/images: keep the visible text out of scope entirely so we
  // don't link inside an existing link or its URL.
  maskPattern(/!?\[[^\]]*\]\([^)]*\)/g);
  // Bare URLs.
  maskPattern(/\bhttps?:\/\/\S+/gi);
  maskPattern(/\bwww\.\S+/gi);

  return masked;
}

// ============================================================================
// Surface matching
// ============================================================================

/** A located surface occurrence in the masked body. */
interface SurfaceHit {
  surface: string;
  start: number;
  end: number;
}

/**
 * Find all word-boundary, case-insensitive occurrences of any known surface in
 * the masked body using a single combined regex pass.
 */
function matchSurfaces(maskedBody: string, surfacePattern: string): SurfaceHit[] {
  const hits: SurfaceHit[] = [];
  // Word boundaries on both sides so we don't match inside larger words.
  // `\b` is unreliable for surfaces with leading/trailing non-word chars, so we
  // use explicit non-word lookarounds that also accept string edges.
  const re = new RegExp(`(?<![\\w'])(?:${surfacePattern})(?![\\w'])`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskedBody)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    hits.push({ surface: m[0], start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

/** Compute 1-based line number for a character offset. */
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Scan a single note body for unlinked mentions of known entities.
 *
 * `selfPath` is the vault-relative path of the note being scanned, used to
 * suppress self-mentions (a note never flags references to its own name/alias).
 */
export function detectUnlinkedMentions(
  body: string,
  selfPath: string,
  index: EntityMentionIndex,
  options?: UnlinkedMentionOptions
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!index.surfacePattern) return issues;

  const fuzzyEnabled = options?.fuzzyEnabled ?? true;
  const fuzzyThreshold = options?.fuzzyThreshold ?? DEFAULT_FUZZY_MAX_DISTANCE;

  const masked = maskNonProse(body);

  // --- Exact / alias / ambiguous tiers ----------------------------------
  const hits = matchSurfaces(masked, index.surfacePattern);
  // Track positions consumed by exact matches so fuzzy doesn't double-flag them.
  const consumed: Array<[number, number]> = [];

  for (const hit of hits) {
    const entities = index.bySurface.get(hit.surface.toLowerCase());
    if (!entities || entities.length === 0) continue;

    // A note never flags a mention that points back to itself.
    const others = entities.filter((e) => e.sourcePath !== selfPath);
    if (others.length === 0) continue;

    consumed.push([hit.start, hit.end]);

    const line = lineNumberAt(body, hit.start);
    const distinctTargets = new Set(others.map((e) => e.canonicalName));

    if (distinctTargets.size > 1) {
      // Ambiguous: matches multiple distinct entities. Never auto-resolve.
      const candidates = Array.from(distinctTargets).sort((a, b) =>
        a.localeCompare(b, 'en')
      );
      issues.push({
        severity: 'warning',
        code: 'unlinked-mention',
        message: `Ambiguous unlinked mention on line ${line}: '${hit.surface}' could link to ${candidates.length} entities`,
        value: hit.surface,
        autoFixable: false,
        inBody: true,
        lineNumber: line,
        candidates,
        suggestion: `Ambiguous — link manually to one of: ${candidates
          .map((c) => `[[${c}]]`)
          .join(', ')}`,
        meta: {
          tier: 'ambiguous',
          surface: hit.surface,
          offset: hit.start,
        },
      });
      continue;
    }

    // Unambiguous: exactly one entity. Trusted → auto-fixable.
    const entity = others[0]!;
    const canonical = entity.canonicalName;
    // Preserve surface casing/text via display alias when it differs from the
    // canonical note name (case-insensitive comparison: same text, different
    // case still uses the display form to preserve the author's casing).
    const useDisplayForm = hit.surface !== canonical;
    const replacement = useDisplayForm
      ? `[[${canonical}|${hit.surface}]]`
      : `[[${canonical}]]`;

    issues.push({
      severity: 'warning',
      code: 'unlinked-mention',
      message: `Unlinked mention on line ${line}: '${hit.surface}' is ${
        entity.kind === 'alias' ? `an alias of '${canonical}'` : `the note '${canonical}'`
      } but not wikilinked`,
      value: hit.surface,
      autoFixable: true,
      inBody: true,
      lineNumber: line,
      targetName: canonical,
      suggestion: `Link to ${replacement}`,
      meta: {
        tier: 'exact',
        surface: hit.surface,
        offset: hit.start,
        matchedKind: entity.kind,
        replacement,
      },
    });
  }

  // --- Fuzzy tier ("did you mean?") -------------------------------------
  // Only run on prose not already consumed by an exact match. Tokenize
  // capitalized words/phrases and offer near-miss entity names. Flag-only.
  // Skipped entirely when disabled or when the threshold is 0 (#622).
  if (fuzzyEnabled && fuzzyThreshold > 0) {
    for (const fuzzy of detectFuzzyCandidates(
      masked,
      body,
      selfPath,
      index,
      consumed,
      fuzzyThreshold
    )) {
      issues.push(fuzzy);
    }
  }

  return issues;
}

/**
 * Find capitalized prose phrases that are a near (Levenshtein) match to a known
 * entity name but not an exact match, and emit flag-only "did you mean?" items.
 */
function detectFuzzyCandidates(
  masked: string,
  body: string,
  selfPath: string,
  index: EntityMentionIndex,
  consumed: Array<[number, number]>,
  fuzzyMaxDistance: number
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  const isConsumed = (start: number, end: number): boolean =>
    consumed.some(([s, e]) => start < e && end > s);

  // Candidate phrases: runs of capitalized words (proper-noun-ish), e.g.
  // "Steve Yeg", "Mercry". Conservative to keep the fuzzy tier low-noise.
  const phraseRe = /\b[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*/g;
  // Known surfaces (lowercased) for exact-membership checks.
  const knownSurfaces = index.bySurface;

  // Expand a maximal capitalized run into candidate sub-phrases: the full run
  // plus each suffix beginning at a later word, with absolute offsets. This lets
  // a near-match survive a leading common-but-capitalized word ("Also Steve
  // Yeg" → "Steve Yeg"). Suffixes only (not arbitrary infixes) to stay cheap.
  const expandCandidates = (
    phrase: string,
    phraseStart: number
  ): Array<{ text: string; start: number }> => {
    const out: Array<{ text: string; start: number }> = [{ text: phrase, start: phraseStart }];
    const wordRe = /\S+/g;
    const offsets: number[] = [];
    let w: RegExpExecArray | null;
    while ((w = wordRe.exec(phrase)) !== null) offsets.push(w.index);
    for (let i = 1; i < offsets.length; i++) {
      out.push({ text: phrase.slice(offsets[i]!), start: phraseStart + offsets[i]! });
    }
    return out;
  };

  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(masked)) !== null) {
    const fullPhrase = m[0];
    if (fullPhrase.length < FUZZY_MIN_CANDIDATE_LENGTH) continue;

    // Pick the best-scoring candidate sub-phrase for this run.
    let best:
      | { phrase: string; start: number; suggestions: Array<{ name: string; distance: number }> }
      | null = null;

    for (const cand of expandCandidates(fullPhrase, m.index)) {
      const phrase = cand.text;
      if (phrase.length < FUZZY_MIN_CANDIDATE_LENGTH) continue;
      const start = cand.start;
      const end = start + phrase.length;
      if (isConsumed(start, end)) continue;

      const lower = phrase.toLowerCase();
      // Skip exact known surfaces (handled by the exact tier).
      if (knownSurfaces.has(lower)) continue;

      const suggestions: Array<{ name: string; distance: number }> = [];
      for (const name of index.allNames) {
        if (name.length < FUZZY_MIN_CANDIDATE_LENGTH) continue;
        const dist = levenshteinDistance(lower, name.toLowerCase());
        if (dist === 0) continue;
        if (dist <= fuzzyMaxDistance) {
          suggestions.push({ name, distance: dist });
        }
      }
      if (suggestions.length === 0) continue;

      const bestDist = Math.min(...suggestions.map((s) => s.distance));
      const incumbentDist = best ? Math.min(...best.suggestions.map((s) => s.distance)) : Infinity;
      if (bestDist < incumbentDist) {
        best = { phrase, start, suggestions };
      }
    }

    if (!best) continue;
    const { phrase, start } = best;
    const suggestions = best.suggestions;

    // Don't suggest linking a note to itself.
    const selfName = basename(selfPath, '.md');
    const filtered = suggestions.filter((s) => s.name !== selfName);
    if (filtered.length === 0) continue;

    filtered.sort(
      (a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en')
    );
    const top = filtered.slice(0, FUZZY_MAX_SUGGESTIONS);

    const dedupeKey = `${start}:${phrase}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const line = lineNumberAt(body, start);
    const names = top.map((s) => s.name);
    issues.push({
      severity: 'warning',
      code: 'unlinked-mention',
      message: `Possible unlinked mention on line ${line}: '${phrase}' looks like ${names
        .map((n) => `'${n}'`)
        .join(' or ')}`,
      value: phrase,
      autoFixable: false,
      inBody: true,
      lineNumber: line,
      similarFiles: names,
      suggestion: `Did you mean ${names.map((n) => `[[${n}]]`).join(' or ')}? (not auto-linked)`,
      meta: {
        tier: 'fuzzy',
        surface: phrase,
        offset: start,
      },
    });
  }

  return issues;
}

// ============================================================================
// Helpers
// ============================================================================

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * is word-boundary aware. Multi-word names and aliases match
 * case-insensitively, but single-word note names must match the note's
 * canonical casing exactly. Single-word note names that are common English
 * words are skipped entirely; explicit aliases are exempt because aliases are
 * user-declared intent. In addition, the audit can calibrate single-word note
 * names against the vault's own prose: a name that appears in several notes
 * mostly without the canonical proper-noun casing is treated like a local
 * common word and removed from exact matching, fuzzy suggestions, and
 * frequent-term nudges for that run. Exact single-word name matches with
 * capitalized canonical casing are also skipped where capitalization carries no
 * signal (sentence/list/heading starts). A note never flags a mention of its own
 * name/alias.
 *
 * Fuzzy matching is also conservative: the configured threshold is a cap, and
 * the actual allowed distance scales with candidate length so short capitalized
 * words do not get a 50% edit budget.
 *
 * Performance: the entity index is built once per audit run (not per file), and
 * each body is scanned with a single combined alternation regex over all known
 * surfaces rather than one pass per entity — keeping cost ~O(body length) per
 * note instead of O(notes × entities). See #500.
 */

import { basename } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import type { VaultNoteSnapshot } from '../discovery.js';
import { matchesPathPattern } from '../discovery.js';
import { parseNote } from '../frontmatter.js';
import { getEntityAliases } from '../schema.js';
import { levenshteinDistance } from '../levenshtein.js';
import type { AuditIssue } from './types.js';
import { isCommonEnglishWord } from './common-english-words.js';

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
 * The effective distance is also capped by candidate length:
 * `min(configuredThreshold, floor(candidateLength / 4))`.
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
 * Corpus calibration (#783): minimum number of distinct non-self notes whose
 * prose must contain a single-word name before local-commonness damping can
 * apply. Kept conservative and exposed through schema config.
 */
export const DEFAULT_CORPUS_CALIBRATION_MIN_NOTES = 3;

/**
 * Corpus calibration (#783): non-canonical-case occurrence share must be
 * strictly greater than this ratio before a name is damped. The strict boundary
 * means a 50/50 split keeps the surface.
 */
export const DEFAULT_CORPUS_CALIBRATION_NON_CANONICAL_RATIO = 0.5;

/**
 * Fuzzy tier: a candidate must be at least this long to be eligible, so short
 * words don't fuzzy-match unrelated entities by coincidence.
 */
const FUZZY_MIN_CANDIDATE_LENGTH = 4;

/** Cap on how many distinct fuzzy "did you mean?" suggestions to list. */
const FUZZY_MAX_SUGGESTIONS = 3;

const COMMON_STRUCTURAL_HEADING_LABELS = new Set([
  'backlinks',
  'context',
  'ideas',
  'links',
  'notes',
  'references',
  'related',
  'resources',
  'summary',
  'tasks',
  'todo',
  'todos',
]);

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

/** Per-run corpus tallies used to damp vault-common single-word note names. */
export interface MentionCorpusStats {
  words: Map<string, MentionCorpusWordStats>;
}

interface MentionCorpusWordStats {
  totalOccurrences: number;
  notes: Set<string>;
  exactOccurrencesByForm: Map<string, number>;
  perNote: Map<string, MentionCorpusNoteWordStats>;
}

interface MentionCorpusNoteWordStats {
  totalOccurrences: number;
  exactOccurrencesByForm: Map<string, number>;
}

/** Tunables for index-time corpus calibration of common single-word names. */
export interface MentionCorpusCalibrationOptions {
  enabled?: boolean;
  minNotes?: number;
  nonCanonicalRatio?: number;
  stats?: MentionCorpusStats;
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
  /** True when a name surface is known but excluded from linkable mention tiers. */
  excludedFromMentionIndex?: boolean;
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
   * Known-but-excluded surfaces that must not be link targets or fuzzy
   * suggestions, but should still suppress `frequent-unlinked-term` "create a
   * note" nudges.
   */
  excludedSurfaces: Set<string>;
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
 * {@link MIN_SURFACE_LENGTH} are skipped to avoid noise. Single-word common
 * English note names remain in the index for cross-detector known-entity checks
 * but are excluded from the exact-match regex and fuzzy name suggestions;
 * declared aliases are not.
 */
export function buildEntityMentionIndex(
  snapshot: VaultNoteSnapshot,
  schema: LoadedSchema,
  corpusCalibration?: MentionCorpusCalibrationOptions
): EntityMentionIndex {
  const bySurface = new Map<string, EntitySurface[]>();
  const allNames: string[] = [];
  const excludedSurfaces = new Set<string>();
  const exactMatchSurfaceSet = new Set<string>();
  const corpusOptions: Required<Omit<MentionCorpusCalibrationOptions, 'stats'>> & {
    stats?: MentionCorpusStats;
  } = {
    enabled: corpusCalibration?.enabled ?? true,
    minNotes: corpusCalibration?.minNotes ?? DEFAULT_CORPUS_CALIBRATION_MIN_NOTES,
    nonCanonicalRatio:
      corpusCalibration?.nonCanonicalRatio ??
      DEFAULT_CORPUS_CALIBRATION_NON_CANONICAL_RATIO,
    ...(corpusCalibration?.stats ? { stats: corpusCalibration.stats } : {}),
  };

  const register = (surface: EntitySurface): void => {
    const trimmed = surface.surface.trim();
    if (trimmed.length < MIN_SURFACE_LENGTH) return;
    const key = trimmed.toLowerCase();
    const existing = bySurface.get(key);
    const skippedNameSurface = isSkippedCommonNameSurface(surface, corpusOptions);
    const entry: EntitySurface = {
      ...surface,
      surface: trimmed,
      ...(skippedNameSurface ? { excludedFromMentionIndex: true } : {}),
    };
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
    if (skippedNameSurface) {
      registerExcludedSurface(trimmed);
    } else {
      exactMatchSurfaceSet.add(trimmed);
    }
  };

  const registerExcludedSurface = (surface: string): void => {
    const trimmed = surface.trim();
    if (trimmed.length < MIN_SURFACE_LENGTH) return;
    excludedSurfaces.add(trimmed.toLowerCase());
  };

  for (const note of snapshot.notes) {
    const name = basename(note.relativePath, '.md');
    const mentionTargetType = getMentionTargetType(note);

    if (isExcludedMentionTarget(note, schema)) {
      if (name) registerExcludedSurface(name);
      if (mentionTargetType && note.frontmatter) {
        const aliases = getEntityAliases(schema, mentionTargetType, note.frontmatter);
        for (const alias of aliases) {
          registerExcludedSurface(alias);
        }
      }
      continue;
    }

    if (name) {
      const nameSurface: EntitySurface = {
        surface: name,
        canonicalName: name,
        sourcePath: note.relativePath,
        kind: 'name',
      };
      if (!isSkippedCommonNameSurface(nameSurface, corpusOptions)) {
        allNames.push(name);
      }
      register(nameSurface);
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
  const surfaces = Array.from(exactMatchSurfaceSet).sort((a, b) => b.length - a.length);
  const surfacePattern =
    surfaces.length > 0
      ? surfaces.map((s) => escapeRegExp(s)).join('|')
      : null;

  return { bySurface, allNames, excludedSurfaces, surfacePattern };
}

/**
 * Build run-scoped word casing stats from the full vault snapshot in one body
 * pass. Non-prose regions are masked before prose tokenization, but wikilink
 * targets/display text are counted separately as entity evidence. Parse failures
 * are skipped. The caller consults these stats per surface while excluding that
 * surface's own note body from the decision.
 */
export async function buildMentionCorpusStats(
  snapshot: VaultNoteSnapshot
): Promise<MentionCorpusStats> {
  const stats: MentionCorpusStats = { words: new Map() };

  for (const note of snapshot.notes) {
    try {
      const { body } = await parseNote(note.path);
      if (!body || body.trim().length === 0) continue;
      addBodyToMentionCorpusStats(stats, body, note.relativePath);
    } catch {
      // Missing/unparseable note bodies simply do not contribute corpus evidence.
    }
  }

  return stats;
}

function addBodyToMentionCorpusStats(
  stats: MentionCorpusStats,
  body: string,
  notePath: string
): void {
  addWikilinkEvidenceToMentionCorpusStats(stats, body, notePath);

  const masked = maskNonProse(body);
  const wordRe = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;
  let match: RegExpExecArray | null;

  while ((match = wordRe.exec(masked)) !== null) {
    addCorpusWordOccurrence(stats, match[0], notePath);
  }
}

function addWikilinkEvidenceToMentionCorpusStats(
  stats: MentionCorpusStats,
  body: string,
  notePath: string
): void {
  const wikilinkRe = /\[\[([^\]]*)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = wikilinkRe.exec(body)) !== null) {
    const inner = match[1]?.trim();
    if (!inner) continue;

    const [rawTarget, ...displayParts] = inner.split('|');
    const target = normalizeWikilinkEvidenceText(rawTarget ?? '');
    if (target) addCorpusWordsFromText(stats, target, notePath);

    const display = displayParts.join('|').trim();
    if (display) addCorpusWordsFromText(stats, display, notePath);
  }
}

function normalizeWikilinkEvidenceText(value: string): string {
  const withoutHeading = value.split('#')[0]?.trim() ?? '';
  if (!withoutHeading) return '';
  return basename(withoutHeading, '.md');
}

function addCorpusWordsFromText(
  stats: MentionCorpusStats,
  text: string,
  notePath: string
): void {
  const wordRe = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(text)) !== null) {
    addCorpusWordOccurrence(stats, match[0], notePath);
  }
}

function addCorpusWordOccurrence(
  stats: MentionCorpusStats,
  word: string,
  notePath: string
): void {
  const lower = word.toLowerCase();
  let wordStats = stats.words.get(lower);
  if (!wordStats) {
    wordStats = {
      totalOccurrences: 0,
      notes: new Set<string>(),
      exactOccurrencesByForm: new Map<string, number>(),
      perNote: new Map<string, MentionCorpusNoteWordStats>(),
    };
    stats.words.set(lower, wordStats);
  }

  wordStats.totalOccurrences++;
  wordStats.notes.add(notePath);
  incrementCount(wordStats.exactOccurrencesByForm, word);

  let noteStats = wordStats.perNote.get(notePath);
  if (!noteStats) {
    noteStats = {
      totalOccurrences: 0,
      exactOccurrencesByForm: new Map<string, number>(),
    };
    wordStats.perNote.set(notePath, noteStats);
  }
  noteStats.totalOccurrences++;
  incrementCount(noteStats.exactOccurrencesByForm, word);
}

function isExcludedMentionTarget(
  note: VaultNoteSnapshot['notes'][number],
  schema: LoadedSchema
): boolean {
  if (schema.config.mentionExcludePaths.some((pattern) => matchesPathPattern(note.relativePath, pattern))) {
    return true;
  }

  const mentionTargetType = getMentionTargetType(note);
  if (!mentionTargetType || schema.config.mentionExcludeTypes.length === 0) {
    return false;
  }

  const resolvedType = schema.types.get(mentionTargetType);
  if (!resolvedType) return false;

  const excludedTypes = new Set(schema.config.mentionExcludeTypes);
  return excludedTypes.has(resolvedType.name) || resolvedType.ancestors.some((ancestor) => excludedTypes.has(ancestor));
}

function getMentionTargetType(note: VaultNoteSnapshot['notes'][number]): string | undefined {
  return note.resolvedType ?? note.directoryType;
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

    const casingEligible = entities.filter((e) => surfaceAllowsOccurrence(e, hit.surface));
    if (casingEligible.length === 0) continue;

    const positionEligible = casingEligible.filter(
      (e) => !shouldSkipNoCasingSignalOccurrence(e, body, hit.start)
    );
    if (positionEligible.length === 0) continue;

    // A note never flags a mention that points back to itself.
    const others = positionEligible.filter((e) => e.sourcePath !== selfPath);
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

  const isCommonStructuralHeading = (phrase: string, start: number): boolean => {
    if (!COMMON_STRUCTURAL_HEADING_LABELS.has(phrase.toLowerCase())) return false;

    const lineStart = body.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = body.indexOf('\n', start);
    const lineEnd = nextNewline === -1 ? body.length : nextNewline;
    const line = body.slice(lineStart, lineEnd);
    const lineRelativeStart = start - lineStart;
    const candidateStartsLine =
      start === lineStart || /^[ \t]*$/.test(body.slice(lineStart, start));

    const atxHeading = line.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (atxHeading) {
      const headingText = atxHeading[1]!.trim();
      const headingTextStart = line.indexOf(atxHeading[1]!);
      const candidateStartsHeadingText = lineRelativeStart === headingTextStart;
      return headingText === phrase || candidateStartsHeadingText;
    }

    const afterLineStart = nextNewline === -1 ? body.length : nextNewline + 1;
    const followingNewline = body.indexOf('\n', afterLineStart);
    const afterLineEnd = followingNewline === -1 ? body.length : followingNewline;
    const afterLine = body.slice(afterLineStart, afterLineEnd);

    return candidateStartsLine && /^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(afterLine);
  };

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
      if (isCommonStructuralHeading(phrase, start)) continue;
      if (isSingleWordSurface(phrase) && isCommonEnglishWord(phrase)) continue;

      const lower = phrase.toLowerCase();
      // Skip exact known surfaces (handled by the exact tier).
      if (knownSurfaces.has(lower)) continue;

      const suggestions: Array<{ name: string; distance: number }> = [];
      const allowedDistance = allowedFuzzyDistance(phrase.length, fuzzyMaxDistance);
      if (allowedDistance <= 0) continue;
      for (const name of index.allNames) {
        if (name.length < FUZZY_MIN_CANDIDATE_LENGTH) continue;
        const dist = levenshteinDistance(lower, name.toLowerCase());
        if (dist === 0) continue;
        if (dist <= allowedDistance) {
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

function isSingleWordSurface(surface: string): boolean {
  return !/\s/.test(surface.trim());
}

function surfaceAllowsOccurrence(surface: EntitySurface, occurrence: string): boolean {
  if (surface.excludedFromMentionIndex) return false;
  if (surface.kind === 'alias') return true;
  if (!isSingleWordSurface(surface.surface)) return true;
  return occurrence === surface.surface;
}

function allowedFuzzyDistance(candidateLength: number, configuredCap: number): number {
  return Math.min(configuredCap, Math.floor(candidateLength / 4));
}

function isSkippedCommonNameSurface(
  surface: EntitySurface,
  corpusOptions?: Required<Omit<MentionCorpusCalibrationOptions, 'stats'>> & {
    stats?: MentionCorpusStats;
  }
): boolean {
  if (surface.kind !== 'name' || !isSingleWordSurface(surface.surface)) return false;
  if (isCommonEnglishWord(surface.surface)) return true;
  return isCorpusDampedNameSurface(surface, corpusOptions);
}

function isCorpusDampedNameSurface(
  surface: EntitySurface,
  corpusOptions?: Required<Omit<MentionCorpusCalibrationOptions, 'stats'>> & {
    stats?: MentionCorpusStats;
  }
): boolean {
  if (!corpusOptions?.enabled || !corpusOptions.stats) return false;
  if (!isCorpusWordSurface(surface.surface)) return false;

  const wordStats = corpusOptions.stats.words.get(surface.surface.toLowerCase());
  if (!wordStats) return false;

  const selfStats = wordStats.perNote.get(surface.sourcePath);
  const distinctNotes =
    wordStats.notes.size - (selfStats && wordStats.notes.has(surface.sourcePath) ? 1 : 0);
  if (distinctNotes < corpusOptions.minNotes) return false;

  const totalOccurrences =
    wordStats.totalOccurrences - (selfStats?.totalOccurrences ?? 0);
  if (totalOccurrences <= 0) return false;

  const canonicalOccurrences = countCanonicalCaseOccurrences(
    surface.surface,
    wordStats,
    selfStats
  );
  const nonCanonicalShare =
    (totalOccurrences - canonicalOccurrences) / totalOccurrences;

  return nonCanonicalShare > corpusOptions.nonCanonicalRatio;
}

function countCanonicalCaseOccurrences(
  surface: string,
  wordStats: MentionCorpusWordStats,
  selfStats: MentionCorpusNoteWordStats | undefined
): number {
  // Lowercase canonical names carry no proper-noun capitalization signal, so
  // lowercase prose should count as common usage rather than protective evidence.
  if (!startsWithUppercase(surface)) return 0;
  return (
    (wordStats.exactOccurrencesByForm.get(surface) ?? 0) -
    (selfStats?.exactOccurrencesByForm.get(surface) ?? 0)
  );
}

function startsWithUppercase(value: string): boolean {
  const first = Array.from(value.trim())[0];
  return Boolean(first && first.toLocaleUpperCase() === first && first.toLocaleLowerCase() !== first);
}

function isCorpusWordSurface(surface: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}_'-]*$/u.test(surface);
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function shouldSkipNoCasingSignalOccurrence(
  surface: EntitySurface,
  body: string,
  start: number
): boolean {
  return shouldSkipNoCasingSignalNameOccurrence(
    surface.surface,
    surface.kind,
    body,
    start
  );
}

/**
 * Shared exact-tier position guard (#784). Capitalized single-word name
 * surfaces are skipped where sentence/list/heading position erases the casing
 * signal. Aliases, lowercase names, and multi-word names are unaffected.
 */
export function shouldSkipNoCasingSignalNameOccurrence(
  surface: string,
  kind: SurfaceKind | undefined,
  body: string,
  start: number
): boolean {
  return (
    kind === 'name' &&
    isSingleWordSurface(surface) &&
    startsWithUppercase(surface) &&
    isNoCasingSignalPosition(body, start)
  );
}

function isNoCasingSignalPosition(body: string, start: number): boolean {
  if (start <= 0) return true;

  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const beforeOnLine = body.slice(lineStart, start);
  if (/^[ \t]*$/.test(beforeOnLine)) return true;
  if (isAfterMarkdownLineMarker(beforeOnLine)) return true;

  const before = body.slice(0, start);
  return /[.!?][\])}"'’”»]*[ \t\r\n]*$/.test(before);
}

function isAfterMarkdownLineMarker(beforeOnLine: string): boolean {
  const blockquotePrefix = String.raw`(?:>[ \t]*)*`;
  const listMarker = String.raw`(?:[-*+]|[0-9]{1,9}[.)])[ \t]+`;
  const headingMarker = String.raw`#{1,6}[ \t]+`;
  const markerRe = new RegExp(
    String.raw`^[ \t]{0,3}${blockquotePrefix}(?:${listMarker}|${headingMarker})?$`
  );
  return markerRe.test(beforeOnLine);
}

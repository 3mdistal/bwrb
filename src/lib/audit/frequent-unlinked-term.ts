/**
 * `frequent-unlinked-term` audit detection — the open-world nudge.
 *
 * This is the third leg of the ingest safety net (see
 * plans/features/ingest-safety-net.md §4). It attacks a failure mode that the
 * closed-world `unlinked-mention` (#600) cannot: *the agent forgets to link
 * because it does not know the entity exists.* There is no note to match
 * against yet, so there is nothing for `unlinked-mention` to flag.
 *
 * Instead this detection looks for **proper-noun-ish phrases mentioned a lot
 * across the vault that have no note yet** and surfaces them as a gentle nudge:
 * "you might want notes for these N things." It is the inverse of
 * `unlinked-mention`: that one keeps *known* entities wired up; this one
 * suggests *new* entities worth creating, after which `unlinked-mention` keeps
 * them linked forever after.
 *
 * KEY CONTRACT — **advisory only.** This detection NEVER auto-acts and is NEVER
 * auto-fixable (`autoFixable: false`, no fix-policy entry, no `--fix` path).
 * Because it never takes action, it is *allowed* to be a bit noisy — that noise
 * is harmless. It is gated behind thresholds purely to keep the report
 * readable, not for correctness.
 *
 * ## The heuristic (and its honest limits)
 *
 * Discovering an unknown "thing" in prose without an LLM is inherently
 * heuristic. We approximate proper nouns with **runs of Capitalized words**
 * (1–3 words: "Rust", "Steve Yegge", "New York Times"), counted only in prose
 * (code/links/URLs/existing wikilinks are masked out by reusing #600's
 * {@link maskNonProse}). Known limits, documented for honesty:
 *  - **Sentence-start false positives.** Any word can be capitalized because it
 *    starts a sentence ("Today I…"). We drop a single-word candidate that sits
 *    at the very start of a line/sentence, and filter a stopword list of common
 *    capitalized words (days, months, pronouns, sentence openers).
 *  - **No semantic understanding.** "The Plan" repeated a lot will surface even
 *    though it is not an entity. That is acceptable: the user simply ignores it.
 *  - **Multi-word phrases are favored** over single words: a 2–3 word
 *    Capitalized phrase is much more likely a real proper noun, so single-word
 *    candidates are held to a stricter bar (longer minimum length, full
 *    stopword filtering, no sentence-start position).
 *
 * ## Exclusions (the closed-world handoff)
 *  - A candidate whose lowercased text equals an existing note name OR a
 *    registered alias is dropped — that is `unlinked-mention`'s job, not ours.
 *    We reuse #600's {@link EntityMentionIndex.bySurface} as the known-surface
 *    set so the two detections never overlap.
 *  - Terms that are already wikilinked everywhere never reach us: masking blanks
 *    `[[...]]`, so only *prose* occurrences are ever counted. A term that is
 *    always linked has zero prose mentions and cannot meet the threshold.
 *
 * ## Aggregation
 * This detection is **vault-global**: a term must clear a mention/notes
 * threshold *across the vault*, which cannot be decided per file. The audit run
 * therefore drives it as a post-pass over all scanned bodies (see
 * detection.ts), aggregating candidate counts and emitting one issue per
 * surfaced term.
 */

import type { EntityMentionIndex } from './unlinked-mention.js';
import { maskNonProse } from './unlinked-mention.js';
import type { AuditIssue } from './types.js';

// ============================================================================
// Thresholds & tunables
// ============================================================================

/** Default thresholds for surfacing a term. Tunable via {@link FrequentTermOptions}. */
export const FREQUENT_TERM_DEFAULTS = {
  /** A term must appear at least this many times in total across the vault. */
  minMentions: 4,
  /** A term must appear in at least this many distinct notes. */
  minNotes: 2,
  /** Minimum length for a single-word candidate (multi-word phrases bypass). */
  minSingleWordLength: 4,
  /** Maximum number of words in a candidate phrase. */
  maxPhraseWords: 3,
  /** Cap on how many surfaced terms to emit (highest-count first). */
  maxResults: 25,
} as const;

/** Per-run options to tune the frequent-unlinked-term heuristic. */
export interface FrequentTermOptions {
  minMentions?: number;
  minNotes?: number;
  minSingleWordLength?: number;
  maxPhraseWords?: number;
  maxResults?: number;
}

// ============================================================================
// Stopwords (false-positive management)
// ============================================================================

/**
 * Common Capitalized words that are almost never entities on their own. Kept
 * deliberately small and lowercased for case-insensitive membership checks.
 * Used to reject *single-word* candidates and to strip leading filler from
 * multi-word phrases. Documented as a known, intentionally-incomplete list —
 * iterate over time (the cost of a miss is only a little report noise).
 */
const FREQUENT_TERM_STOPWORDS: ReadonlySet<string> = new Set(
  [
    // Days
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    // Months
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    // Common sentence openers / pronouns / filler that are frequently capitalized
    'the', 'a', 'an', 'and', 'but', 'or', 'so', 'then', 'this', 'that', 'these',
    'those', 'there', 'here', 'it', 'its', 'we', 'i', 'you', 'he', 'she', 'they',
    'my', 'our', 'your', 'his', 'her', 'their', 'me', 'us', 'them',
    'today', 'tomorrow', 'yesterday', 'now', 'later', 'soon',
    'when', 'where', 'what', 'who', 'why', 'how', 'which',
    'if', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'up',
    'with', 'about', 'after', 'before', 'over', 'under',
    'yes', 'no', 'not', 'maybe', 'okay', 'ok',
    'one', 'two', 'three', 'first', 'second', 'next', 'last',
    'do', 'did', 'done', 'got', 'get', 'let', 'also', 'just', 'still', 'really',
  ].map((w) => w.toLowerCase())
);

// ============================================================================
// Candidate extraction
// ============================================================================

/** A located candidate occurrence within a single note body. */
interface CandidateHit {
  /** Normalized surface text (original casing, single-spaced). */
  text: string;
  /** True when the phrase began at the start of a line/sentence. */
  atSentenceStart: boolean;
}

/**
 * Extract Capitalized-phrase candidates from a single (already masked) body.
 *
 * A candidate is a run of 1..maxPhraseWords Capitalized words. We also track
 * whether the run started at a sentence boundary (line start, or right after
 * sentence-ending punctuation) so single-word sentence openers can be rejected.
 */
export function extractCandidates(
  maskedBody: string,
  maxPhraseWords: number
): CandidateHit[] {
  const hits: CandidateHit[] = [];
  // A Capitalized word: leading uppercase letter, then letters/marks. We keep
  // internal apostrophes/hyphens (O'Brien, Jean-Luc) but trim trailing ones.
  const wordRe = /[A-Z][A-Za-z'À-ɏ-]*/g;

  // Walk word-by-word, grouping consecutive Capitalized words that are
  // separated only by a single space into a phrase.
  let match: RegExpExecArray | null;
  const words: Array<{ text: string; start: number; end: number }> = [];
  while ((match = wordRe.exec(maskedBody)) !== null) {
    words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }

  let i = 0;
  while (i < words.length) {
    const run: Array<{ text: string; start: number; end: number }> = [words[i]!];
    let j = i + 1;
    // Extend the run while the next Capitalized word is separated only by
    // spaces/tabs (not a newline or other punctuation) from the previous one.
    while (j < words.length && run.length < maxPhraseWords) {
      const prev = run[run.length - 1]!;
      const between = maskedBody.slice(prev.end, words[j]!.start);
      if (/^[ \t]+$/.test(between)) {
        run.push(words[j]!);
        j++;
      } else {
        break;
      }
    }

    // Emit the full run as one candidate. (We intentionally do not emit every
    // sub-phrase: the maximal Capitalized run is the best proper-noun guess.)
    const start = run[0]!.start;
    const text = stripTrailingPunct(run.map((w) => w.text).join(' '));
    if (text.length > 0) {
      hits.push({ text, atSentenceStart: isSentenceStart(maskedBody, start) });
    }
    i = j;
  }

  return hits;
}

/** Remove trailing apostrophes/hyphens left after tokenization. */
function stripTrailingPunct(s: string): string {
  return s.replace(/['-]+$/u, '');
}

/**
 * Whether the offset begins a sentence: at file start, at a line start, or
 * immediately after sentence-ending punctuation (`.`, `!`, `?`) and whitespace.
 */
function isSentenceStart(text: string, offset: number): boolean {
  let k = offset - 1;
  // Skip immediate whitespace before the candidate.
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
  if (k < 0) return true;
  const ch = text[k]!;
  return ch === '\n' || ch === '.' || ch === '!' || ch === '?';
}

/**
 * Strip leading stopword words from a candidate phrase ("Also Kubernetes" →
 * "Kubernetes"; "The Rust Foundation" → "Rust Foundation"). Returns the trimmed
 * phrase and whether any leading word was removed. A phrase that is entirely
 * stopwords collapses to the empty string (and is then ignored by the caller).
 */
function stripLeadingStopwords(phrase: string): {
  normalized: string;
  strippedLeading: boolean;
} {
  const words = phrase.split(' ');
  let i = 0;
  while (i < words.length && FREQUENT_TERM_STOPWORDS.has(words[i]!.toLowerCase())) {
    i++;
  }
  return { normalized: words.slice(i).join(' '), strippedLeading: i > 0 };
}

// ============================================================================
// Aggregation
// ============================================================================

/** Running tally for one candidate term across the vault. */
interface TermTally {
  /** Display form: the most common original casing seen. */
  display: string;
  /** Total prose mentions across all notes. */
  mentions: number;
  /** Distinct note paths the term appears in. */
  notes: Set<string>;
  /** Number of words in the phrase. */
  wordCount: number;
  /** Whether every observed occurrence was at a sentence start. */
  everyOccurrenceSentenceStart: boolean;
}

/**
 * Stateful accumulator so the audit run can feed bodies one at a time and emit
 * aggregated issues at the end. Build once per run; call {@link addBody} for
 * each scanned note, then {@link finish} for the surfaced issues.
 */
export class FrequentTermAccumulator {
  private readonly tallies = new Map<string, TermTally>();
  private readonly opts: Required<FrequentTermOptions>;

  constructor(
    private readonly index: EntityMentionIndex,
    options?: FrequentTermOptions
  ) {
    this.opts = {
      minMentions: options?.minMentions ?? FREQUENT_TERM_DEFAULTS.minMentions,
      minNotes: options?.minNotes ?? FREQUENT_TERM_DEFAULTS.minNotes,
      minSingleWordLength:
        options?.minSingleWordLength ?? FREQUENT_TERM_DEFAULTS.minSingleWordLength,
      maxPhraseWords: options?.maxPhraseWords ?? FREQUENT_TERM_DEFAULTS.maxPhraseWords,
      maxResults: options?.maxResults ?? FREQUENT_TERM_DEFAULTS.maxResults,
    };
  }

  /** Feed one note body (raw markdown). Masks non-prose before counting. */
  addBody(body: string, notePath: string): void {
    if (!body || body.trim().length === 0) return;
    const masked = maskNonProse(body);
    const candidates = extractCandidates(masked, this.opts.maxPhraseWords);

    for (const cand of candidates) {
      const collapsed = cand.text.replace(/\s+/g, ' ').trim();
      // Strip leading filler stopwords ("Also Kubernetes" → "Kubernetes",
      // "The Rust Foundation" → "Rust Foundation") so the real proper noun is
      // what gets counted. Once we strip a leading word the candidate is no
      // longer at a sentence start in a meaningful sense.
      const { normalized, strippedLeading } = stripLeadingStopwords(collapsed);
      if (!normalized) continue;
      const atSentenceStart = cand.atSentenceStart && !strippedLeading;
      if (!this.isEligible(normalized, atSentenceStart)) continue;

      const key = normalized.toLowerCase();
      const existing = this.tallies.get(key);
      if (existing) {
        existing.mentions += 1;
        existing.notes.add(notePath);
        if (!atSentenceStart) existing.everyOccurrenceSentenceStart = false;
      } else {
        this.tallies.set(key, {
          display: normalized,
          mentions: 1,
          notes: new Set([notePath]),
          wordCount: normalized.split(' ').length,
          everyOccurrenceSentenceStart: atSentenceStart,
        });
      }
    }
  }

  /**
   * Whether a normalized candidate is eligible to be *counted* at all.
   *
   * Drops: known note names/aliases (closed-world handoff), single-word
   * stopwords, and single-word sentence-start openers / too-short words. Multi-
   * word phrases are favored and held to a lighter bar.
   */
  private isEligible(normalized: string, atSentenceStart: boolean): boolean {
    const lower = normalized.toLowerCase();

    // Exclude anything that already has a note or registered alias (#600 owns it).
    if (this.index.bySurface.has(lower)) return false;

    const words = normalized.split(' ');
    if (words.length === 1) {
      const word = words[0]!;
      // Single-word candidates: stricter to suppress sentence-start noise.
      if (word.length < this.opts.minSingleWordLength) return false;
      if (FREQUENT_TERM_STOPWORDS.has(lower)) return false;
      // A lone capitalized word at a sentence start is most likely just an
      // opener, not a proper noun — counted only via non-start occurrences.
      if (atSentenceStart) return false;
      return true;
    }

    // Multi-word phrase (leading stopwords already stripped by the caller).
    // Drop a phrase that is nothing but stopwords; otherwise keep it.
    if (words.every((w) => FREQUENT_TERM_STOPWORDS.has(w.toLowerCase()))) return false;
    return true;
  }

  /** Emit aggregated, advisory issues for every term clearing the thresholds. */
  finish(): AuditIssue[] {
    const surfaced: TermTally[] = [];
    for (const tally of this.tallies.values()) {
      if (tally.mentions < this.opts.minMentions) continue;
      if (tally.notes.size < this.opts.minNotes) continue;
      // A single-word term whose every occurrence sat at a sentence start is too
      // risky to surface; require at least one mid-sentence occurrence. (For
      // multi-word phrases sentence position is not tracked as a gate.)
      if (tally.wordCount === 1 && tally.everyOccurrenceSentenceStart) continue;
      surfaced.push(tally);
    }

    // Highest count first, then most notes, then alphabetical for stability.
    surfaced.sort(
      (a, b) =>
        b.mentions - a.mentions ||
        b.notes.size - a.notes.size ||
        a.display.localeCompare(b.display, 'en')
    );

    return surfaced.slice(0, this.opts.maxResults).map((t) => this.toIssue(t));
  }

  private toIssue(tally: TermTally): AuditIssue {
    const noteList = Array.from(tally.notes).sort((a, b) => a.localeCompare(b, 'en'));
    return {
      severity: 'warning',
      code: 'frequent-unlinked-term',
      message: `'${tally.display}' is mentioned ${tally.mentions} times across ${tally.notes.size} notes but has no note yet`,
      value: tally.display,
      autoFixable: false,
      suggestion: `Consider creating a note for '${tally.display}' (advisory heuristic — ignore if not an entity)`,
      similarFiles: noteList,
      meta: {
        term: tally.display,
        mentions: tally.mentions,
        noteCount: tally.notes.size,
        notes: noteList,
        wordCount: tally.wordCount,
      },
    };
  }
}

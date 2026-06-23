/**
 * Body-LINK validation (#652) — the link-integrity half of #510.
 *
 * #510 shipped `missing-body-section` (heading structure). This module covers the
 * other half: validating actual LINKS written in a note's markdown body.
 *
 * Three checks, all flag-only (we never auto-edit body prose links here — see the
 * trust-model note on each):
 *
 *  - `broken-body-wikilink`: a well-formed `[[Target]]` (or `[[Target|alias]]`,
 *    `[[Target#heading]]`) in the body whose Target resolves to NO note via the
 *    alias-aware, case-insensitive note-target index (#266/#636). Flag-only: we
 *    cannot know the intended target, so we never auto-link. A fuzzy "did you
 *    mean?" hint is offered when a near-named note exists.
 *  - `malformed-body-wikilink`: bracket syntax that looks like a wikilink but is
 *    broken — `[[]]`, `[[ ]]` (empty/whitespace target), or an unclosed `[[`.
 *    Flag-only: malformed body syntax is ambiguous to repair safely.
 *  - `broken-body-file-link`: a markdown file/image link `[text](path)` /
 *    `![alt](path)` whose RELATIVE target does not exist on disk (resolved
 *    relative to the note's own directory). External URLs (`http(s)://`,
 *    `mailto:`, protocol-relative `//`), in-page anchors (`#section`), and
 *    Obsidian-style absolute vault paths are intentionally NOT checked here.
 *    Flag-only.
 *
 * Overlap avoidance (deliberate, see #652):
 *  - `unlinked-mention` (#600) flags KNOWN entity names appearing as PLAIN TEXT
 *    that are NOT wikilinked. This module is the inverse: it flags actual
 *    `[[...]]` links that point NOWHERE. The two never fire on the same span —
 *    unlinked-mention masks out existing wikilinks before scanning; this module
 *    only looks at existing wikilinks.
 *  - `frequent-unlinked-term` (#601) is an open-world plain-text heuristic — also
 *    disjoint.
 *  - Relation-field `stale-reference`/`malformed-wikilink`/`ambiguous-link-target`
 *    validate FRONTMATTER values only (body stale-reference was explicitly
 *    deferred). This module validates the BODY only. No overlap.
 *
 * Code handling: links written inside fenced code blocks or inline code are NOT
 * flagged. We mask code spans (via `maskCodeSpans`) before scanning, preserving
 * offsets/line numbers, then read the link text back from the ORIGINAL body at
 * the matched offsets so the reported value is the real link.
 */

import { existsSync } from 'fs';
import { basename, isAbsolute, resolve } from 'path';
import type { NoteTargetIndex } from '../discovery.js';
import { levenshteinDistance } from '../levenshtein.js';
import type { AuditIssue } from './types.js';
import { maskCodeSpans } from './unlinked-mention.js';

// ============================================================================
// Constants
// ============================================================================

/** Max Levenshtein distance for a "did you mean?" hint on a broken wikilink. */
const FUZZY_MAX_DISTANCE = 2;
/** A broken target must be at least this long to bother fuzzy-suggesting. */
const FUZZY_MIN_LENGTH = 4;
/** Cap on how many "did you mean?" suggestions to list. */
const FUZZY_MAX_SUGGESTIONS = 3;

// ============================================================================
// Helpers
// ============================================================================

/** Compute 1-based line number for a character offset. */
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Whether a markdown-link destination is an external/non-file target we must not
 * check on disk: a URL with a scheme (`https:`, `mailto:`, `tel:`, …), a
 * protocol-relative `//host`, or a pure in-page anchor (`#section`).
 */
function isNonFileTarget(dest: string): boolean {
  if (dest.startsWith('#')) return true;
  if (dest.startsWith('//')) return true;
  // scheme:rest — RFC3986-ish scheme (letter then letters/digits/+-.)
  return /^[a-z][a-z0-9+.-]*:/i.test(dest);
}

/**
 * Resolve the directory of a note from its vault-relative path, returning the
 * directory portion (vault-relative). E.g. "Bugs/Crash.md" -> "Bugs".
 */
function noteDir(selfRelativePath: string): string {
  const idx = selfRelativePath.lastIndexOf('/');
  return idx === -1 ? '' : selfRelativePath.slice(0, idx);
}

/**
 * Offer up to {@link FUZZY_MAX_SUGGESTIONS} note names that are a near match to a
 * broken wikilink target, as a flag-only "did you mean?" hint.
 */
function fuzzyNoteSuggestions(target: string, index: NoteTargetIndex): string[] {
  if (target.length < FUZZY_MIN_LENGTH) return [];
  const lower = target.toLowerCase();
  const scored: Array<{ name: string; distance: number }> = [];
  for (const [key, paths] of index.targetToPaths) {
    if (key.length < FUZZY_MIN_LENGTH) continue;
    const dist = levenshteinDistance(lower, key);
    if (dist === 0) continue;
    if (dist <= FUZZY_MAX_DISTANCE) {
      // `targetToPaths` keys are lowercased; surface the canonical-case basename
      // (reconstructed from the resolved note path) so the "did you mean?" hint
      // shows `RealNote` rather than the index key `realnote`. Fall back to the
      // key if no path is recorded (shouldn't happen for real notes).
      const firstPath = paths[0];
      const name = firstPath ? basename(firstPath, '.md') : key;
      scored.push({ name, distance: dist });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en'));
  return scored.slice(0, FUZZY_MAX_SUGGESTIONS).map((s) => s.name);
}

// ============================================================================
// Wikilink detection (broken + malformed)
// ============================================================================

/**
 * Match well-formed body wikilinks: `[[Target]]`, `[[Target|display]]`,
 * `[[Target#heading]]`, `[[Target#heading|display]]`. The target is everything
 * up to the first `#` (heading) or `|` (display alias). An embed `![[...]]` is
 * matched too (the leading `!` is outside the capture and ignored).
 */
const WIKILINK_RE = /\[\[([^\]\n]*?)\]\]/g;

/**
 * Match an opening `[[` that is never closed on the same construct — used only to
 * catch unclosed malformed wikilinks. Applied after well-formed ones are masked.
 */
const UNCLOSED_WIKILINK_RE = /\[\[(?![^\]\n]*\]\])/g;

/**
 * Extract the resolvable target (note name/path) from a wikilink inner string,
 * stripping a `#heading` and/or `|display` suffix. Returns the trimmed target.
 */
function wikilinkTarget(inner: string): string {
  let t = inner;
  const pipe = t.indexOf('|');
  if (pipe !== -1) t = t.slice(0, pipe);
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  return t.trim();
}

/**
 * Detect broken and malformed wikilinks in a note body.
 *
 * @param body  Markdown body (frontmatter already stripped).
 * @param index Alias-aware, case-insensitive note-target index.
 */
export function detectBodyWikilinks(
  body: string,
  index: NoteTargetIndex | undefined
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  // Mask code (but NOT links) so links inside code fences / inline code are
  // ignored, while offsets into the original body stay accurate.
  const masked = maskCodeSpans(body);

  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(masked)) !== null) {
    const inner = m[1] ?? '';
    const start = m.index;
    const line = lineNumberAt(body, start);
    const target = wikilinkTarget(inner);

    // Malformed: empty/whitespace-only target (`[[]]`, `[[ ]]`, `[[|x]]`,
    // `[[#h]]`).
    if (target.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'malformed-body-wikilink',
        message: `Malformed wikilink on line ${line}: '${m[0]}' has an empty target`,
        value: m[0],
        autoFixable: false,
        inBody: true,
        lineNumber: line,
        suggestion: 'Empty wikilink target — fill in or remove the link',
        meta: { offset: start, reason: 'empty-target' },
      });
      continue;
    }

    // Broken: resolves to no note via the alias-aware index.
    const candidates = index?.targetToPaths.get(target.toLowerCase()) ?? [];
    if (candidates.length === 0) {
      const suggestions = index ? fuzzyNoteSuggestions(target, index) : [];
      issues.push({
        severity: 'warning',
        code: 'broken-body-wikilink',
        message: `Broken wikilink on line ${line}: '[[${target}]]' resolves to no note`,
        value: m[0],
        autoFixable: false,
        inBody: true,
        lineNumber: line,
        targetName: target,
        ...(suggestions.length > 0 ? { similarFiles: suggestions } : {}),
        suggestion:
          suggestions.length > 0
            ? `Did you mean ${suggestions.map((s) => `[[${s}]]`).join(' or ')}? (not auto-linked)`
            : 'Create the note or fix the link target (not auto-linked)',
        meta: { offset: start, target },
      });
    }
    // Resolving to >= 1 note is fine here — a single match is valid, and an
    // ambiguous (multi-match) body wikilink is still a working Obsidian link
    // (Obsidian resolves by proximity), so we do not flag it. Ambiguity in
    // RELATION FIELDS is a separate, frontmatter-only concern.
  }

  // Unclosed `[[` with no closing `]]` on the same line/construct. Mask the
  // well-formed wikilinks first so we don't re-flag their opening brackets.
  const withoutWellFormed = masked.replace(WIKILINK_RE, (mm) => mm.replace(/[^\n]/g, ' '));
  UNCLOSED_WIKILINK_RE.lastIndex = 0;
  while ((m = UNCLOSED_WIKILINK_RE.exec(withoutWellFormed)) !== null) {
    const start = m.index;
    const line = lineNumberAt(body, start);
    issues.push({
      severity: 'warning',
      code: 'malformed-body-wikilink',
      message: `Malformed wikilink on line ${line}: unclosed '[[' (missing ']]')`,
      value: '[[',
      autoFixable: false,
      inBody: true,
      lineNumber: line,
      suggestion: 'Unclosed wikilink — add the closing ]] or remove the [[',
      meta: { offset: start, reason: 'unclosed' },
    });
  }

  return issues;
}

// ============================================================================
// Markdown file/image link detection (broken relative path)
// ============================================================================

/**
 * Match markdown links and images: `[text](dest)` and `![alt](dest)`. The
 * destination capture stops at the first whitespace so an optional `"title"`
 * after the URL is excluded, and at the closing paren.
 */
const MD_LINK_RE = /!?\[[^\]\n]*\]\(\s*([^)\s]+)[^)]*\)/g;

/**
 * Detect markdown file/image links in the body whose RELATIVE target does not
 * exist on disk. External URLs and in-page anchors are skipped.
 *
 * @param body     Markdown body (frontmatter already stripped).
 * @param selfPath Vault-relative path of the note (for resolving relative dests).
 * @param vaultDir Absolute vault root, for on-disk existence checks.
 */
export function detectBodyFileLinks(
  body: string,
  selfPath: string,
  vaultDir: string
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const masked = maskCodeSpans(body);
  const dir = noteDir(selfPath);

  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(masked)) !== null) {
    const rawDest = m[1] ?? '';
    const start = m.index;
    const line = lineNumberAt(body, start);

    // Decode percent-encoding (e.g. spaces as %20) for the existence check;
    // leave the reported value as the author wrote it.
    let dest = rawDest;
    try {
      dest = decodeURIComponent(rawDest);
    } catch {
      // Malformed escape — fall back to the raw destination.
    }

    // Strip a trailing in-page anchor (`file.md#section`).
    const hashIdx = dest.indexOf('#');
    const filePart = hashIdx === -1 ? dest : dest.slice(0, hashIdx);
    if (filePart.length === 0) continue;

    // Skip external/non-file targets.
    if (isNonFileTarget(dest)) continue;

    // Resolve the on-disk path: absolute dests are treated as vault-absolute
    // (Obsidian style: leading "/" is the vault root); otherwise relative to the
    // note's own directory.
    const absPath = isAbsolute(filePart)
      ? resolve(vaultDir, `.${filePart}`)
      : resolve(vaultDir, dir, filePart);

    if (existsSync(absPath)) continue;

    const isImage = m[0].startsWith('!');
    issues.push({
      severity: 'warning',
      code: 'broken-body-file-link',
      message: `Broken ${isImage ? 'image' : 'file'} link on line ${line}: '${rawDest}' does not exist on disk`,
      value: rawDest,
      autoFixable: false,
      inBody: true,
      lineNumber: line,
      targetName: rawDest,
      suggestion: 'Fix the path or restore the missing file (not auto-fixed)',
      meta: { offset: start, dest: rawDest, isImage },
    });
  }

  return issues;
}

/**
 * Convenience: run all body-link detections for a single note body.
 */
export function detectBodyLinks(
  body: string,
  selfPath: string,
  vaultDir: string,
  index: NoteTargetIndex | undefined
): AuditIssue[] {
  return [
    ...detectBodyWikilinks(body, index),
    ...detectBodyFileLinks(body, selfPath, vaultDir),
  ];
}

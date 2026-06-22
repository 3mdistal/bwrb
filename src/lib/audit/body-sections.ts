/**
 * Body-section validation (#510).
 *
 * The schema's `body_sections` declare the markdown headings a note of a given
 * type is expected to carry (e.g. a `bug` type scaffolds "## Steps to Reproduce").
 * `bwrb new`/`bwrb edit` write those headings, but nothing stops a user from
 * deleting or renaming one later. This detection re-checks, at audit time, that
 * every declared section heading is still present in the body at its declared
 * level.
 *
 * Scope (deliberately narrow, per #510 and the issue author's note):
 *   - We validate the PRESENCE of declared heading sections only. Heading text +
 *     level must match what the schema declares. Nested `children` are recursed.
 *   - We do NOT validate body CONTENT (whether bullets/checkboxes are filled in,
 *     paragraph counts, etc.) — that would be noisy and is not what the issue
 *     asks for.
 *   - We do NOT validate body wikilinks here. That half of #510 overlaps with the
 *     existing `unlinked-mention` (#600) / `frequent-unlinked-term` (#601) and
 *     relation-field stale-reference detections, and the issue author explicitly
 *     asked to coordinate the body-link half there rather than duplicate it.
 *
 * Auto-fixable: yes. A missing declared heading is appended using the SAME
 * `generateBodySections` scaffold that `new`/`edit` use, so the fix is
 * deterministic, additive (never deletes or rewrites existing prose), and
 * idempotent (re-running finds the now-present heading and does nothing).
 */

import type { BodySection } from '../../types/schema.js';
import type { AuditIssue } from './types.js';
import { maskNonProse } from './unlinked-mention.js';

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a heading with the given level and title is present in the (already
 * non-prose-masked) body. Matches an ATX heading line: the exact number of `#`
 * for the declared level, a single space, then the exact title (trailing
 * whitespace and trailing `#` closing sequence tolerated). Matching is
 * case-sensitive on the title to mirror how the scaffold writes it.
 */
function headingPresent(maskedBody: string, level: number, title: string): boolean {
  const prefix = '#'.repeat(level);
  // ^## Title  with optional trailing spaces and optional closing ### run.
  const pattern = new RegExp(
    `^[ \\t]*${prefix} ${escapeRegExp(title)}[ \\t]*#*[ \\t]*$`,
    'm'
  );
  return pattern.test(maskedBody);
}

/**
 * Find the 1-based line number of the first heading at any level whose title
 * matches, regardless of level. Used to point a level-mismatch warning at the
 * offending line. Returns undefined if not found.
 */
function findHeadingLine(maskedBody: string, title: string): number | undefined {
  const pattern = new RegExp(`^[ \\t]*#{1,6} ${escapeRegExp(title)}[ \\t]*#*[ \\t]*$`);
  const lines = maskedBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i + 1;
  }
  return undefined;
}

/**
 * Recursively collect every declared section as a flat list of (section, level)
 * entries. A child's level defaults to one deeper than its declared value via
 * the schema's own `level` field (children carry their own `level`), so we read
 * each section's `level` directly (default 2) rather than inferring depth.
 */
function flattenSections(
  sections: BodySection[],
  out: Array<{ title: string; level: number }> = []
): Array<{ title: string; level: number }> {
  for (const section of sections) {
    out.push({ title: section.title, level: section.level ?? 2 });
    if (section.children && section.children.length > 0) {
      flattenSections(section.children, out);
    }
  }
  return out;
}

/**
 * Detect declared body sections that are missing from a note's body.
 *
 * @param body         The markdown body (frontmatter already stripped).
 * @param bodySections The resolved type's declared body sections.
 * @returns One `missing-body-section` issue per declared heading that is absent
 *          at its declared level. When a heading with the same title exists but
 *          at a different level, the issue notes that (still flagged, and the
 *          fix appends the correctly-leveled heading rather than rewriting the
 *          user's heading).
 */
export function detectMissingBodySections(
  body: string,
  bodySections: BodySection[]
): AuditIssue[] {
  if (!bodySections || bodySections.length === 0) return [];

  const issues: AuditIssue[] = [];
  // Mask code/links so a `## Heading` written inside a fenced code block or a
  // link does not count as satisfying the requirement (and so we never point a
  // line number at masked content).
  const masked = maskNonProse(body);

  for (const { title, level } of flattenSections(bodySections)) {
    if (headingPresent(masked, level, title)) continue;

    const wrongLevelLine = findHeadingLine(masked, title);
    const meta: Record<string, unknown> = { title, level };
    let message = `Missing required body section: "${'#'.repeat(level)} ${title}"`;
    if (wrongLevelLine !== undefined) {
      message = `Body section "${title}" is present but not at the expected heading level (expected ${'#'.repeat(level)})`;
      meta['wrongLevel'] = true;
    }

    issues.push({
      severity: 'warning',
      code: 'missing-body-section',
      message,
      // Conservative: appending the canonical heading scaffold is safe and
      // deterministic, so this is auto-fixable.
      autoFixable: true,
      inBody: true,
      ...(wrongLevelLine !== undefined ? { lineNumber: wrongLevelLine } : {}),
      meta,
    });
  }

  return issues;
}

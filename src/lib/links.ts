import {
  extractWikilinkTarget,
  extractMarkdownLinkTarget,
  isWikilink,
  isQuotedWikilink,
  isMarkdownLink,
} from './audit/types.js';

/**
 * Extract a relation target from a link value.
 * Supports wikilinks and markdown links (quoted or unquoted).
 */
export function extractLinkTarget(value: string): string | null {
  if (!value) return null;
  if (isWikilink(value) || isQuotedWikilink(value)) {
    const wikilinkTarget = extractWikilinkTarget(value);
    if (wikilinkTarget) return wikilinkTarget;
  }

  if (isMarkdownLink(value)) {
    const markdownTarget = extractMarkdownLinkTarget(value);
    if (markdownTarget) return markdownTarget;
  }

  return null;
}

/**
 * Extract all link targets from a string or list of strings.
 */
export function extractLinkTargets(value: unknown): string[] {
  const references: string[] = [];
  const markdownPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  const wikilinkPattern = /\[\[([^\]]+)\]\]/g;

  const maybeAddTarget = (candidate: string) => {
    const target = extractLinkTarget(candidate);
    if (target) {
      references.push(target);
    }
  };

  const markdownTargets = (input: string) => {
    let match: RegExpExecArray | null;
    while ((match = markdownPattern.exec(input)) !== null) {
      const linkTarget = match[1] ?? '';
      if (linkTarget.endsWith('.md')) {
        references.push(linkTarget.replace(/\.md$/, ''));
      } else if (linkTarget) {
        maybeAddTarget(`[text](${linkTarget})`);
      }
    }
  };

  const collectFromString = (input: string) => {
    let found = false;
    let match: RegExpExecArray | null;

    // Reset regex state for repeated calls
    wikilinkPattern.lastIndex = 0;
    markdownPattern.lastIndex = 0;

    while ((match = wikilinkPattern.exec(input)) !== null) {
      references.push(match[1]!);
      found = true;
    }

    const beforeMarkdownIndex = markdownPattern.lastIndex;
    markdownTargets(input);
    if (markdownPattern.lastIndex > beforeMarkdownIndex) {
      found = true;
      markdownPattern.lastIndex = 0;
    }

    if (!found) {
      maybeAddTarget(input);
    }
  };

  if (typeof value === 'string') {
    collectFromString(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        collectFromString(item);
      }
    }
  }

  return references;
}

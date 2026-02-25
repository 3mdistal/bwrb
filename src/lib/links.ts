/**
 * Check if a value is formatted as a wikilink.
 */
export function isWikilink(value: string): boolean {
  return /^\[\[.+\]\]$/.test(value);
}

/**
 * Check if a value is formatted as a quoted wikilink.
 */
export function isQuotedWikilink(value: string): boolean {
  return /^"\[\[.+\]\]"$/.test(value);
}

/**
 * Check if a value is formatted as a markdown link.
 * Matches: [Note Name](Note Name.md) or "[Note Name](Note Name.md)"
 */
export function isMarkdownLink(value: string): boolean {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  return /^\[.+\]\(.+\.md\)$/.test(v);
}

/**
 * Extract the target from a markdown link.
 * Returns the target without the .md extension.
 * Example: "[Note Name](Note Name.md)" -> "Note Name"
 */
export function extractMarkdownLinkTarget(value: string): string | null {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }

  const match = v.match(/^\[.+\]\((.+)\.md\)$/);
  return match ? match[1]! : null;
}

/**
 * Extract the target from a wikilink.
 * Returns the target without brackets, heading, or alias.
 */
export function extractWikilinkTarget(value: string): string | null {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }

  const match = v.match(/^\[\[([^\]|#]+)/);
  return match ? match[1]! : null;
}

/**
 * Convert a value to wikilink format.
 * Extracts the note name from markdown links if needed.
 */
export function toWikilink(value: string): string {
  if (isWikilink(value) || isQuotedWikilink(value)) {
    return value;
  }

  let name = value;
  if (isMarkdownLink(value)) {
    name = extractMarkdownLinkTarget(value) ?? value;
  }

  return `[[${name}]]`;
}

/**
 * Convert a value to markdown link format.
 * Extracts the note name from wikilinks if needed.
 */
export function toMarkdownLink(value: string): string {
  if (isMarkdownLink(value)) {
    return value;
  }

  let name = value;
  if (isWikilink(value)) {
    name = extractWikilinkTarget(value) ?? value;
  } else if (isQuotedWikilink(value)) {
    name = extractWikilinkTarget(value.slice(1, -1)) ?? value;
  }

  return `[${name}](${name}.md)`;
}

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

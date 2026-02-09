import { relative } from 'node:path';

export interface ConceptFileEntry {
  slug: string;
  filePath: string;
}

export interface ConceptSidebarDrift {
  missingFromSidebar: ConceptFileEntry[];
  missingOnDisk: string[];
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function normalizeConceptRef(value: string): string {
  const trimmed = value.trim();
  const noPrefixSlash = trimmed.replace(/^\/+/, '');
  const withoutHashOrQuery = noPrefixSlash.split(/[?#]/, 1)[0] ?? '';
  const noTrailingSlash = withoutHashOrQuery.replace(/\/+$/, '');
  return toPosixPath(noTrailingSlash);
}

export function conceptSlugFromDocsRelativePath(relativePath: string): string | null {
  const posix = toPosixPath(relativePath);
  if (!posix.startsWith('concepts/')) return null;
  if (!posix.toLowerCase().endsWith('.md')) return null;

  const withoutExt = posix.slice(0, -3);
  if (withoutExt.endsWith('/index')) return null;
  return withoutExt;
}

export function scanConceptFiles(filePaths: string[], docsRoot: string): ConceptFileEntry[] {
  const entriesBySlug = new Map<string, ConceptFileEntry>();

  for (const filePath of filePaths) {
    const rel = toPosixPath(relative(docsRoot, filePath));
    const slug = conceptSlugFromDocsRelativePath(rel);
    if (!slug) continue;
    if (!entriesBySlug.has(slug)) {
      entriesBySlug.set(slug, { slug, filePath: rel });
    }
  }

  return Array.from(entriesBySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
}

function skipWhitespaceAndComments(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      index += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    return index;
  }

  return index;
}

function parseQuotedString(source: string, startIndex: number): { value: string; nextIndex: number } | null {
  const quote = source[startIndex];
  if (quote !== '"' && quote !== "'") return null;

  let index = startIndex + 1;
  let value = '';
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        value += escaped;
        index += 2;
        continue;
      }
      return null;
    }
    if (ch === quote) {
      return { value, nextIndex: index + 1 };
    }
    value += ch;
    index += 1;
  }

  return null;
}

function parseIdentifier(source: string, startIndex: number): { value: string; nextIndex: number } | null {
  const first = source[startIndex];
  if (!first || !/[A-Za-z_$]/.test(first)) return null;

  let index = startIndex + 1;
  while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? '')) {
    index += 1;
  }

  return {
    value: source.slice(startIndex, index),
    nextIndex: index,
  };
}

function findMatchingBracket(source: string, openIndex: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }

    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }

    if (inTemplate) {
      if (ch === '`' && prev !== '\\') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '[') {
      depth += 1;
      continue;
    }

    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return index;
      continue;
    }
  }

  return -1;
}

function findSidebarArrayRange(source: string): { start: number; end: number } {
  let index = 0;
  while (index < source.length) {
    index = skipWhitespaceAndComments(source, index);
    if (index >= source.length) break;

    const ident = parseIdentifier(source, index);
    if (!ident) {
      if (source[index] === '"' || source[index] === "'") {
        const skipped = parseQuotedString(source, index);
        index = skipped ? skipped.nextIndex : index + 1;
      } else {
        index += 1;
      }
      continue;
    }

    index = ident.nextIndex;
    if (ident.value !== 'sidebar') {
      continue;
    }

    let cursor = skipWhitespaceAndComments(source, index);
    if (source[cursor] !== ':') continue;
    cursor = skipWhitespaceAndComments(source, cursor + 1);
    if (source[cursor] !== '[') continue;

    const close = findMatchingBracket(source, cursor);
    if (close < 0) {
      throw new Error('Could not parse sidebar array: unmatched brackets.');
    }

    return { start: cursor, end: close };
  }

  throw new Error('Could not find `sidebar: [...]` in docs-site/astro.config.mjs.');
}

function extractPropertyStringValues(source: string, acceptedKeys: Set<string>): string[] {
  const values: string[] = [];
  let index = 0;

  while (index < source.length) {
    index = skipWhitespaceAndComments(source, index);
    if (index >= source.length) break;

    let key: string | null = null;
    const quotedKey = parseQuotedString(source, index);
    if (quotedKey) {
      key = quotedKey.value;
      index = quotedKey.nextIndex;
    } else {
      const identKey = parseIdentifier(source, index);
      if (identKey) {
        key = identKey.value;
        index = identKey.nextIndex;
      }
    }

    if (!key) {
      index += 1;
      continue;
    }

    let cursor = skipWhitespaceAndComments(source, index);
    if (source[cursor] !== ':') {
      index = cursor;
      continue;
    }

    cursor = skipWhitespaceAndComments(source, cursor + 1);

    if (acceptedKeys.has(key)) {
      const value = parseQuotedString(source, cursor);
      if (value) {
        values.push(value.value);
        index = value.nextIndex;
        continue;
      }
    }

    index = cursor;
  }

  return values;
}

export function extractSidebarConceptRefs(source: string): Set<string> {
  const { start, end } = findSidebarArrayRange(source);
  const sidebarSlice = source.slice(start, end + 1);
  const refs = extractPropertyStringValues(sidebarSlice, new Set(['slug', 'link']));
  const concepts = refs
    .map(normalizeConceptRef)
    .filter((ref) => ref.startsWith('concepts/'));
  return new Set(concepts);
}

export function computeConceptSidebarDrift(
  diskEntries: ConceptFileEntry[],
  sidebarRefs: Set<string>,
  allowlist: Set<string>
): ConceptSidebarDrift {
  const diskBySlug = new Map<string, ConceptFileEntry>();
  for (const entry of diskEntries) {
    diskBySlug.set(entry.slug, entry);
  }

  const missingFromSidebar: ConceptFileEntry[] = [];
  for (const entry of diskEntries) {
    if (!sidebarRefs.has(entry.slug) && !allowlist.has(entry.slug)) {
      missingFromSidebar.push(entry);
    }
  }

  const missingOnDisk: string[] = [];
  for (const ref of sidebarRefs) {
    if (!diskBySlug.has(ref)) {
      missingOnDisk.push(ref);
    }
  }

  missingFromSidebar.sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
  missingOnDisk.sort((a, b) => a.localeCompare(b, 'en'));

  return {
    missingFromSidebar,
    missingOnDisk,
  };
}

export function formatConceptSidebarDrift(drift: ConceptSidebarDrift): string {
  const lines: string[] = [];
  lines.push('Docs sidebar drift detected (concepts)');

  if (drift.missingFromSidebar.length > 0) {
    lines.push('');
    lines.push('Missing from sidebar:');
    for (const entry of drift.missingFromSidebar) {
      lines.push(`- ${entry.slug} (${entry.filePath})`);
    }
  }

  if (drift.missingOnDisk.length > 0) {
    lines.push('');
    lines.push('Missing on disk:');
    for (const slug of drift.missingOnDisk) {
      lines.push(`- ${slug}`);
    }
  }

  lines.push('');
  lines.push('Fix: add missing slug(s) under Core Concepts in docs-site/astro.config.mjs or add intentional exceptions to docs-site/.concepts-sidebar-allowlist.json.');

  return lines.join('\n');
}

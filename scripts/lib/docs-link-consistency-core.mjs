import path from 'node:path';
import { URL } from 'node:url';

const EXTERNAL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

const toPosix = value => value.replace(/\\/g, '/');

const collapseSlashes = value => value.replace(/\/+/g, '/');

const normalizeLinkText = text => text.trim().replace(/\s+/g, ' ');

export const normalizeDocHref = (href, sourceHref = null) => {
  if (typeof href !== 'string') {
    return null;
  }

  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null;
  }

  if (EXTERNAL_PROTOCOL_RE.test(trimmed)) {
    return null;
  }

  const withoutMeta = trimmed.split('#', 1)[0].split('?', 1)[0].trim();
  if (!withoutMeta) {
    return null;
  }

  const unwrapped =
    withoutMeta.startsWith('<') && withoutMeta.endsWith('>')
      ? withoutMeta.slice(1, -1).trim()
      : withoutMeta;

  if (!unwrapped) {
    return null;
  }

  let pathname;
  if (unwrapped.startsWith('/')) {
    pathname = unwrapped;
  } else {
    if (!sourceHref) {
      pathname = `/${unwrapped}`;
    } else {
      pathname = new URL(unwrapped, `https://docs.local${sourceHref}`).pathname;
    }
  }

  pathname = collapseSlashes(toPosix(pathname));
  pathname = pathname.replace(/\.md$/i, '');

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, '');
    pathname = `${pathname}/`;
  }

  return pathname;
};

export const docsFilePathToHref = relativeFilePath => {
  const posixPath = toPosix(relativeFilePath);
  if (!posixPath.endsWith('.md')) {
    throw new Error(`Expected markdown file path, got: ${relativeFilePath}`);
  }

  const withoutExtension = posixPath.slice(0, -3);
  const normalized = withoutExtension === 'index' ? '/' : `/${withoutExtension}`;
  return normalizeDocHref(normalized);
};

const parseLinkDestination = rawDestination => {
  const trimmed = rawDestination.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }

  let result = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (/\s/.test(char)) {
      break;
    }
    result += char;
  }

  return result;
};

const parseLinksFromLine = line => {
  const links = [];

  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '[') {
      continue;
    }

    if (i > 0 && line[i - 1] === '!') {
      continue;
    }

    let labelEnd = -1;
    let labelDepth = 0;
    for (let j = i; j < line.length; j += 1) {
      const char = line[j];
      if (char === '\\') {
        j += 1;
        continue;
      }
      if (char === '[') {
        labelDepth += 1;
      } else if (char === ']') {
        labelDepth -= 1;
        if (labelDepth === 0) {
          labelEnd = j;
          break;
        }
      }
    }

    if (labelEnd === -1 || line[labelEnd + 1] !== '(') {
      continue;
    }

    let destinationEnd = -1;
    let destinationDepth = 0;
    for (let j = labelEnd + 1; j < line.length; j += 1) {
      const char = line[j];
      if (char === '\\') {
        j += 1;
        continue;
      }
      if (char === '(') {
        destinationDepth += 1;
      } else if (char === ')') {
        destinationDepth -= 1;
        if (destinationDepth === 0) {
          destinationEnd = j;
          break;
        }
      }
    }

    if (destinationEnd === -1) {
      continue;
    }

    const rawText = line.slice(i + 1, labelEnd);
    const rawDestination = line.slice(labelEnd + 2, destinationEnd);
    links.push({
      text: rawText,
      href: parseLinkDestination(rawDestination),
      column: i + 1,
    });

    i = destinationEnd;
  }

  return links;
};

export const extractLinks = (markdown, filePath, sourceHref) => {
  const lines = markdown.split(/\r?\n/);
  const links = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmedStart = line.trimStart();
    if (/^(```|~~~)/.test(trimmedStart)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const withoutInlineCode = line.replace(/`[^`]*`/g, '');
    const parsedLinks = parseLinksFromLine(withoutInlineCode);
    for (const link of parsedLinks) {
      const normalizedHref = normalizeDocHref(link.href, sourceHref);
      if (!normalizedHref) {
        continue;
      }

      links.push({
        filePath,
        sourceHref,
        line: index + 1,
        column: link.column,
        text: normalizeLinkText(link.text),
        href: normalizedHref,
      });
    }
  }

  return links;
};

const normalizeConceptInput = concept => ({
  canonicalText: normalizeLinkText(concept.canonicalText),
  canonicalHref: normalizeDocHref(concept.canonicalHref),
  textAliases: (concept.textAliases || []).map(normalizeLinkText).filter(Boolean),
  hrefAliases: (concept.hrefAliases || [])
    .map(alias => normalizeDocHref(alias))
    .filter(Boolean),
});

const registerTextIndex = (textIndex, text, canonicalHref, errors, context) => {
  const existing = textIndex.get(text);
  if (existing && existing !== canonicalHref) {
    errors.push(
      `Ambiguous ${context} "${text}": maps to both ${existing} and ${canonicalHref}`
    );
    return;
  }

  textIndex.set(text, canonicalHref);
};

export const collectConceptRegistry = (concepts, overrides = null) => {
  const errors = [];
  const byCanonicalHref = new Map();

  for (const concept of concepts) {
    const normalized = normalizeConceptInput(concept);
    if (!normalized.canonicalText) {
      errors.push(`Missing canonicalText for concept href ${concept.canonicalHref}`);
      continue;
    }
    if (!normalized.canonicalHref) {
      errors.push(`Invalid canonicalHref for concept text ${concept.canonicalText}`);
      continue;
    }

    const existing = byCanonicalHref.get(normalized.canonicalHref);
    if (existing && existing.canonicalText !== normalized.canonicalText) {
      errors.push(
        `Duplicate canonical href ${normalized.canonicalHref} with different titles: ` +
          `${existing.canonicalText} vs ${normalized.canonicalText}`
      );
      continue;
    }

    byCanonicalHref.set(normalized.canonicalHref, {
      canonicalHref: normalized.canonicalHref,
      canonicalText: normalized.canonicalText,
      textAliases: new Set(normalized.textAliases),
      hrefAliases: new Set(normalized.hrefAliases),
    });
  }

  if (overrides !== null) {
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      errors.push('Override file must be a JSON object');
    } else if (overrides.version !== 1) {
      errors.push(`Unsupported override version: ${String(overrides.version)}`);
    } else if (!Array.isArray(overrides.concepts)) {
      errors.push('Override file requires a concepts array');
    } else {
      for (const concept of overrides.concepts) {
        const normalized = normalizeConceptInput(concept);
        if (!normalized.canonicalText || !normalized.canonicalHref) {
          errors.push('Override concept must include canonicalText and canonicalHref');
          continue;
        }

        const existing = byCanonicalHref.get(normalized.canonicalHref);
        if (!existing) {
          byCanonicalHref.set(normalized.canonicalHref, {
            canonicalHref: normalized.canonicalHref,
            canonicalText: normalized.canonicalText,
            textAliases: new Set(normalized.textAliases),
            hrefAliases: new Set(normalized.hrefAliases),
          });
          continue;
        }

        if (existing.canonicalText !== normalized.canonicalText) {
          errors.push(
            `Override canonical text mismatch for ${normalized.canonicalHref}: ` +
              `${existing.canonicalText} vs ${normalized.canonicalText}`
          );
          continue;
        }

        for (const alias of normalized.textAliases) {
          existing.textAliases.add(alias);
        }
        for (const alias of normalized.hrefAliases) {
          existing.hrefAliases.add(alias);
        }
      }
    }
  }

  const textIndex = new Map();
  const hrefIndex = new Map();

  for (const concept of byCanonicalHref.values()) {
    const allowedTexts = new Set([concept.canonicalText, ...concept.textAliases]);
    const allowedHrefs = new Set([
      concept.canonicalHref,
      ...concept.hrefAliases,
      concept.canonicalHref.replace(/\/$/, ''),
      concept.canonicalHref.replace(/\/$/, '.md'),
    ]);

    concept.allowedTexts = allowedTexts;
    concept.allowedHrefs = new Set(
      Array.from(allowedHrefs)
        .map(item => normalizeDocHref(item))
        .filter(Boolean)
    );

    for (const text of allowedTexts) {
      registerTextIndex(textIndex, text, concept.canonicalHref, errors, 'concept text');
    }

    for (const href of concept.allowedHrefs) {
      const existingHref = hrefIndex.get(href);
      if (existingHref && existingHref !== concept.canonicalHref) {
        errors.push(
          `Ambiguous concept href alias ${href}: maps to both ${existingHref} and ${concept.canonicalHref}`
        );
        continue;
      }
      hrefIndex.set(href, concept.canonicalHref);
    }
  }

  return {
    concepts: Array.from(byCanonicalHref.values()).sort((a, b) =>
      a.canonicalHref.localeCompare(b.canonicalHref)
    ),
    byCanonicalHref,
    textIndex,
    hrefIndex,
    errors,
  };
};

const buildViolation = ({ rule, link, concept }) => ({
  rule,
  filePath: link.filePath,
  line: link.line,
  column: link.column,
  text: link.text,
  href: link.href,
  expectedText: concept.canonicalText,
  expectedHref: concept.canonicalHref,
  suggestion: `[${concept.canonicalText}](${concept.canonicalHref})`,
  message:
    rule === 'text-mismatch'
      ? `Canonical href ${concept.canonicalHref} should use link text "${concept.canonicalText}"`
      : `Concept text "${link.text}" should link to canonical href ${concept.canonicalHref}`,
});

export const analyzeLinks = (registry, links) => {
  const violations = [];

  for (const link of links) {
    const hrefConceptHref = registry.hrefIndex.get(link.href);
    if (hrefConceptHref) {
      const concept = registry.byCanonicalHref.get(hrefConceptHref);
      if (!concept.allowedTexts.has(link.text)) {
        violations.push(buildViolation({ rule: 'text-mismatch', link, concept }));
      }
    }

    const textConceptHref = registry.textIndex.get(link.text);
    if (textConceptHref) {
      const concept = registry.byCanonicalHref.get(textConceptHref);
      if (!concept.allowedHrefs.has(link.href)) {
        violations.push(buildViolation({ rule: 'href-mismatch', link, concept }));
      }
    }
  }

  return violations.sort((a, b) => {
    const fileCmp = a.filePath.localeCompare(b.filePath);
    if (fileCmp !== 0) {
      return fileCmp;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    const ruleCmp = a.rule.localeCompare(b.rule);
    if (ruleCmp !== 0) {
      return ruleCmp;
    }
    return a.column - b.column;
  });
};

export const formatViolations = violations =>
  violations
    .map(violation => {
      const location = `${violation.filePath}:${violation.line}`;
      return `${location} ${violation.rule} ${violation.message}. Suggested: ${violation.suggestion}`;
    })
    .join('\n');

export const collectLinksForDocuments = documents => {
  const links = [];
  for (const document of documents) {
    links.push(...extractLinks(document.markdown, document.filePath, document.href));
  }
  return links;
};

export const buildConceptsFromDocuments = conceptDocuments =>
  conceptDocuments.map(document => ({
    canonicalHref: document.href,
    canonicalText: document.title,
    textAliases: [],
    hrefAliases: [],
  }));

export const relativePath = (rootDir, filePath) =>
  toPosix(path.relative(rootDir, filePath)).replace(/^\.\//, '');

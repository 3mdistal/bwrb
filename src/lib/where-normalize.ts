import { FRONTMATTER_IDENTIFIER } from './where-constants.js';

const IDENTIFIER_BODY = /[A-Za-z0-9_]/;

export function normalizeWhereExpressions(
  expressions: string[],
  knownKeys: Set<string>
): string[] {
  if (expressions.length === 0 || knownKeys.size === 0) {
    return expressions;
  }

  return expressions.map(expr => normalizeWhereExpression(expr, knownKeys));
}

export function normalizeWhereExpression(
  expression: string,
  knownKeys: Set<string>
): string {
  const hyphenatedKeys = Array.from(knownKeys)
    .filter(key => key.includes('-'))
    .sort((a, b) => b.length - a.length);

  if (hyphenatedKeys.length === 0) {
    return expression;
  }

  let result = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i] ?? '';

    if (inSingle) {
      if (ch === '\\') {
        result += ch;
        i += 1;
        if (i < expression.length) {
          result += expression[i] ?? '';
          i += 1;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = false;
      }
      result += ch;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        result += ch;
        i += 1;
        if (i < expression.length) {
          result += expression[i] ?? '';
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      result += ch;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      result += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      result += ch;
      i += 1;
      continue;
    }

    let matchedKey: string | null = null;

    for (const key of hyphenatedKeys) {
      if (!expression.startsWith(key, i)) {
        continue;
      }

      const prev = i > 0 ? expression[i - 1] ?? '' : '';
      const next = expression[i + key.length] ?? '';

      if (!isBoundary(prev) || !isBoundary(next)) {
        continue;
      }

      if (prev === '.' || prev === '[') {
        continue;
      }

      if (prev === '-' && hasLeftOperandBeforeMinus(expression, i - 1)) {
        continue;
      }

      matchedKey = key;
      break;
    }

    if (matchedKey) {
      result += `${FRONTMATTER_IDENTIFIER}['${escapeKey(matchedKey)}']`;
      i += matchedKey.length;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

export function collectFrontmatterKeys(
  frontmatterList: Array<Record<string, unknown>>
): Set<string> {
  const keys = new Set<string>();

  for (const frontmatter of frontmatterList) {
    for (const key of Object.keys(frontmatter)) {
      keys.add(key);
    }
  }

  return keys;
}

function isBoundary(char: string): boolean {
  if (!char) return true;
  return !IDENTIFIER_BODY.test(char);
}

function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isIdentifierChar(char: string): boolean {
  return IDENTIFIER_BODY.test(char);
}

function hasLeftOperandBeforeMinus(expression: string, minusIndex: number): boolean {
  let i = minusIndex - 1;
  while (i >= 0 && isWhitespace(expression[i] ?? '')) {
    i -= 1;
  }
  if (i < 0) return false;
  const ch = expression[i] ?? '';
  if (isIdentifierChar(ch)) return true;
  return ch === ')' || ch === ']' || ch === '"' || ch === "'";
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

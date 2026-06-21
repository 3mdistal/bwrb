/**
 * Date Expression Evaluation
 * ==========================
 *
 * Evaluates date expressions in template defaults, allowing dynamic dates like:
 * - today()           → Current date (YYYY-MM-DD)
 * - today() + '7d'    → 7 days from now
 * - today() - '1w'    → 1 week ago
 * - now()             → Current datetime (YYYY-MM-DD HH:MM)
 * - now() + '2h'      → 2 hours from now
 *
 * A compact shorthand is also accepted (preferred in template values):
 * - @today            → equivalent to today()
 * - @today+3d         → 3 days from now
 * - @today + 1w       → 1 week from now (whitespace is optional)
 * - @today-2mon       → 2 months ago
 * - @now+2h           → equivalent to now() + '2h'
 *
 * Duration units:
 * - min      → minutes
 * - h        → hours
 * - d        → days
 * - w        → weeks
 * - mon / m  → months (30 days)
 * - y        → years (365 days)
 */

import { parseDuration } from './expression.js';
import { formatLocalDateTime, formatDateWithPattern, DEFAULT_DATE_FORMAT } from './local-date.js';

export { formatLocalDate as formatDate, formatLocalDateTime as formatDateTime } from './local-date.js';

/**
 * Regex pattern to match date expressions.
 *
 * Accepts two interchangeable base spellings:
 * - Function form:  today(), now()
 * - Shorthand form: @today, @now
 *
 * Accepts two interchangeable offset spellings:
 * - Quoted:   + '7d'  (the original constraint/query grammar)
 * - Unquoted: + 7d / +7d  (the compact template shorthand)
 *
 * The duration unit grammar matches the engine's {@link parseDuration} units,
 * plus `m` as a convenience alias for `mon` (months) in this layer only.
 */
const DATE_EXPR_PATTERN =
  /^(?:(today|now)\(\)|@(today|now))\s*(?:([+-])\s*(?:'(\d+(?:min|h|d|w|mon|m|y))'|(\d+(?:min|h|d|w|mon|m|y))))?$/;

/** Loose detector for "this looks like it was meant to be a date expression". */
const LOOKS_LIKE_DATE_EXPR = /^(?:(?:today|now)\s*\(|@(?:today|now)\b)/;

/**
 * Normalize the `m` month alias to the canonical `mon` understood by
 * {@link parseDuration}. Other units pass through unchanged.
 */
function normalizeDurationUnit(durationStr: string): string {
  return durationStr.replace(/^(\d+)m$/, '$1mon');
}

/**
 * Check if a string is a date expression.
 *
 * @example
 * isDateExpression("today()") // true
 * isDateExpression("today() + '7d'") // true
 * isDateExpression("@today+3d") // true
 * isDateExpression("@today + 1w") // true
 * isDateExpression("now() - '2h'") // true
 * isDateExpression("2025-01-15") // false
 * isDateExpression("hello") // false
 */
export function isDateExpression(value: string): boolean {
  if (typeof value !== 'string') return false;
  return DATE_EXPR_PATTERN.test(value.trim());
}

/**
 * Evaluate a date expression and return a formatted date string.
 * Returns null if the value is not a date expression.
 * Throws an error if the expression is malformed.
 *
 * @param value - The expression string to evaluate
 * @param dateFormat - Optional date format pattern (defaults to YYYY-MM-DD)
 *
 * @example
 * evaluateDateExpression("today()") // "2025-12-31"
 * evaluateDateExpression("today() + '7d'") // "2026-01-07"
 * evaluateDateExpression("@today+3d") // "2026-01-03"
 * evaluateDateExpression("now()") // "2025-12-31 14:30"
 * evaluateDateExpression("hello") // null
 * evaluateDateExpression("today()", "MM/DD/YYYY") // "12/31/2025"
 */
export function evaluateDateExpression(value: string, dateFormat: string = DEFAULT_DATE_FORMAT): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const match = trimmed.match(DATE_EXPR_PATTERN);

  if (!match) {
    // Check if it looks like a date expression but is malformed
    if (LOOKS_LIKE_DATE_EXPR.test(trimmed)) {
      throw new Error(
        `Invalid date expression: "${value}". Expected format: today(), today() + '7d', @today, @today+3d, now(), etc.`
      );
    }
    return null;
  }

  // Base token is captured either as a function (group 1) or shorthand (group 2).
  const func = match[1] ?? match[2];
  const operator = match[3];
  // Duration is captured as quoted (group 4) or unquoted (group 5).
  const durationStr = match[4] ?? match[5];
  const now = new Date();
  let result = now;

  // Apply duration if present
  if (operator && durationStr) {
    const durationMs = parseDuration(normalizeDurationUnit(durationStr));
    if (durationMs === null) {
      throw new Error(`Invalid duration: "${durationStr}". Valid units: min, h, d, w, mon (or m), y`);
    }

    if (operator === '+') {
      result = new Date(now.getTime() + durationMs);
    } else {
      result = new Date(now.getTime() - durationMs);
    }
  }

  // Format based on function type
  if (func === 'today') {
    return formatDateWithPattern(result, dateFormat);
  } else {
    return formatLocalDateTime(result);
  }
}

/**
 * Validate a date expression without evaluating it.
 * Returns null if valid, or an error message if invalid.
 * Returns null for non-expression strings (they're valid, just not expressions).
 *
 * @example
 * validateDateExpression("today() + '7d'") // null (valid)
 * validateDateExpression("@today+3d") // null (valid)
 * validateDateExpression("today( + 7d") // "Invalid date expression..."
 * validateDateExpression("@today + 5x") // "Invalid date expression..."
 * validateDateExpression("inbox") // null (not an expression, but valid)
 */
export function validateDateExpression(value: string): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  // Check if it looks like a date expression but is malformed
  if (LOOKS_LIKE_DATE_EXPR.test(trimmed)) {
    if (!DATE_EXPR_PATTERN.test(trimmed)) {
      return `Invalid date expression: "${value}". Expected format: today(), today() + '7d', @today, @today+3d, now(), etc.`;
    }
  }

  return null;
}

/**
 * Whether a field's declared `prompt` type makes it eligible for
 * date-expression evaluation of its template default.
 *
 * Only `date`-typed fields evaluate date expressions. Every other field type
 * (text, select, list, relation, boolean, number, or an undefined/static
 * field) treats its default verbatim, so prose like `@today-ish note` is never
 * mistaken for a malformed date expression.
 */
function isDateTypedFieldPrompt(prompt: string | undefined): boolean {
  return prompt === 'date';
}

/**
 * Evaluate a template default value, processing date expressions.
 *
 * Date-expression evaluation is gated by FIELD TYPE: it is only attempted when
 * `fieldType` is `date`. For every other field type — and for non-string
 * values — the value passes through unchanged, so non-date defaults that merely
 * look like a date expression (e.g. `@today-ish note`) are never evaluated and
 * never throw.
 *
 * On date-typed fields the full grammar (and its typo-protection throwing for
 * loosely-matching-but-malformed values) is preserved.
 *
 * @param value - The value to evaluate
 * @param dateFormat - Optional date format pattern (defaults to YYYY-MM-DD)
 * @param fieldType - The field's declared `prompt` type. When omitted, the
 *   value is treated as a non-date field and passed through verbatim. Callers
 *   that know a value is date-typed must pass `'date'` explicitly.
 *
 * @example
 * evaluateTemplateDefault("today() + '7d'", undefined, 'date') // "2026-01-07"
 * evaluateTemplateDefault("@today-ish note", undefined, 'text') // "@today-ish note"
 * evaluateTemplateDefault("inbox", undefined, 'date') // "inbox"
 * evaluateTemplateDefault(42, undefined, 'date') // 42
 * evaluateTemplateDefault("today()", "MM/DD/YYYY", 'date') // "01/07/2026"
 */
export function evaluateTemplateDefault(
  value: unknown,
  dateFormat: string = DEFAULT_DATE_FORMAT,
  fieldType?: string
): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  // Only date-typed fields attempt date-expression evaluation. Non-date fields
  // pass their default through verbatim (no detection, no throwing).
  if (!isDateTypedFieldPrompt(fieldType)) {
    return value;
  }

  const evaluated = evaluateDateExpression(value, dateFormat);
  return evaluated !== null ? evaluated : value;
}

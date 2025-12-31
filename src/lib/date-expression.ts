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
 * Duration units:
 * - min  → minutes
 * - h    → hours
 * - d    → days
 * - w    → weeks
 * - mon  → months (30 days)
 * - y    → years (365 days)
 */

import { parseDuration } from './expression.js';

/**
 * Regex pattern to match date expressions.
 * Matches: today(), now(), today() + '7d', now() - '2h', etc.
 */
const DATE_EXPR_PATTERN = /^(today|now)\(\)\s*(?:([+-])\s*'(\d+(?:min|h|d|w|mon|y))')?$/;

/**
 * Check if a string is a date expression.
 * 
 * @example
 * isDateExpression("today()") // true
 * isDateExpression("today() + '7d'") // true
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
 * @example
 * evaluateDateExpression("today()") // "2025-12-31"
 * evaluateDateExpression("today() + '7d'") // "2026-01-07"
 * evaluateDateExpression("now()") // "2025-12-31 14:30"
 * evaluateDateExpression("hello") // null
 */
export function evaluateDateExpression(value: string): string | null {
  if (typeof value !== 'string') return null;
  
  const trimmed = value.trim();
  const match = trimmed.match(DATE_EXPR_PATTERN);
  
  if (!match) {
    // Check if it looks like a date expression but is malformed
    if (/^(today|now)\s*\(/.test(trimmed)) {
      throw new Error(`Invalid date expression: "${value}". Expected format: today(), today() + '7d', now(), etc.`);
    }
    return null;
  }
  
  const [, func, operator, durationStr] = match;
  const now = new Date();
  let result = now;
  
  // Apply duration if present
  if (operator && durationStr) {
    const durationMs = parseDuration(durationStr);
    if (durationMs === null) {
      throw new Error(`Invalid duration: "${durationStr}". Valid units: min, h, d, w, mon, y`);
    }
    
    if (operator === '+') {
      result = new Date(now.getTime() + durationMs);
    } else {
      result = new Date(now.getTime() - durationMs);
    }
  }
  
  // Format based on function type
  if (func === 'today') {
    return formatDate(result);
  } else {
    return formatDateTime(result);
  }
}

/**
 * Format a Date as YYYY-MM-DD.
 */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Format a Date as YYYY-MM-DD HH:MM.
 */
export function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Validate a date expression without evaluating it.
 * Returns null if valid, or an error message if invalid.
 * Returns null for non-expression strings (they're valid, just not expressions).
 * 
 * @example
 * validateDateExpression("today() + '7d'") // null (valid)
 * validateDateExpression("today( + 7d") // "Invalid date expression..."
 * validateDateExpression("inbox") // null (not an expression, but valid)
 */
export function validateDateExpression(value: string): string | null {
  if (typeof value !== 'string') return null;
  
  const trimmed = value.trim();
  
  // Check if it looks like a date expression but is malformed
  if (/^(today|now)\s*\(/.test(trimmed)) {
    if (!DATE_EXPR_PATTERN.test(trimmed)) {
      return `Invalid date expression: "${value}". Expected format: today(), today() + '7d', now(), etc.`;
    }
  }
  
  return null;
}

/**
 * Evaluate a template default value, processing date expressions.
 * For non-string values or non-expression strings, returns the value unchanged.
 * 
 * @example
 * evaluateTemplateDefault("today() + '7d'") // "2026-01-07"
 * evaluateTemplateDefault("inbox") // "inbox"
 * evaluateTemplateDefault(42) // 42
 */
export function evaluateTemplateDefault(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  
  const evaluated = evaluateDateExpression(value);
  return evaluated !== null ? evaluated : value;
}

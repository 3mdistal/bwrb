/**
 * Scalar coercion helpers for audit fixes.
 */

export type CoerceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?\d+\.\d+$/;

export function coerceNumberFromString(raw: string): CoerceResult<number> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty string' };
  }

  if (!INTEGER_PATTERN.test(trimmed) && !DECIMAL_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'invalid numeric format' };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'non-finite number' };
  }

  return { ok: true, value };
}

export function coerceBooleanFromString(raw: string): CoerceResult<boolean> {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true') {
    return { ok: true, value: true };
  }
  if (trimmed === 'false') {
    return { ok: true, value: false };
  }
  return { ok: false, reason: 'invalid boolean literal' };
}

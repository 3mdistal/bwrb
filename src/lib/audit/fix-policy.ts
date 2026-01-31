/**
 * Pure policy helpers for audit fixes.
 */

import type { Field } from '../../types/schema.js';
import { coerceBooleanFromString, coerceNumberFromString } from './coercion.js';

export type ScalarType = 'string' | 'number' | 'boolean';
export type ValueShape = 'empty' | 'string' | 'number' | 'boolean' | 'list' | 'object' | 'unknown';

export type ScalarCoercion =
  | { ok: true; value: string | number | boolean; kind: 'coerce' | 'stringify' | 'identity' }
  | { ok: false; reason: string };

export type DateNormalization = {
  normalized: string;
  kind: 'slash' | 'dot' | 'zero-pad';
};

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const DOT_DATE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const HYPHEN_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

export function getValueShape(value: unknown): ValueShape {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

export function getExpectedScalarType(field: Field): ScalarType {
  if (field.prompt === 'number') return 'number';
  if (field.prompt === 'boolean') return 'boolean';
  return 'string';
}

export function getScalarCoercion(value: unknown, expected: ScalarType): ScalarCoercion {
  if (expected === 'string') {
    if (typeof value === 'string') return { ok: true, value, kind: 'identity' };
    if (typeof value === 'number' || typeof value === 'boolean') {
      return { ok: true, value: String(value), kind: 'stringify' };
    }
    return { ok: false, reason: 'unsupported scalar type' };
  }

  if (expected === 'number') {
    if (typeof value === 'number') return { ok: true, value, kind: 'identity' };
    if (typeof value === 'string') {
      const coerced = coerceNumberFromString(value);
      return coerced.ok
        ? { ok: true, value: coerced.value, kind: 'coerce' }
        : { ok: false, reason: coerced.reason };
    }
    return { ok: false, reason: 'unsupported scalar type' };
  }

  if (expected === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value, kind: 'identity' };
    if (typeof value === 'string') {
      const coerced = coerceBooleanFromString(value);
      return coerced.ok
        ? { ok: true, value: coerced.value, kind: 'coerce' }
        : { ok: false, reason: coerced.reason };
    }
    return { ok: false, reason: 'unsupported scalar type' };
  }

  return { ok: false, reason: 'unsupported expected type' };
}

export function getScalarFromList(value: unknown, expected: ScalarType): ScalarCoercion {
  if (!Array.isArray(value) || value.length !== 1) {
    return { ok: false, reason: 'list length not equal to 1' };
  }

  return getScalarCoercion(value[0], expected);
}

export function getScalarToList(value: unknown): { ok: true; value: unknown[] } | { ok: false } {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { ok: true, value: [value] };
  }
  return { ok: false };
}

export function isCanonicalIsoDate(raw: string): boolean {
  return CANONICAL_DATE.test(raw.trim());
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

export function getUnambiguousDateNormalization(raw: string): DateNormalization | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (CANONICAL_DATE.test(trimmed)) {
    return { normalized: trimmed, kind: 'zero-pad' };
  }

  const slash = trimmed.match(SLASH_DATE);
  if (slash) {
    const year = Number(slash[1]);
    const month = Number(slash[2]);
    const day = Number(slash[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return {
      normalized: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      kind: 'slash',
    };
  }

  const dot = trimmed.match(DOT_DATE);
  if (dot) {
    const year = Number(dot[1]);
    const month = Number(dot[2]);
    const day = Number(dot[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return {
      normalized: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      kind: 'dot',
    };
  }

  const hyphen = trimmed.match(HYPHEN_DATE);
  if (hyphen) {
    const year = Number(hyphen[1]);
    const month = Number(hyphen[2]);
    const day = Number(hyphen[3]);
    if (!isValidDateParts(year, month, day)) return null;
    const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (normalized === trimmed) return null;
    return { normalized, kind: 'zero-pad' };
  }

  return null;
}

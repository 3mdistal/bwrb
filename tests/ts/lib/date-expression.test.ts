import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDateExpression,
  evaluateDateExpression,
  evaluateTemplateDefault,
  formatDate,
  formatDateTime,
} from '../../../src/lib/date-expression.js';
import { formatLocalDate, formatLocalDateTime } from '../../../src/lib/local-date.js';

describe('date-expression', () => {
  // Use a fixed date for consistent tests
  const fixedDate = new Date('2025-06-15T10:30:00.000Z');
  
  // Helper to compute expected local time strings from UTC instant
  const expectedLocalDate = (date: Date) => formatLocalDate(date);
  const expectedLocalDateTime = (date: Date) => formatLocalDateTime(date);
  
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isDateExpression', () => {
    it('should recognize today()', () => {
      expect(isDateExpression('today()')).toBe(true);
    });

    it('should recognize today() with addition', () => {
      expect(isDateExpression("today() + '7d'")).toBe(true);
      expect(isDateExpression("today() + '1w'")).toBe(true);
      expect(isDateExpression("today() + '2mon'")).toBe(true);
    });

    it('should recognize today() with subtraction', () => {
      expect(isDateExpression("today() - '3d'")).toBe(true);
      expect(isDateExpression("today() - '1w'")).toBe(true);
    });

    it('should recognize now()', () => {
      expect(isDateExpression('now()')).toBe(true);
    });

    it('should recognize now() with duration', () => {
      expect(isDateExpression("now() + '2h'")).toBe(true);
      expect(isDateExpression("now() - '30min'")).toBe(true);
    });

    it('should handle whitespace variations', () => {
      expect(isDateExpression("today()+'7d'")).toBe(true);
      expect(isDateExpression("today()  +  '7d'")).toBe(true);
      expect(isDateExpression("  today()  ")).toBe(true);
    });

    it('should not match regular strings', () => {
      expect(isDateExpression('hello')).toBe(false);
      expect(isDateExpression('inbox')).toBe(false);
      expect(isDateExpression('2025-01-15')).toBe(false);
    });

    it('should not match partial expressions', () => {
      expect(isDateExpression('today')).toBe(false);
      expect(isDateExpression('today(')).toBe(false);
      expect(isDateExpression('now')).toBe(false);
    });

    it('should not match invalid duration units', () => {
      expect(isDateExpression("today() + '7x'")).toBe(false);
      expect(isDateExpression("today() + '7'")).toBe(false);
    });

    it('should recognize the @today shorthand', () => {
      expect(isDateExpression('@today')).toBe(true);
      expect(isDateExpression('@now')).toBe(true);
    });

    it('should recognize @today with compact (unquoted) offsets', () => {
      expect(isDateExpression('@today+3d')).toBe(true);
      expect(isDateExpression('@today+1w')).toBe(true);
      expect(isDateExpression('@today+1m')).toBe(true);
      expect(isDateExpression('@today-2mon')).toBe(true);
      expect(isDateExpression('@now+2h')).toBe(true);
    });

    it('should allow whitespace around the @today offset', () => {
      expect(isDateExpression('@today + 3d')).toBe(true);
      expect(isDateExpression('@today  -  1w')).toBe(true);
    });

    it('should allow quoted offsets on the @today shorthand', () => {
      expect(isDateExpression("@today + '7d'")).toBe(true);
    });

    it('should not match @today with invalid units', () => {
      expect(isDateExpression('@today+3x')).toBe(false);
      expect(isDateExpression('@today+3')).toBe(false);
      expect(isDateExpression('@todayish')).toBe(false);
      expect(isDateExpression('[[@today note]]')).toBe(false);
    });

    it('should handle non-string input', () => {
      expect(isDateExpression(null as unknown as string)).toBe(false);
      expect(isDateExpression(undefined as unknown as string)).toBe(false);
      expect(isDateExpression(42 as unknown as string)).toBe(false);
    });
  });

  describe('evaluateDateExpression', () => {
    it('should evaluate today() to current date', () => {
      const result = evaluateDateExpression('today()');
      expect(result).toBe('2025-06-15');
    });

    it('should evaluate today() + days', () => {
      expect(evaluateDateExpression("today() + '7d'")).toBe('2025-06-22');
      expect(evaluateDateExpression("today() + '1d'")).toBe('2025-06-16');
    });

    it('should evaluate today() - days', () => {
      expect(evaluateDateExpression("today() - '3d'")).toBe('2025-06-12');
      expect(evaluateDateExpression("today() - '15d'")).toBe('2025-05-31');
    });

    it('should evaluate today() + weeks', () => {
      expect(evaluateDateExpression("today() + '1w'")).toBe('2025-06-22');
      expect(evaluateDateExpression("today() + '2w'")).toBe('2025-06-29');
    });

    it('should evaluate today() + months', () => {
      // 30 days later
      expect(evaluateDateExpression("today() + '1mon'")).toBe('2025-07-15');
    });

    it('should evaluate today() + years', () => {
      // 365 days later
      expect(evaluateDateExpression("today() + '1y'")).toBe('2026-06-15');
    });

    it('should evaluate now() to current datetime (local timezone)', () => {
      const result = evaluateDateExpression('now()');
      // Result should be in local timezone, not UTC
      expect(result).toBe(expectedLocalDateTime(fixedDate));
    });

    it('should evaluate now() + hours (local timezone)', () => {
      const plus2h = new Date(fixedDate.getTime() + 2 * 60 * 60 * 1000);
      const plus14h = new Date(fixedDate.getTime() + 14 * 60 * 60 * 1000);
      expect(evaluateDateExpression("now() + '2h'")).toBe(expectedLocalDateTime(plus2h));
      expect(evaluateDateExpression("now() + '14h'")).toBe(expectedLocalDateTime(plus14h));
    });

    it('should evaluate now() - hours (local timezone)', () => {
      const minus2h = new Date(fixedDate.getTime() - 2 * 60 * 60 * 1000);
      expect(evaluateDateExpression("now() - '2h'")).toBe(expectedLocalDateTime(minus2h));
    });

    it('should evaluate now() + minutes (local timezone)', () => {
      const plus30m = new Date(fixedDate.getTime() + 30 * 60 * 1000);
      const plus90m = new Date(fixedDate.getTime() + 90 * 60 * 1000);
      expect(evaluateDateExpression("now() + '30min'")).toBe(expectedLocalDateTime(plus30m));
      expect(evaluateDateExpression("now() + '90min'")).toBe(expectedLocalDateTime(plus90m));
    });

    it('should return null for non-expressions', () => {
      expect(evaluateDateExpression('hello')).toBeNull();
      expect(evaluateDateExpression('2025-01-15')).toBeNull();
      expect(evaluateDateExpression('inbox')).toBeNull();
    });

    it('should return null for non-string input', () => {
      expect(evaluateDateExpression(42 as unknown as string)).toBeNull();
      expect(evaluateDateExpression(null as unknown as string)).toBeNull();
    });

    it('should throw for malformed expressions', () => {
      expect(() => evaluateDateExpression('today( + 7d')).toThrow(/Invalid date expression/);
      expect(() => evaluateDateExpression("today() +'7d")).toThrow(/Invalid date expression/);
    });

    it('should throw for a malformed @today shorthand', () => {
      expect(() => evaluateDateExpression('@today+')).toThrow(/Invalid date expression/);
      expect(() => evaluateDateExpression('@today+3x')).toThrow(/Invalid date expression/);
    });

    it('should evaluate the bare @today shorthand', () => {
      expect(evaluateDateExpression('@today')).toBe('2025-06-15');
      expect(evaluateDateExpression('@now')).toBe(expectedLocalDateTime(fixedDate));
    });

    it('should evaluate compact @today offsets (the #603 syntax)', () => {
      expect(evaluateDateExpression('@today+1d')).toBe('2025-06-16');
      expect(evaluateDateExpression('@today+3d')).toBe('2025-06-18');
      expect(evaluateDateExpression('@today+5d')).toBe('2025-06-20');
      expect(evaluateDateExpression('@today+7d')).toBe('2025-06-22');
      expect(evaluateDateExpression('@today+1w')).toBe('2025-06-22');
      expect(evaluateDateExpression('@today-3d')).toBe('2025-06-12');
    });

    it('should treat the @today `m` unit as months (alias for mon)', () => {
      expect(evaluateDateExpression('@today+1m')).toBe('2025-07-15');
      expect(evaluateDateExpression('@today+1mon')).toBe('2025-07-15');
    });

    it('should honor a custom date format for the @today shorthand', () => {
      expect(evaluateDateExpression('@today+3d', 'MM/DD/YYYY')).toBe('06/18/2025');
    });

    it('should stagger multiple @today offsets correctly', () => {
      const offsets = ['@today+1d', '@today+3d', '@today+5d', '@today+7d'];
      expect(offsets.map((o) => evaluateDateExpression(o))).toEqual([
        '2025-06-16',
        '2025-06-18',
        '2025-06-20',
        '2025-06-22',
      ]);
    });
  });

  describe('formatDate', () => {
    it('should format date as YYYY-MM-DD in local timezone', () => {
      const date1 = new Date('2025-01-05T12:00:00Z');
      const date2 = new Date('2025-12-31T23:59:59Z');
      // Use local date expectations since we now use local timezone
      expect(formatDate(date1)).toBe(expectedLocalDate(date1));
      expect(formatDate(date2)).toBe(expectedLocalDate(date2));
    });
  });

  describe('formatDateTime', () => {
    it('should format datetime as YYYY-MM-DD HH:mm in local timezone', () => {
      const date1 = new Date('2025-01-05T14:30:00Z');
      const date2 = new Date('2025-12-31T09:05:00Z');
      // Use local datetime expectations since we now use local timezone
      expect(formatDateTime(date1)).toBe(expectedLocalDateTime(date1));
      expect(formatDateTime(date2)).toBe(expectedLocalDateTime(date2));
    });
  });

  describe('evaluateTemplateDefault', () => {
    it('should evaluate date expressions', () => {
      expect(evaluateTemplateDefault('today()')).toBe('2025-06-15');
      expect(evaluateTemplateDefault("today() + '7d'")).toBe('2025-06-22');
    });

    it('should pass through regular strings', () => {
      expect(evaluateTemplateDefault('inbox')).toBe('inbox');
      expect(evaluateTemplateDefault('2025-01-15')).toBe('2025-01-15');
      expect(evaluateTemplateDefault('[[Some Link]]')).toBe('[[Some Link]]');
    });

    it('should pass through non-string values', () => {
      expect(evaluateTemplateDefault(42)).toBe(42);
      expect(evaluateTemplateDefault(true)).toBe(true);
      expect(evaluateTemplateDefault(['a', 'b'])).toEqual(['a', 'b']);
      expect(evaluateTemplateDefault(null)).toBe(null);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDateExpression,
  evaluateDateExpression,
  evaluateTemplateDefault,
  formatDate,
  formatDateTime,
} from '../../../src/lib/date-expression.js';

describe('date-expression', () => {
  // Use a fixed date for consistent tests
  const fixedDate = new Date('2025-06-15T10:30:00.000Z');
  
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

    it('should evaluate now() to current datetime', () => {
      const result = evaluateDateExpression('now()');
      expect(result).toBe('2025-06-15 10:30');
    });

    it('should evaluate now() + hours', () => {
      expect(evaluateDateExpression("now() + '2h'")).toBe('2025-06-15 12:30');
      expect(evaluateDateExpression("now() + '14h'")).toBe('2025-06-16 00:30');
    });

    it('should evaluate now() - hours', () => {
      expect(evaluateDateExpression("now() - '2h'")).toBe('2025-06-15 08:30');
    });

    it('should evaluate now() + minutes', () => {
      expect(evaluateDateExpression("now() + '30min'")).toBe('2025-06-15 11:00');
      expect(evaluateDateExpression("now() + '90min'")).toBe('2025-06-15 12:00');
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
  });

  describe('formatDate', () => {
    it('should format date as YYYY-MM-DD', () => {
      expect(formatDate(new Date('2025-01-05T12:00:00Z'))).toBe('2025-01-05');
      expect(formatDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31');
    });
  });

  describe('formatDateTime', () => {
    it('should format datetime as YYYY-MM-DD HH:MM', () => {
      expect(formatDateTime(new Date('2025-01-05T14:30:00Z'))).toBe('2025-01-05 14:30');
      expect(formatDateTime(new Date('2025-12-31T09:05:00Z'))).toBe('2025-12-31 09:05');
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

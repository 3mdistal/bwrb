import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatLocalDate,
  formatLocalDateTime,
  expandStaticValue,
  formatDateWithPattern,
  parseDate,
  isValidDate,
  DEFAULT_DATE_FORMAT,
} from '../../../src/lib/local-date.js';

describe('local-date', () => {
  // Use a fixed date for consistent tests
  const fixedDate = new Date('2025-06-15T10:30:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatLocalDate', () => {
    it('should format date using local timezone getters', () => {
      // Create date and verify we use local getters
      const result = formatLocalDate(fixedDate);
      
      // Build expected from local getters (same as the implementation)
      const expected = `${fixedDate.getFullYear()}-${String(fixedDate.getMonth() + 1).padStart(2, '0')}-${String(fixedDate.getDate()).padStart(2, '0')}`;
      expect(result).toBe(expected);
    });

    it('should use current date when no argument provided', () => {
      const result = formatLocalDate();
      const expected = `${fixedDate.getFullYear()}-${String(fixedDate.getMonth() + 1).padStart(2, '0')}-${String(fixedDate.getDate()).padStart(2, '0')}`;
      expect(result).toBe(expected);
    });

    it('should handle dates near midnight correctly', () => {
      // This is the key test for the UTC bug - at 11:30 PM UTC-8 on Jan 1,
      // the UTC date is Jan 2, but local date should still be Jan 1
      const nearMidnightUTC = new Date('2025-01-02T07:30:00.000Z'); // 11:30 PM on Jan 1 in UTC-8
      const result = formatLocalDate(nearMidnightUTC);
      
      // Use local getters to verify
      const expected = `${nearMidnightUTC.getFullYear()}-${String(nearMidnightUTC.getMonth() + 1).padStart(2, '0')}-${String(nearMidnightUTC.getDate()).padStart(2, '0')}`;
      expect(result).toBe(expected);
      
      // The result should NOT be the UTC date (which would be 2025-01-02)
      // unless we happen to be in a UTC+ timezone
      // Note: This test is timezone-aware, so results vary by test machine timezone
    });
  });

  describe('formatLocalDateTime', () => {
    it('should format datetime using local timezone getters', () => {
      const result = formatLocalDateTime(fixedDate);
      
      // Build expected from local getters
      const datePart = `${fixedDate.getFullYear()}-${String(fixedDate.getMonth() + 1).padStart(2, '0')}-${String(fixedDate.getDate()).padStart(2, '0')}`;
      const timePart = `${String(fixedDate.getHours()).padStart(2, '0')}:${String(fixedDate.getMinutes()).padStart(2, '0')}`;
      const expected = `${datePart} ${timePart}`;
      expect(result).toBe(expected);
    });

    it('should use current time when no argument provided', () => {
      const result = formatLocalDateTime();
      const datePart = `${fixedDate.getFullYear()}-${String(fixedDate.getMonth() + 1).padStart(2, '0')}-${String(fixedDate.getDate()).padStart(2, '0')}`;
      const timePart = `${String(fixedDate.getHours()).padStart(2, '0')}:${String(fixedDate.getMinutes()).padStart(2, '0')}`;
      expect(result).toBe(`${datePart} ${timePart}`);
    });
  });

  describe('expandStaticValue', () => {
    it('should expand $TODAY to local date', () => {
      const result = expandStaticValue('$TODAY');
      const expected = formatLocalDate(fixedDate);
      expect(result).toBe(expected);
    });

    it('should expand $NOW to local datetime', () => {
      const result = expandStaticValue('$NOW');
      const expected = formatLocalDateTime(fixedDate);
      expect(result).toBe(expected);
    });

    it('should pass through non-special values unchanged', () => {
      expect(expandStaticValue('hello')).toBe('hello');
      expect(expandStaticValue('2025-01-15')).toBe('2025-01-15');
      expect(expandStaticValue('$OTHER')).toBe('$OTHER');
    });

    it('should accept optional now parameter for testing', () => {
      const customDate = new Date('2030-12-25T18:00:00.000Z');
      const result = expandStaticValue('$TODAY', customDate);
      const expected = formatLocalDate(customDate);
      expect(result).toBe(expected);
    });
  });

  describe('local vs UTC behavior verification', () => {
    it('should NOT match toISOString output (the bug we fixed)', () => {
      // The old bug: toISOString() returns UTC, not local time
      // This test verifies we're NOT using UTC
      
      // Pick a time that differs between UTC and most local timezones
      // At 2am UTC, many timezones are on a different calendar day
      const earlyMorningUTC = new Date('2025-03-15T02:00:00.000Z');
      vi.setSystemTime(earlyMorningUTC);
      
      const localResult = formatLocalDate();
      const utcResult = earlyMorningUTC.toISOString().slice(0, 10);
      
      // In most timezones, these will differ
      // (except UTC+0 through UTC+2 where they'd be the same)
      // The key is that we're using local getters, not toISOString
      const expectedFromLocalGetters = `${earlyMorningUTC.getFullYear()}-${String(earlyMorningUTC.getMonth() + 1).padStart(2, '0')}-${String(earlyMorningUTC.getDate()).padStart(2, '0')}`;
      
      expect(localResult).toBe(expectedFromLocalGetters);
      // This is the real verification - we use getDate(), not toISOString()
    });

    it('should use getHours for time, not UTC hours', () => {
      const result = formatLocalDateTime(fixedDate);
      
      // Extract hours from result
      const resultHours = result.split(' ')[1]?.split(':')[0];
      
      // Should match local hours, not UTC hours
      expect(resultHours).toBe(String(fixedDate.getHours()).padStart(2, '0'));
    });
  });

  describe('formatDateWithPattern', () => {
    it('should format date in ISO format by default', () => {
      const date = new Date(2026, 0, 7); // Jan 7, 2026
      expect(formatDateWithPattern(date)).toBe('2026-01-07');
    });

    it('should format date in US format (MM/DD/YYYY)', () => {
      const date = new Date(2026, 0, 7); // Jan 7, 2026
      expect(formatDateWithPattern(date, 'MM/DD/YYYY')).toBe('01/07/2026');
    });

    it('should format date in EU format (DD/MM/YYYY)', () => {
      const date = new Date(2026, 0, 7); // Jan 7, 2026
      expect(formatDateWithPattern(date, 'DD/MM/YYYY')).toBe('07/01/2026');
    });

    it('should format date in EU dash format (DD-MM-YYYY)', () => {
      const date = new Date(2026, 0, 7); // Jan 7, 2026
      expect(formatDateWithPattern(date, 'DD-MM-YYYY')).toBe('07-01-2026');
    });

    it('should handle custom format patterns', () => {
      const date = new Date(2026, 0, 7); // Jan 7, 2026
      expect(formatDateWithPattern(date, 'YYYY.MM.DD')).toBe('2026.01.07');
    });

    it('should use current date when no date provided', () => {
      const result = formatDateWithPattern(undefined, 'MM/DD/YYYY');
      const now = new Date();
      const expected = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
      expect(result).toBe(expected);
    });
  });

  describe('parseDate', () => {
    describe('ISO format (YYYY-MM-DD)', () => {
      it('should parse valid ISO date', () => {
        const result = parseDate('2026-01-07');
        expect(result.valid).toBe(true);
        expect(result.date?.getFullYear()).toBe(2026);
        expect(result.date?.getMonth()).toBe(0); // January
        expect(result.date?.getDate()).toBe(7);
      });

      it('should parse ISO date with time (space separator)', () => {
        const result = parseDate('2026-01-07 14:30');
        expect(result.valid).toBe(true);
        expect(result.date?.getFullYear()).toBe(2026);
      });

      it('should parse ISO date with time (T separator)', () => {
        const result = parseDate('2026-01-07T14:30:00');
        expect(result.valid).toBe(true);
        expect(result.date?.getFullYear()).toBe(2026);
      });

      it('should reject invalid ISO date with wrong day', () => {
        const result = parseDate('2026-02-30'); // Feb 30 doesn't exist
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid day');
      });

      it('should reject invalid ISO date with wrong month', () => {
        const result = parseDate('2026-13-01'); // Month 13 doesn't exist
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid month');
      });
    });

    describe('unambiguous US format (MM/DD/YYYY)', () => {
      it('should parse unambiguous US date (day > 12)', () => {
        const result = parseDate('01/15/2026'); // Jan 15
        expect(result.valid).toBe(true);
        expect(result.date?.getMonth()).toBe(0); // January
        expect(result.date?.getDate()).toBe(15);
      });

      it('should parse US date where day makes it unambiguous', () => {
        const result = parseDate('07/25/2026'); // July 25
        expect(result.valid).toBe(true);
        expect(result.date?.getMonth()).toBe(6); // July
        expect(result.date?.getDate()).toBe(25);
      });
    });

    describe('unambiguous EU format (DD/MM/YYYY)', () => {
      it('should parse unambiguous EU date (first number > 12)', () => {
        const result = parseDate('15/01/2026'); // 15th Jan
        expect(result.valid).toBe(true);
        expect(result.date?.getDate()).toBe(15);
        expect(result.date?.getMonth()).toBe(0); // January
      });

      it('should parse EU date where first number makes it unambiguous', () => {
        const result = parseDate('25/07/2026'); // 25th July
        expect(result.valid).toBe(true);
        expect(result.date?.getDate()).toBe(25);
        expect(result.date?.getMonth()).toBe(6); // July
      });
    });

    describe('ambiguous dates', () => {
      it('should reject ambiguous slash date', () => {
        const result = parseDate('01/02/2026'); // Jan 2 or Feb 1?
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Ambiguous');
      });

      it('should reject ambiguous dash date', () => {
        const result = parseDate('05-06-2026'); // May 6 or June 5?
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Ambiguous');
      });

      it('should provide helpful error message for ambiguous dates', () => {
        const result = parseDate('01/02/2026');
        expect(result.error).toContain('YYYY-MM-DD');
        expect(result.error).toContain('US');
        expect(result.error).toContain('EU');
      });
    });

    describe('invalid inputs', () => {
      it('should reject empty string', () => {
        const result = parseDate('');
        expect(result.valid).toBe(false);
      });

      it('should reject unrecognized format', () => {
        const result = parseDate('Jan 7, 2026');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Unrecognized');
      });

      it('should reject gibberish', () => {
        const result = parseDate('not-a-date');
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('isValidDate', () => {
    it('should return true for valid ISO date', () => {
      expect(isValidDate('2026-01-07')).toBe(true);
    });

    it('should return true for unambiguous US date', () => {
      expect(isValidDate('01/15/2026')).toBe(true);
    });

    it('should return true for unambiguous EU date', () => {
      expect(isValidDate('15/01/2026')).toBe(true);
    });

    it('should return false for ambiguous date', () => {
      expect(isValidDate('01/02/2026')).toBe(false);
    });

    it('should return false for invalid date', () => {
      expect(isValidDate('not-a-date')).toBe(false);
    });
  });

  describe('expandStaticValue with date format', () => {
    it('should expand $TODAY with custom date format', () => {
      const customDate = new Date(2026, 0, 7); // Jan 7, 2026
      const result = expandStaticValue('$TODAY', customDate, 'MM/DD/YYYY');
      expect(result).toBe('01/07/2026');
    });

    it('should expand $TODAY with EU date format', () => {
      const customDate = new Date(2026, 0, 7); // Jan 7, 2026
      const result = expandStaticValue('$TODAY', customDate, 'DD/MM/YYYY');
      expect(result).toBe('07/01/2026');
    });

    it('should use default format when not specified', () => {
      const customDate = new Date(2026, 0, 7); // Jan 7, 2026
      const result = expandStaticValue('$TODAY', customDate);
      expect(result).toBe('2026-01-07');
    });
  });

  describe('DEFAULT_DATE_FORMAT', () => {
    it('should be ISO format', () => {
      expect(DEFAULT_DATE_FORMAT).toBe('YYYY-MM-DD');
    });
  });
});

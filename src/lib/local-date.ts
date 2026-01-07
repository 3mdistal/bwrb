/**
 * Local Date/Time Formatting
 * ==========================
 *
 * Provides consistent local timezone date/time formatting for user-facing dates.
 * Uses the system's local timezone, NOT UTC.
 *
 * These formatters are used for:
 * - $TODAY / $NOW static value expansion
 * - today() / now() expression functions
 * - {date} template substitution
 * - Date expression evaluation (today() + '7d', etc.)
 *
 * For absolute timestamps (audit logs, migration history, snapshots),
 * continue to use Date.toISOString() which provides UTC.
 *
 * Date Format Support
 * -------------------
 * Configurable via `config.date_format` in schema.json.
 * Supported format tokens: YYYY, MM, DD
 * Common formats:
 * - YYYY-MM-DD (default, ISO 8601)
 * - MM/DD/YYYY (US format)
 * - DD/MM/YYYY (EU format)
 * - DD-MM-YYYY (EU format with dashes)
 */

/** Default date format (ISO 8601) */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

/**
 * Format a Date as YYYY-MM-DD in local timezone.
 * This is the legacy function that always uses ISO format.
 *
 * @example
 * // At 11pm on Jan 1st in US Pacific time (UTC-8):
 * // new Date('2025-01-02T07:00:00Z') is still Jan 1st locally
 * formatLocalDate(new Date('2025-01-02T07:00:00Z'))
 * // => '2025-01-01' (in Pacific timezone)
 */
export function formatLocalDate(date: Date = new Date()): string {
  return formatDateWithPattern(date, DEFAULT_DATE_FORMAT);
}

/**
 * Format a Date using a custom format pattern.
 * Supports YYYY, MM, DD tokens.
 *
 * @param date - The date to format
 * @param format - Format pattern (e.g., 'YYYY-MM-DD', 'MM/DD/YYYY')
 * @returns Formatted date string
 *
 * @example
 * formatDateWithPattern(new Date('2026-01-07'), 'MM/DD/YYYY')
 * // => '01/07/2026'
 */
export function formatDateWithPattern(date: Date = new Date(), format: string = DEFAULT_DATE_FORMAT): string {
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return format
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day);
}

/**
 * Result of parsing a date string.
 */
export interface ParsedDate {
  /** Whether parsing succeeded */
  valid: boolean;
  /** The parsed Date object (only set if valid) */
  date?: Date;
  /** Error message (only set if invalid) */
  error?: string;
}

/**
 * Parse a date string in a format-agnostic way.
 *
 * Accepts dates in multiple formats:
 * - ISO 8601: YYYY-MM-DD (e.g., 2026-01-07)
 * - ISO 8601 with time: YYYY-MM-DD HH:MM or YYYY-MM-DDTHH:MM
 * - US format: MM/DD/YYYY (e.g., 01/07/2026)
 * - EU format: DD/MM/YYYY (e.g., 07/01/2026) - detected by day > 12
 * - EU dash format: DD-MM-YYYY (e.g., 07-01-2026) - detected by day > 12
 *
 * Ambiguous dates (where both month and day are <= 12) are rejected
 * for non-ISO formats to prevent silent errors.
 *
 * @param value - The date string to parse
 * @returns ParsedDate result with valid flag, date, and optional error
 *
 * @example
 * parseDate('2026-01-07')        // valid: ISO format
 * parseDate('01/07/2026')        // invalid: ambiguous (could be Jan 7 or Jul 1)
 * parseDate('13/07/2026')        // valid: unambiguous EU (day=13 > 12)
 * parseDate('07/13/2026')        // valid: unambiguous US (month position has 13)
 */
export function parseDate(value: string): ParsedDate {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Date value is required' };
  }

  const trimmed = value.trim();

  // Try ISO format first: YYYY-MM-DD (with optional time)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})([ T](\d{2}):(\d{2})(:\d{2})?)?$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]!, 10);
    const month = parseInt(isoMatch[2]!, 10);
    const day = parseInt(isoMatch[3]!, 10);

    const validationError = validateDateComponents(year, month, day);
    if (validationError) {
      return { valid: false, error: validationError };
    }

    const date = new Date(year, month - 1, day);
    return { valid: true, date };
  }

  // Try slash formats: MM/DD/YYYY or DD/MM/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const first = parseInt(slashMatch[1]!, 10);
    const second = parseInt(slashMatch[2]!, 10);
    const year = parseInt(slashMatch[3]!, 10);

    return parseAmbiguousDate(first, second, year, '/');
  }

  // Try dash formats for non-ISO: DD-MM-YYYY
  // (Note: YYYY-MM-DD is already handled above as ISO)
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const first = parseInt(dashMatch[1]!, 10);
    const second = parseInt(dashMatch[2]!, 10);
    const year = parseInt(dashMatch[3]!, 10);

    return parseAmbiguousDate(first, second, year, '-');
  }

  return {
    valid: false,
    error: `Unrecognized date format: "${value}". Use YYYY-MM-DD, MM/DD/YYYY, or DD/MM/YYYY`,
  };
}

/**
 * Parse a potentially ambiguous date where the order of month/day is unclear.
 *
 * Logic:
 * - If first > 12: must be DD/MM/YYYY (EU format)
 * - If second > 12: must be MM/DD/YYYY (US format)
 * - If both <= 12: ambiguous, reject
 */
function parseAmbiguousDate(
  first: number,
  second: number,
  year: number,
  separator: string
): ParsedDate {
  // If first > 12, it must be a day (EU format: DD/MM/YYYY)
  if (first > 12) {
    const day = first;
    const month = second;
    const validationError = validateDateComponents(year, month, day);
    if (validationError) {
      return { valid: false, error: validationError };
    }
    return { valid: true, date: new Date(year, month - 1, day) };
  }

  // If second > 12, it must be a day (US format: MM/DD/YYYY)
  if (second > 12) {
    const month = first;
    const day = second;
    const validationError = validateDateComponents(year, month, day);
    if (validationError) {
      return { valid: false, error: validationError };
    }
    return { valid: true, date: new Date(year, month - 1, day) };
  }

  // Both are <= 12: ambiguous
  return {
    valid: false,
    error: `Ambiguous date: "${first}${separator}${second}${separator}${year}" could be ` +
      `${String(first).padStart(2, '0')}/${String(second).padStart(2, '0')} (US) or ` +
      `${String(second).padStart(2, '0')}/${String(first).padStart(2, '0')} (EU). ` +
      `Use YYYY-MM-DD format for clarity.`,
  };
}

/**
 * Validate date components are within valid ranges.
 */
function validateDateComponents(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999) {
    return `Invalid year: ${year}`;
  }
  if (month < 1 || month > 12) {
    return `Invalid month: ${month}`;
  }
  if (day < 1 || day > 31) {
    return `Invalid day: ${day}`;
  }

  // Check day is valid for the month
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) {
    return `Invalid day ${day} for month ${month} (max: ${daysInMonth})`;
  }

  return null;
}

/**
 * Check if a string is a valid date (format-agnostic).
 * Convenience wrapper around parseDate().
 *
 * @param value - The date string to validate
 * @returns true if valid, false otherwise
 */
export function isValidDate(value: string): boolean {
  return parseDate(value).valid;
}

/**
 * Format a Date as YYYY-MM-DD HH:mm in local timezone.
 *
 * @example
 * formatLocalDateTime(new Date('2025-01-15T14:30:00Z'))
 * // => '2025-01-15 06:30' (in Pacific timezone, UTC-8)
 */
export function formatLocalDateTime(date: Date = new Date()): string {
  const datePart = formatLocalDate(date);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${datePart} ${hours}:${minutes}`;
}

/**
 * Expand special static values like $NOW and $TODAY.
 * Returns the original value if not a recognized static value.
 *
 * @param value - The value to potentially expand
 * @param now - Optional Date to use (defaults to current time, useful for testing)
 * @param dateFormat - Optional date format pattern (defaults to YYYY-MM-DD)
 */
export function expandStaticValue(value: string, now: Date = new Date(), dateFormat: string = DEFAULT_DATE_FORMAT): string {
  switch (value) {
    case '$NOW':
      return formatLocalDateTime(now);
    case '$TODAY':
      return formatDateWithPattern(now, dateFormat);
    default:
      return value;
  }
}

/**
 * Validators - common validation utilities for user input.
 * 
 * These functions provide reusable validation logic for common data types
 * and formats used throughout the application.
 */

/**
 * Validate that a string is a valid email address.
 * Uses a permissive regex that covers most common email formats.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Validate that a string is a valid phone number.
 * Accepts formats like: +1-555-123-4567, (555) 123-4567, 555.123.4567
 */
export function isValidPhone(phone: string): boolean {
  if (!phone || typeof phone !== 'string') return false;
  // Remove all non-digit characters except + at the start
  const digitsOnly = phone.replace(/^\+/, 'PLUS').replace(/\D/g, '').replace('PLUS', '+');
  // Check for reasonable length (7-15 digits, optionally starting with +)
  const digitCount = digitsOnly.replace('+', '').length;
  return digitCount >= 7 && digitCount <= 15;
}

/**
 * Validate that a string is a valid URL.
 * Supports http, https, and relative URLs.
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    // Handle relative URLs by prepending a base
    if (url.startsWith('/')) {
      new URL(url, 'https://example.com');
      return true;
    }
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is a valid date in ISO format (YYYY-MM-DD).
 */
export function isValidDate(date: string): boolean {
  if (!date || typeof date !== 'string') return false;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return false;
  
  const parsed = new Date(date);
  return !isNaN(parsed.getTime());
}

/**
 * Validate that a string is a valid slug (URL-friendly identifier).
 * Only allows lowercase letters, numbers, and hyphens.
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || typeof slug !== 'string') return false;
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  return slugRegex.test(slug);
}

/**
 * Sanitize a string by removing potentially dangerous characters.
 * Removes HTML tags, script content, and normalizes whitespace.
 */
export function sanitizeInput(input: string): string {
  if (!input || typeof input !== 'string') return '';
  
  return input
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove script content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Trim
    .trim();
}

/**
 * Validate that a value is within a numeric range (inclusive).
 */
export function isInRange(value: number, min: number, max: number): boolean {
  if (typeof value !== 'number' || isNaN(value)) return false;
  return value >= min && value <= max;
}

/**
 * Validate that a string matches a wikilink format: [[Note Name]]
 */
export function isValidWikilink(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const wikilinkRegex = /^\[\[[^\]]+\]\]$/;
  return wikilinkRegex.test(value);
}

/**
 * Extract the note name from a wikilink.
 * Returns null if the value is not a valid wikilink.
 */
export function extractWikilinkName(value: string): string | null {
  if (!isValidWikilink(value)) return null;
  return value.slice(2, -2);
}

/**
 * Validate that a string is non-empty after trimming whitespace.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

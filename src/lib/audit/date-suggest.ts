/**
 * Suggest unambiguous ISO-style dates for audit fixes.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})[ T]/;
const ISOISH_DATE = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;

export function suggestIsoDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (ISO_DATE.test(trimmed)) {
    return trimmed;
  }

  const isoPrefixMatch = trimmed.match(ISO_DATE_PREFIX);
  if (isoPrefixMatch) {
    return isoPrefixMatch[1] ?? null;
  }

  const isoishMatch = trimmed.match(ISOISH_DATE);
  if (!isoishMatch) {
    return null;
  }

  const year = Number(isoishMatch[1]);
  const month = Number(isoishMatch[2]);
  const day = Number(isoishMatch[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const normalizedMonth = String(month).padStart(2, '0');
  const normalizedDay = String(day).padStart(2, '0');
  return `${year}-${normalizedMonth}-${normalizedDay}`;
}

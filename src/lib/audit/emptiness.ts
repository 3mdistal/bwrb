/**
 * Required-field emptiness checks for audit detection.
 */

export function isEmptyRequiredValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

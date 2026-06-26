/**
 * Shared emptiness predicate for optional scalar field values.
 *
 * bwrb treats a blank optional value as "unset" *uniformly* — a `null`,
 * `undefined`, an empty string, or a whitespace-only string (e.g. `"   "`) all
 * mean "no value provided". This is the single source of truth so the write
 * path (`validateFrontmatter`, `normalizeDateFields`, `applyDefaults`) and the
 * audit path (`detection.ts` scalar/date guards) can never drift apart again
 * (#707). Trimming matches every other emptiness check in the codebase
 * (`isEmptyRequiredValue`, `isEffectivelyEmpty`, select-option and date-element
 * guards), so an optional date, number, boolean, or string with a whitespace-
 * only value is skipped identically on both write and audit.
 *
 * This deliberately does NOT treat `0` or `false` as empty — those are
 * legitimate scalar values, not "unset".
 */
export function isBlankScalar(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

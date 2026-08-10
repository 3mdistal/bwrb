import { formatLocalDate, parsePartialIsoDate } from './local-date.js';

/** Resolve one stable local-calendar observation date for a command run. */
export function resolveAsOf(value?: string): string {
  const resolved = value ?? formatLocalDate();
  const parsed = parsePartialIsoDate(resolved);
  if (!parsed.valid || parsed.precision !== 'day') {
    throw new Error(`Invalid --as-of date '${resolved}': expected a valid YYYY-MM-DD date`);
  }
  return parsed.value;
}

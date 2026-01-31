/**
 * Suggest unambiguous ISO-style dates for audit fixes.
 */

import { getUnambiguousDateNormalization, isCanonicalIsoDate } from './fix-policy.js';

export function suggestIsoDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (isCanonicalIsoDate(trimmed)) {
    return trimmed;
  }

  const normalization = getUnambiguousDateNormalization(trimmed);
  return normalization ? normalization.normalized : null;
}

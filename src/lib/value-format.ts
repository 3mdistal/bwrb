/**
 * Shared formatting for frontmatter values rendered as human-readable display
 * strings.
 *
 * Several call sites (list output, bulk change previews, migration change
 * previews, template body substitution) historically each carried their own
 * near-identical `formatValue` helper. They differed only in two dimensions:
 * the placeholder shown for empty values, and whether arrays are wrapped in
 * brackets. This module unifies them behind a single parameterized helper so
 * the rendering rules live in one tested place.
 *
 * Note: this is distinct from `formatValue` in `vault.ts`, which formats a
 * single string into a YAML-safe wikilink/markdown link. That helper serves a
 * different purpose and is intentionally left separate.
 */

export interface DisplayValueOptions {
  /**
   * Placeholder returned for empty values (`undefined` and `null`). Defaults to
   * an empty string.
   */
  empty?: string;
  /**
   * How arrays are rendered:
   * - `'plain'` (default): `"a, b"`, and `""` for an empty array.
   * - `'bracketed'`: `"[a, b]"`, and `"[]"` for an empty array.
   */
  arrayStyle?: 'plain' | 'bracketed';
}

/**
 * Render a frontmatter value as a human-readable display string.
 */
export function formatDisplayValue(
  value: unknown,
  options: DisplayValueOptions = {}
): string {
  const { empty = '', arrayStyle = 'plain' } = options;

  if (value === undefined || value === null) {
    return empty;
  }

  if (Array.isArray(value)) {
    if (arrayStyle === 'bracketed') {
      return value.length === 0 ? '[]' : `[${value.join(', ')}]`;
    }
    return value.join(', ');
  }

  return String(value);
}

/**
 * System-managed or built-in frontmatter fields.
 *
 * Keep these sets small and explicit to avoid hiding schema errors.
 */

/**
 * Fields written by bwrb that should not be treated as schema-unknown.
 */
const BWRB_BUILTIN_FRONTMATTER_FIELDS = new Set(['id', 'name']);

/**
 * Fields that are reserved/system-managed (immutability semantics).
 */
const BWRB_RESERVED_FRONTMATTER_FIELDS = new Set(['id']);

export function isBwrbBuiltinFrontmatterField(fieldName: string): boolean {
  return BWRB_BUILTIN_FRONTMATTER_FIELDS.has(fieldName);
}

export function isBwrbReservedFrontmatterField(fieldName: string): boolean {
  return BWRB_RESERVED_FRONTMATTER_FIELDS.has(fieldName);
}

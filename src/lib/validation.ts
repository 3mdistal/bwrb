import type { LoadedSchema, Field } from '../types/schema.js';
import { getFieldsForType, getDescendants, getType, getFieldOptions, resolveDateGranularity } from './schema.js';
import { isBwrbBuiltinFrontmatterField } from './frontmatter/systemFields.js';
import { extractWikilinkTarget } from './links.js';
import { levenshteinDistance } from './levenshtein.js';
import { isBlankScalar } from './emptiness.js';
import { buildVaultNoteIndex, type VaultNoteIndex } from './discovery.js';
import {
  expandStaticValue,
  parseDate,
  parsePartialIsoDate,
  isPrecisionAllowed,
  type DatePrecision,
} from './local-date.js';

export type NormalizedDateResult =
  | { valid: true; value: string }
  | { valid: false; error: string };

/** Human-readable description of the minimum precision a granularity requires. */
function describeGranularityRequirement(granularity: DatePrecision): string {
  switch (granularity) {
    case 'day':
      return 'a full date (YYYY-MM-DD)';
    case 'month':
      return 'at least month precision (YYYY-MM)';
    case 'year':
      return 'at least year precision (YYYY)';
  }
}

/**
 * Normalize a user-supplied date value to its canonical stored form.
 *
 * Full dates accept ISO, ISO datetime, and unambiguous US/EU formats and are
 * stored as YYYY-MM-DD. Partial dates (YYYY, YYYY-MM) are accepted only when the
 * field's `granularity` permits them, and are stored verbatim (ISO partials sort
 * lexically). `granularity` defaults to 'day' (full date required).
 */
function normalizeToIsoDate(
  value: string,
  granularity: DatePrecision = 'day'
): NormalizedDateResult {
  const trimmed = value.trim();

  // Partial ISO dates (YYYY or YYYY-MM). Full YYYY-MM-DD is handled by the
  // canonical/format-agnostic paths below.
  if (/^\d{4}(-\d{2})?$/.test(trimmed)) {
    const partial = parsePartialIsoDate(trimmed);
    if (!partial.valid) {
      return { valid: false, error: partial.error };
    }
    if (!isPrecisionAllowed(partial.precision, granularity)) {
      return {
        valid: false,
        error: `"${trimmed}" is too coarse: this field requires ${describeGranularityRequirement(granularity)}`,
      };
    }
    return { valid: true, value: partial.value };
  }

  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = parseDate(trimmed);
    return parsed.valid
      ? { valid: true, value: trimmed }
      : { valid: false, error: parsed.error ?? 'Invalid date' };
  }

  // ISO datetime (including Z / offsets) → normalize to date part
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(trimmed)) {
    const datePart = trimmed.slice(0, 10);
    const parsed = parseDate(datePart);
    return parsed.valid
      ? { valid: true, value: datePart }
      : { valid: false, error: parsed.error ?? 'Invalid date' };
  }

  // Format-agnostic date validation
  // Accepts ISO (YYYY-MM-DD), US (MM/DD/YYYY), EU (DD/MM/YYYY) formats
  // Rejects ambiguous dates where month and day are both <= 12 for non-ISO formats
  const parsed = parseDate(trimmed);
  if (!parsed.valid) {
    return { valid: false, error: parsed.error ?? 'Invalid date' };
  }

  // Canonical storage format
  const year = parsed.date!.getFullYear();
  const month = String(parsed.date!.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.date!.getDate()).padStart(2, '0');
  return { valid: true, value: `${year}-${month}-${day}` };
}

/**
 * Format a Date to YYYY-MM-DD using UTC components.
 * Used for YAML-parsed dates which are stored as midnight UTC.
 */
function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Normalize date fields in a frontmatter object to their canonical stored form.
 *
 * For each field whose schema `prompt` is `date`, the value is normalized via
 * {@link normalizeToIsoDate} using the field's resolved granularity:
 * - Unambiguous slash-format dates (e.g. `12/25/2026`) become `2026-12-25`.
 * - ISO datetimes are truncated to their date part.
 * - Valid partial dates (`2026`, `2026-05`) are preserved verbatim when the
 *   field's granularity permits them.
 * - Residual `Date` objects (from YAML parsing) are formatted from UTC.
 *
 * Values that fail normalization are left untouched so the validation layer can
 * surface a clear error. This is the single source of truth for date
 * normalization on write, shared by both the `new` and `edit` paths.
 *
 * @returns A shallow copy of `frontmatter` with date fields normalized.
 */
export function normalizeDateFields(
  schema: LoadedSchema,
  typePath: string,
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const fields = getFieldsForType(schema, typePath);
  const normalized: Record<string, unknown> = { ...frontmatter };

  for (const [fieldName, field] of Object.entries(fields)) {
    if (field.prompt !== 'date') continue;
    if (!(fieldName in normalized)) continue;

    const value = normalized[fieldName];
    const granularity = resolveDateGranularity(field, schema.config);

    // A `multiple: true` date field holds an array; canonicalize each element
    // against the field's granularity so list-date values (default-materialized
    // OR user-supplied) are written in the same ISO form `audit` validates and
    // `#673`-style per-element quoting expects. Mirrors the per-element validation
    // in `validateFieldType` (#707).
    if (field.multiple && Array.isArray(value)) {
      normalized[fieldName] = value.map((element) =>
        normalizeDateValue(element, granularity)
      );
      continue;
    }

    normalized[fieldName] = normalizeDateValue(value, granularity);
  }

  return normalized;
}

/**
 * Canonicalize a single date value to its ISO stored form against the supplied
 * granularity. Shared by scalar date fields and per-element normalization of
 * `multiple: true` date arrays so the two paths stay in lockstep (#707).
 *
 * Returns the input untouched when it is blank/unset, a residual `Date`
 * (formatted from UTC), a non-coercible non-string, or fails normalization — in
 * the last case the validation layer surfaces a clear error.
 */
function normalizeDateValue(value: unknown, granularity: DatePrecision): unknown {
  // A blank value (null/undefined/empty/whitespace-only) is "unset"; leave it
  // untouched so it isn't normalized into a bogus date (#707).
  if (isBlankScalar(value)) return value;

  // Handle any residual Date objects (defense-in-depth).
  // Use UTC components since YAML dates are stored as midnight UTC.
  if (value instanceof Date) {
    return formatUtcDate(value);
  }

  // A bare year (e.g. 2026) may arrive as a number from YAML/JSON; coerce so
  // it can be normalized against the field's granularity.
  const dateValue = typeof value === 'number' ? String(value) : value;
  if (typeof dateValue !== 'string') return value;

  const result = normalizeToIsoDate(dateValue, granularity);
  return result.valid ? result.value : value;
}


/**
 * Validation error types.
 */
type ValidationErrorType =
  | 'required_field_missing'
  | 'invalid_option_value'
  | 'invalid_type'
  | 'unknown_field'
  | 'invalid_date'
  | 'invalid_alias'
  | 'invalid_context_source';

/**
 * A single validation error with context.
 */
export interface ValidationError {
  type: ValidationErrorType;
  field: string;
  value?: unknown;
  message: string;
  expected?: string[] | string;
  suggestion?: string;
}

/**
 * Result of validating frontmatter.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Options for validation.
 */
export interface ValidationOptions {
  /** If true, unknown fields generate errors. If false, they generate warnings. Default: false */
  strictFields?: boolean;
  /** If true, skip applying defaults. Default: false */
  skipDefaults?: boolean;
}

/**
 * Validate frontmatter against a schema type.
 * Returns validation result with errors and warnings.
 */
export function validateFrontmatter(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>,
  options: ValidationOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const fields = getFieldsForType(schema, typeName);
  const fieldNames = new Set(Object.keys(fields));
  const providedFields = new Set(Object.keys(frontmatter));

  // Check for required fields
  for (const [fieldName, field] of Object.entries(fields)) {
    const value = frontmatter[fieldName];

    // The blank-as-unset handling (#707) splits into two questions, because a
    // blank value plays a different role in the REQUIRED check vs the TYPE check.
    //
    // A field is LIST-SHAPED if `field.multiple === true` OR `field.prompt ===
    // 'list'` — the exact predicate audit uses to decide "expects an array" (see
    // `expectsList` in `src/lib/audit/detection.ts` and `src/lib/audit/fix.ts`).
    //
    // (1) Is the value MISSING for the required check? — mirrors audit's
    //     `isEmptyRequiredValue`: `null`/`undefined`/blank-string for any field,
    //     PLUS an empty array `[]` for a list-shaped field. So a REQUIRED list
    //     field given `""`/`"   "`/`[]` is reported as required-missing (audit
    //     emits `empty-string-required`); an OPTIONAL one is simply skipped here.
    //     This restores the required-emptiness check that an earlier round
    //     regressed by routing list fields around `isBlankScalar` entirely.
    //
    // (2) Is there a value to TYPE-CHECK? — this is where scalar and list shapes
    //     diverge:
    //       - scalar field: a blank scalar string is "unset" and skips the type
    //         check (the PR's main change — `dates: "   "` on an optional scalar
    //         is accepted). Only a NON-blank scalar is type-checked.
    //       - list-shaped field: a blank scalar string is NOT unset — it is the
    //         wrong SHAPE (a scalar where a list is expected) and must reach
    //         `validateFieldType`, which rejects it for a `multiple` date field
    //         (bad date) and for an alias field (`invalid_alias`), matching
    //         audit's `wrong-scalar-type` flag. Only `null`/`undefined`/`[]` are
    //         genuinely unset for a list field and skip the type check.
    //
    // A non-blank scalar on a non-alias list field (e.g. `labels: 'urgent'`) is
    // unaffected: it was never blank, so it flows to type validation and keeps its
    // long-standing soft-coercion (audit autofixes it as `wrong-scalar-type`) —
    // intentionally out of scope here.
    const isListShapedField = field.multiple === true || field.prompt === 'list';
    const isNullish = value === undefined || value === null;
    const isEmptyArray = Array.isArray(value) && value.length === 0;

    // (1) Required-check emptiness (audit's `isEmptyRequiredValue` semantics).
    const isMissingForRequired = isListShapedField
      ? isBlankScalar(value) || isEmptyArray
      : isBlankScalar(value);

    // (2) Whether there is a value worth type-/option-checking. A blank scalar
    // string is unset for SCALAR fields only; for LIST-shaped fields it is the
    // wrong shape and must be type-checked.
    const hasValue = isListShapedField ? !(isNullish || isEmptyArray) : !isBlankScalar(value);

    // Check required fields
    if (field.required && isMissingForRequired && field.default === undefined) {
      const expected = getFieldExpected(schema, field);
      errors.push({
        type: 'required_field_missing',
        field: fieldName,
        message: `Required field missing: ${fieldName}`,
        ...(expected !== undefined && { expected }),
      });
      continue;
    }

    // Validate select fields with options
    if (hasValue) {
      const validOptions = getFieldOptions(field);
      if (validOptions.length > 0) {
        // Handle multi-select (array values)
        if (field.multiple && Array.isArray(value)) {
          for (const item of value) {
            const invalid = validateSelectOptionValue(item, validOptions);
            if (invalid) {
              errors.push({
                type: 'invalid_option_value',
                field: fieldName,
                value: item,
                message: `Invalid value for ${fieldName}: "${invalid.value}"`,
                expected: validOptions,
                ...(invalid.suggestion && { suggestion: `Did you mean '${invalid.suggestion}'?` }),
              });
            }
          }
        } else if (!Array.isArray(value)) {
          // Single-select validation
          const invalid = validateSelectOptionValue(value, validOptions);
          if (invalid) {
            errors.push({
              type: 'invalid_option_value',
              field: fieldName,
              value,
              message: `Invalid value for ${fieldName}: "${invalid.value}"`,
              expected: validOptions,
              ...(invalid.suggestion && { suggestion: `Did you mean '${invalid.suggestion}'?` }),
            });
          }
        }
      }
    }

    // Type checking
    if (hasValue) {
      const granularity = resolveDateGranularity(field, schema.config);
      const typeError = validateFieldType(fieldName, value, field, granularity);
      if (typeError) {
        errors.push(typeError);
      }
    }
  }

  // Check for unknown fields
  for (const fieldName of providedFields) {
    if (fieldName === 'type' || isBwrbBuiltinFrontmatterField(fieldName)) continue;
    if (!fieldNames.has(fieldName)) {
      const suggestion = suggestFieldName(fieldName, Array.from(fieldNames));
      const error: ValidationError = {
        type: 'unknown_field',
        field: fieldName,
        value: frontmatter[fieldName],
        message: `Unknown field: ${fieldName}`,
        ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
      };
      if (options.strictFields) {
        errors.push(error);
      } else {
        warnings.push(error);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Apply defaults to frontmatter for missing fields.
 * Also injects the 'type' field with the type name.
 *
 * When `keyScope` is provided, ONLY those field names are considered for default
 * materialization (and the `type` field is left untouched). The `edit` write path
 * uses this to restore the #707 write↔audit parity case SURGICALLY: it scopes
 * defaults to just the keys the user blanked in their patch, so an explicit
 * `null` removal is not re-defaulted and untouched fields are never materialized.
 * Without a scope, every declared field is considered (the `new` behavior).
 */
export function applyDefaults(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>,
  keyScope?: ReadonlySet<string>
): Record<string, unknown> {
  const result = { ...frontmatter };
  const fields = getFieldsForType(schema, typeName);

  // Always inject the type field with the type name (unscoped path only).
  // In the new inheritance model, type is auto-injected, not a field definition
  if (keyScope === undefined && !result['type']) {
    result['type'] = typeName;
  }

  for (const [fieldName, field] of Object.entries(fields)) {
    if (keyScope !== undefined && !keyScope.has(fieldName)) continue;

    const value = result[fieldName];
    // Blank optional values (incl. whitespace-only) are "unset", so defaults and
    // static values fill them in just like a missing field (#707).
    const hasValue = !isBlankScalar(value);

    if (!hasValue && field.default !== undefined) {
      result[fieldName] = field.default;
    }

    // Handle static values
    if (!hasValue && field.value !== undefined) {
      result[fieldName] = expandStaticValue(field.value, new Date(), schema.config.dateFormat);
    }
  }

  return result;
}

/**
 * Validate field type against expected types.
 */
/**
 * Validate a single date value against a field's granularity. Used for both
 * scalar date fields and per-element validation of list/multiple date fields.
 * When `listIndex` is supplied, the error message identifies the offending
 * element.
 */
function validateDateValue(
  fieldName: string,
  value: unknown,
  granularity: DatePrecision,
  listIndex?: number
): ValidationError | null {
  // Accept Date objects surfaced by YAML parsing, normalize elsewhere.
  if (value instanceof Date) {
    return null;
  }

  // A bare year (e.g. 2026) is parsed as a number by YAML; coerce so it can
  // be validated against the field's granularity.
  const dateValue = typeof value === 'number' ? String(value) : value;

  const location = listIndex === undefined ? fieldName : `${fieldName} at index ${listIndex}`;

  if (typeof dateValue !== 'string') {
    return {
      type: 'invalid_type',
      field: fieldName,
      value,
      message: `Invalid type for ${location}: expected date string, got ${typeof value}`,
      expected: 'date string (YYYY-MM-DD)',
    };
  }

  const normalized = normalizeToIsoDate(dateValue, granularity);
  if (!normalized.valid) {
    return {
      type: 'invalid_date',
      field: fieldName,
      value,
      message: `Invalid date for ${location}: ${normalized.error}`,
      expected: 'YYYY-MM-DD (recommended), or unambiguous MM/DD/YYYY or DD/MM/YYYY',
    };
  }

  return null;
}

function validateFieldType(
  fieldName: string,
  value: unknown,
  field: Field,
  granularity: DatePrecision = 'day'
): ValidationError | null {
  // Alias-role fields: enforce Obsidian `aliases` format regardless of prompt
  // type — an array of non-empty, unique strings.
  if (field.alias === true) {
    return validateAliasValue(fieldName, value);
  }

  // Handle list fields (multi-value arrays or comma-separated strings)
  if (field.prompt === 'list' || field.list_format) {
    // Accept both arrays and strings for list fields
    if (!Array.isArray(value) && typeof value !== 'string') {
      return {
        type: 'invalid_type',
        field: fieldName,
        value,
        message: `Invalid type for ${fieldName}: expected array or string, got ${typeof value}`,
        expected: 'array or string',
      };
    }
    return null;
  }

  // Date fields
  if (field.prompt === 'date') {
    // A list/multiple date field holds an array; validate each element against
    // the field's granularity, reporting the first invalid element.
    if (field.multiple && Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const element = value[index];
        // Skip blank/structural gaps (null/empty/whitespace-only); those are
        // reported separately. Shared `isBlankScalar` rule keeps this in step
        // with the scalar paths (#707).
        if (isBlankScalar(element)) continue;
        const elementError = validateDateValue(fieldName, element, granularity, index);
        if (elementError) return elementError;
      }
      return null;
    }

    return validateDateValue(fieldName, value, granularity);
  }

  // Boolean fields
  if (field.prompt === 'boolean') {
    // Accept actual booleans, or string representations
    if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      return {
        type: 'invalid_type',
        field: fieldName,
        value,
        message: `Invalid type for ${fieldName}: expected boolean, got ${typeof value}`,
        expected: 'boolean (true/false)',
      };
    }
    return null;
  }

  // Number fields
  if (field.prompt === 'number') {
    // Accept numbers or numeric strings
    if (typeof value === 'number') {
      return null;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) {
        return null;
      }
    }
    return {
      type: 'invalid_type',
      field: fieldName,
      value,
      message: `Invalid type for ${fieldName}: expected number, got ${typeof value}`,
      expected: 'number',
    };
  }

  // String fields (most common)
  // Allow strings, numbers, and booleans as they can be serialized
  if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
    return {
      type: 'invalid_type',
      field: fieldName,
      value,
      message: `Invalid type for ${fieldName}: expected string, got object`,
      expected: 'string',
    };
  }

  return null;
}

/**
 * Validate the value of an alias-role field.
 *
 * Aliases must be an array of non-empty, unique strings (Obsidian `aliases`
 * format). Rejects scalar values, empty/blank entries, non-string entries, and
 * duplicates. This is the original #266 ask and is enforced uniformly because
 * aliases are a recognized field role.
 */
function validateAliasValue(fieldName: string, value: unknown): ValidationError | null {
  const expected = 'array of non-empty, unique strings';

  if (!Array.isArray(value)) {
    return {
      type: 'invalid_alias',
      field: fieldName,
      value,
      message: `Invalid aliases for ${fieldName}: expected an array, got ${typeof value}`,
      expected,
    };
  }

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return {
        type: 'invalid_alias',
        field: fieldName,
        value: entry,
        message: `Invalid aliases for ${fieldName}: every alias must be a string, got ${typeof entry}`,
        expected,
      };
    }
    if (entry.trim() === '') {
      return {
        type: 'invalid_alias',
        field: fieldName,
        value: entry,
        message: `Invalid aliases for ${fieldName}: aliases cannot be empty`,
        expected,
      };
    }
    if (seen.has(entry)) {
      return {
        type: 'invalid_alias',
        field: fieldName,
        value: entry,
        message: `Invalid aliases for ${fieldName}: duplicate alias "${entry}"`,
        expected,
      };
    }
    seen.add(entry);
  }

  return null;
}

/**
 * Get expected values description for a field.
 */
function getFieldExpected(_schema: LoadedSchema, field: Field): string[] | undefined {
  const options = getFieldOptions(field);
  if (options.length > 0) {
    return options;
  }
  return undefined;
}

export interface InvalidSelectOptionValue {
  value: string;
  allowedOptions: string[];
  suggestion?: string;
}

/**
 * Validate a single value against a list of allowed select options.
 * Returns null when valid (or when no options are defined).
 */
export function validateSelectOptionValue(
  value: unknown,
  allowedOptions: string[]
): InvalidSelectOptionValue | null {
  if (allowedOptions.length === 0) {
    return null;
  }

  const normalizedValue = String(value);
  if (allowedOptions.includes(normalizedValue)) {
    return null;
  }

  const suggestion = suggestOptionValue(normalizedValue, allowedOptions);
  return {
    value: normalizedValue,
    allowedOptions,
    ...(suggestion && { suggestion }),
  };
}

/**
 * Suggest a similar option value using fuzzy matching.
 */
export function suggestOptionValue(
  value: string,
  allowed: string[]
): string | undefined {
  if (allowed.length === 0) return undefined;

  const valueLower = value.toLowerCase();
  let bestMatch: string | undefined;
  let bestDistance = Infinity;

  // First, try exact case-insensitive match
  for (const option of allowed) {
    if (option.toLowerCase() === valueLower) {
      return option;
    }
  }

  // Try prefix match
  for (const option of allowed) {
    if (option.toLowerCase().startsWith(valueLower)) {
      return option;
    }
  }

  // Try contains match
  for (const option of allowed) {
    if (option.toLowerCase().includes(valueLower) || 
        valueLower.includes(option.toLowerCase())) {
      return option;
    }
  }

  // Fall back to Levenshtein distance
  for (const option of allowed) {
    const distance = levenshteinDistance(valueLower, option.toLowerCase());
    // Threshold: at most 40% of the longer string's length
    const maxDistance = Math.ceil(Math.max(value.length, option.length) * 0.4);
    if (distance < bestDistance && distance <= maxDistance) {
      bestDistance = distance;
      bestMatch = option;
    }
  }

  return bestMatch;
}

/**
 * Suggest a similar field name using fuzzy matching.
 */
export function suggestFieldName(
  field: string,
  known: string[]
): string | undefined {
  if (known.length === 0) return undefined;

  const fieldLower = field.toLowerCase();
  let bestMatch: string | undefined;
  let bestDistance = Infinity;

  // First, try exact case-insensitive match
  for (const option of known) {
    if (option.toLowerCase() === fieldLower) {
      return option;
    }
  }

  // Fall back to Levenshtein distance
  for (const option of known) {
    const distance = levenshteinDistance(fieldLower, option.toLowerCase());
    // Threshold: at most 2 characters different, or 40% of length
    const maxDistance = Math.min(2, Math.ceil(option.length * 0.4));
    if (distance < bestDistance && distance <= maxDistance) {
      bestDistance = distance;
      bestMatch = option;
    }
  }

  return bestMatch;
}

/**
 * Format validation errors for human-readable output.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return '';

  const lines: string[] = ['Validation errors:'];
  for (const error of errors) {
    let line = `  - ${error.message}`;
    if (error.expected && Array.isArray(error.expected)) {
      const display = error.expected.length <= 5 
        ? error.expected.join(', ')
        : `${error.expected.slice(0, 5).join(', ')}... (${error.expected.length} options)`;
      line += `\n    Expected: ${display}`;
    }
    if (error.suggestion) {
      line += `\n    ${error.suggestion}`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Context field validation error with additional metadata.
 */
export interface ContextValidationError extends ValidationError {
  /** The referenced note name that was invalid */
  targetName?: string;
  /** The actual type of the referenced note (if found) */
  actualType?: string;
  /** The expected types based on the source constraint */
  expectedTypes?: string[];
}

/**
 * Result of validating context fields.
 */
export interface ContextValidationResult {
  valid: boolean;
  errors: ContextValidationError[];
}

/**
 * Validate context fields (fields with source type constraint) against the vault.
 * 
 * This validates that wikilink values in context fields reference notes that:
 * 1. Exist in the vault
 * 2. Match the source type constraint
 * 
 * For source type constraints:
 * - `source: "milestone"` - only accepts notes of exact type "milestone"
 * - `source: "objective"` - accepts "objective" or any descendant type (task, milestone, etc.)
 * - `source: "any"` - accepts any note type
 * 
 * @param schema - The loaded schema
 * @param vaultDir - The vault root directory
 * @param typeName - The type of the note being validated
 * @param frontmatter - The frontmatter values to validate
 * @returns Validation result with any context field errors
 */
export async function validateContextFields(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  frontmatter: Record<string, unknown>
): Promise<ContextValidationResult> {
  const errors: ContextValidationError[] = [];
  const fields = getFieldsForType(schema, typeName);
  const noteIndex = await buildVaultNoteIndex(schema, vaultDir);

  for (const [fieldName, field] of Object.entries(fields)) {
    // Skip fields without source constraint (not context fields)
    if (!field.source) continue;

    const value = frontmatter[fieldName];

    // Skip blank values, incl. whitespace-only (required field check is
    // separate). Arrays fall through to per-element handling below (#707).
    if (isBlankScalar(value)) continue;

    // Validate each value (handle both single and array values)
    const values = Array.isArray(value) ? value : [value];
    
    for (const v of values) {
      if (typeof v !== 'string') continue;
      
      const error = await validateSingleContextValue(
        schema,
        fieldName,
        field,
        v,
        noteIndex
      );
      
      if (error) {
        errors.push(error);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a single context field value against the vault.
 */
async function validateSingleContextValue(
  schema: LoadedSchema,
  fieldName: string,
  field: Field,
  value: string,
  noteIndex: VaultNoteIndex
): Promise<ContextValidationError | null> {
  const source = field.source!;
  
  // Extract wikilink target
  const targetName = extractWikilinkTarget(value);
  if (!targetName) {
    // Not a wikilink format - skip validation (other validators handle format)
    return null;
  }

  // Build list of valid types based on source constraint
  const validTypes = new Set<string>();
  
  // Handle array sources (e.g., ["chapter", "scene"] for recursive + extends)
  const sources = Array.isArray(source) ? source : [source];
  
  // Check for "any" in sources
  if (sources.includes('any')) {
    const candidates = noteIndex.noteTargetIndex.targetToPaths.get(targetName.toLowerCase()) ?? [];
    if (candidates.length > 0) {
      return null;
    }

    // Note not found in any type
    return {
      type: 'invalid_context_source',
      field: fieldName,
      value,
      message: `Referenced note not found: "${targetName}"`,
      targetName,
    };
  }

  // Build set of valid types from all sources + their descendants
  for (const src of sources) {
    // Check if source type exists
    const sourceType = getType(schema, src);
    if (!sourceType) {
      // Invalid source type in schema - skip this source
      continue;
    }

    // Add source + all descendants
    validTypes.add(src);
    for (const descendant of getDescendants(schema, src)) {
      validTypes.add(descendant);
    }
  }
  
  // If no valid source types were found, skip validation
  if (validTypes.size === 0) {
    return null;
  }

  const candidates = noteIndex.noteTargetIndex.targetToPaths.get(targetName.toLowerCase()) ?? [];
  const candidateTypes = candidates
    .map((candidatePath) => {
      const pathKey = candidatePath.replace(/\.md$/, '');
      return {
        path: candidatePath,
        type: noteIndex.noteTargetIndex.pathNoExtToType.get(pathKey),
      };
    })
    .filter((candidate): candidate is { path: string; type: string } => Boolean(candidate.type));

  if (candidateTypes.some((candidate) => validTypes.has(candidate.type))) {
    return null;
  }

  const wrongTypeCandidate = candidateTypes[0];
  if (wrongTypeCandidate) {
    return {
      type: 'invalid_context_source',
      field: fieldName,
      value,
      message: `"${targetName}" is type "${wrongTypeCandidate.type}", expected ${formatExpectedTypes(validTypes)}`,
      targetName,
      actualType: wrongTypeCandidate.type,
      expectedTypes: Array.from(validTypes),
      expected: Array.from(validTypes),
    };
  }

  // Note not found at all
  return {
    type: 'invalid_context_source',
    field: fieldName,
    value,
    message: `Referenced note not found: "${targetName}"`,
    targetName,
    expectedTypes: Array.from(validTypes),
    expected: Array.from(validTypes),
  };
}

/**
 * Format expected types for error messages.
 */
function formatExpectedTypes(types: Set<string>): string {
  const arr = Array.from(types);
  if (arr.length === 1) return `"${arr[0]}"`;
  if (arr.length === 2) return `"${arr[0]}" or "${arr[1]}"`;
  return `one of: ${arr.map(t => `"${t}"`).join(', ')}`;
}

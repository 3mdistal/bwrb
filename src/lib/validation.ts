import type { Schema, Field } from '../types/schema.js';
import { getFieldsForType, getEnumValues } from './schema.js';

/**
 * Validation error types.
 */
export type ValidationErrorType =
  | 'required_field_missing'
  | 'invalid_enum_value'
  | 'invalid_type'
  | 'unknown_field'
  | 'invalid_date';

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
  schema: Schema,
  typePath: string,
  frontmatter: Record<string, unknown>,
  options: ValidationOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const fields = getFieldsForType(schema, typePath);
  const fieldNames = new Set(Object.keys(fields));
  const providedFields = new Set(Object.keys(frontmatter));

  // Check for required fields
  for (const [fieldName, field] of Object.entries(fields)) {
    const value = frontmatter[fieldName];
    const hasValue = value !== undefined && value !== null && value !== '';

    // Check required fields
    if (field.required && !hasValue && field.default === undefined) {
      const expected = getFieldExpected(schema, field);
      errors.push({
        type: 'required_field_missing',
        field: fieldName,
        message: `Required field missing: ${fieldName}`,
        ...(expected !== undefined && { expected }),
      });
      continue;
    }

    // Validate enum fields
    if (hasValue && field.enum) {
      const enumValues = getEnumValues(schema, field.enum);
      if (enumValues.length > 0 && !enumValues.includes(String(value))) {
        const suggestion = suggestEnumValue(String(value), enumValues);
        errors.push({
          type: 'invalid_enum_value',
          field: fieldName,
          value,
          message: `Invalid value for ${fieldName}: "${value}"`,
          expected: enumValues,
          ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
        });
      }
    }

    // Type checking
    if (hasValue) {
      const typeError = validateFieldType(fieldName, value, field);
      if (typeError) {
        errors.push(typeError);
      }
    }
  }

  // Check for unknown fields
  for (const fieldName of providedFields) {
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
 */
export function applyDefaults(
  schema: Schema,
  typePath: string,
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...frontmatter };
  const fields = getFieldsForType(schema, typePath);

  for (const [fieldName, field] of Object.entries(fields)) {
    const value = result[fieldName];
    const hasValue = value !== undefined && value !== null && value !== '';

    if (!hasValue && field.default !== undefined) {
      result[fieldName] = field.default;
    }

    // Handle static values
    if (!hasValue && field.value !== undefined) {
      result[fieldName] = expandStaticValue(field.value);
    }
  }

  return result;
}

/**
 * Validate field type against expected types.
 */
function validateFieldType(
  fieldName: string,
  value: unknown,
  field: Field
): ValidationError | null {
  // Handle array fields (multi-input)
  if (field.prompt === 'multi-input' || field.list_format) {
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
    if (typeof value !== 'string') {
      return {
        type: 'invalid_type',
        field: fieldName,
        value,
        message: `Invalid type for ${fieldName}: expected date string, got ${typeof value}`,
        expected: 'date string (YYYY-MM-DD)',
      };
    }
    // Basic date format validation
    const dateRegex = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
    if (!dateRegex.test(value)) {
      return {
        type: 'invalid_date',
        field: fieldName,
        value,
        message: `Invalid date format for ${fieldName}: "${value}"`,
        expected: 'YYYY-MM-DD or YYYY-MM-DD HH:MM',
      };
    }
    return null;
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
 * Get expected values description for a field.
 */
function getFieldExpected(schema: Schema, field: Field): string[] | undefined {
  if (field.enum) {
    const values = getEnumValues(schema, field.enum);
    if (values.length > 0) return values;
  }
  return undefined;
}

/**
 * Expand special static values like $NOW and $TODAY.
 */
function expandStaticValue(value: string): string {
  const now = new Date();

  switch (value) {
    case '$NOW':
      return now.toISOString().slice(0, 16).replace('T', ' ');
    case '$TODAY':
      return now.toISOString().slice(0, 10);
    default:
      return value;
  }
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  
  // Create a 2D array with proper initialization
  const matrix: number[][] = Array.from({ length: aLen + 1 }, () => 
    Array.from({ length: bLen + 1 }, () => 0)
  );

  // Initialize first column
  for (let i = 0; i <= aLen; i++) {
    matrix[i]![0] = i;
  }
  
  // Initialize first row
  for (let j = 0; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        );
      }
    }
  }

  return matrix[aLen]![bLen]!;
}

/**
 * Suggest a similar enum value using fuzzy matching.
 */
export function suggestEnumValue(
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
 * Convert validation result to JSON-friendly format.
 */
export function validationResultToJson(
  result: ValidationResult
): Record<string, unknown> {
  return {
    success: result.valid,
    errors: result.errors.map(e => ({
      field: e.field,
      value: e.value,
      message: e.message,
      expected: e.expected,
      suggestion: e.suggestion,
    })),
    warnings: result.warnings.length > 0 
      ? result.warnings.map(w => ({
          field: w.field,
          value: w.value,
          message: w.message,
          suggestion: w.suggestion,
        }))
      : undefined,
  };
}

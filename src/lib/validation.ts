import type { LoadedSchema, Field } from '../types/schema.js';
import { getFieldsForType, getDescendants, getType } from './schema.js';
import { queryByType } from './vault.js';
import { extractWikilinkTarget } from './audit/types.js';

/**
 * Validation error types.
 */
type ValidationErrorType =
  | 'required_field_missing'
  | 'invalid_enum_value'
  | 'invalid_type'
  | 'unknown_field'
  | 'invalid_date'
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

    // Validate select fields with options
    if (hasValue && field.options && field.options.length > 0) {
      const validOptions = field.options;
      if (!validOptions.includes(String(value))) {
        const suggestion = suggestEnumValue(String(value), validOptions);
        errors.push({
          type: 'invalid_enum_value',
          field: fieldName,
          value,
          message: `Invalid value for ${fieldName}: "${value}"`,
          expected: validOptions,
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
 * Also injects the 'type' field with the type name.
 */
export function applyDefaults(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...frontmatter };
  const fields = getFieldsForType(schema, typeName);

  // Always inject the type field with the type name
  // In the new inheritance model, type is auto-injected, not a field definition
  if (!result['type']) {
    result['type'] = typeName;
  }

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
 * Get expected values description for a field.
 */
function getFieldExpected(_schema: LoadedSchema, field: Field): string[] | undefined {
  if (field.options && field.options.length > 0) {
    return field.options;
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

  for (const [fieldName, field] of Object.entries(fields)) {
    // Skip fields without source constraint (not context fields)
    if (!field.source) continue;

    const value = frontmatter[fieldName];
    
    // Skip empty/null values (required field check is separate)
    if (value === undefined || value === null || value === '') continue;

    // Validate each value (handle both single and array values)
    const values = Array.isArray(value) ? value : [value];
    
    for (const v of values) {
      if (typeof v !== 'string') continue;
      
      const error = await validateSingleContextValue(
        schema,
        vaultDir,
        fieldName,
        field,
        v
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
  vaultDir: string,
  fieldName: string,
  field: Field,
  value: string
): Promise<ContextValidationError | null> {
  const source = field.source!;
  
  // Extract wikilink target
  const targetName = extractWikilinkTarget(value);
  if (!targetName) {
    // Not a wikilink format - skip validation (other validators handle format)
    return null;
  }

  // "any" source accepts any note - we just need to verify it exists
  // For type-specific sources, we query by type which also verifies existence
  
  // Build list of valid types based on source constraint
  const validTypes = new Set<string>();
  
  // Handle array sources (e.g., ["chapter", "scene"] for recursive + extends)
  const sources = Array.isArray(source) ? source : [source];
  
  // Check for "any" in sources
  if (sources.includes('any')) {
    // Any type is valid, just need to check existence
    // Query all types to find the note
    for (const typeName of schema.types.keys()) {
      const typeNotes = await queryByType(schema, vaultDir, typeName);
      if (typeNotes.includes(targetName)) {
        return null; // Found, valid
      }
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

  // Query notes for each valid type and check if target exists
  for (const typeName of validTypes) {
    const typeNotes = await queryByType(schema, vaultDir, typeName);
    if (typeNotes.includes(targetName)) {
      return null; // Found and valid type
    }
  }

  // Check if the note exists but has wrong type (for better error messages)
  for (const [typeName, _type] of schema.types) {
    if (validTypes.has(typeName)) continue; // Already checked
    
    const typeNotes = await queryByType(schema, vaultDir, typeName);
    if (typeNotes.includes(targetName)) {
      // Note exists but wrong type
      return {
        type: 'invalid_context_source',
        field: fieldName,
        value,
        message: `"${targetName}" is type "${typeName}", expected ${formatExpectedTypes(validTypes)}`,
        targetName,
        actualType: typeName,
        expectedTypes: Array.from(validTypes),
        expected: Array.from(validTypes),
      };
    }
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

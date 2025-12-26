import type { Schema } from '../types/schema.js';
import { getAllFieldsForType, getEnumForField, getEnumValues } from './schema.js';

export interface Filter {
  field: string;
  operator: 'eq' | 'neq';
  values: string[];
}

/**
 * Parse filter arguments from CLI (e.g., --status=active, --status!=done).
 */
export function parseFilters(args: string[]): Filter[] {
  const filters: Filter[] = [];

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;

    const withoutPrefix = arg.slice(2);

    // Check for negation filter: --field!=value
    if (withoutPrefix.includes('!=')) {
      const [field, value] = withoutPrefix.split('!=', 2);
      if (field) {
        filters.push({
          field,
          operator: 'neq',
          values: value ? value.split(',') : [],
        });
      }
    }
    // Check for equality filter: --field=value
    else if (withoutPrefix.includes('=')) {
      const [field, value] = withoutPrefix.split('=', 2);
      if (field) {
        filters.push({
          field,
          operator: 'eq',
          values: value ? value.split(',') : [],
        });
      }
    }
  }

  return filters;
}

/**
 * Check if a single filter matches a frontmatter value.
 */
export function matchesFilter(
  frontmatterValue: unknown,
  filter: Filter
): boolean {
  const strValue = String(frontmatterValue ?? '');
  const isEmpty = frontmatterValue === undefined || frontmatterValue === null || frontmatterValue === '';

  // Handle empty filter value (checking for missing/empty field)
  if (filter.values.length === 0) {
    if (filter.operator === 'eq') {
      // --field= : match if field is empty/missing
      return isEmpty;
    } else {
      // --field!= : match if field is NOT empty (exists with value)
      return !isEmpty;
    }
  }

  // Check if value is in the filter values
  const found = filter.values.includes(strValue);

  if (filter.operator === 'eq') {
    // --field=val : match if value is in list
    return found;
  } else {
    // --field!=val : match if value is NOT in list
    return !found;
  }
}

/**
 * Check if all filters match a frontmatter object.
 */
export function matchesAllFilters(
  frontmatter: Record<string, unknown>,
  filters: Filter[]
): boolean {
  for (const filter of filters) {
    if (!matchesFilter(frontmatter[filter.field], filter)) {
      return false;
    }
  }
  return true;
}

/**
 * Validate that a field name is valid for a type path.
 */
export function validateFieldForType(
  schema: Schema,
  typePath: string,
  fieldName: string
): { valid: boolean; error?: string } {
  const validFields = getAllFieldsForType(schema, typePath);

  if (!validFields.has(fieldName)) {
    const fieldList = Array.from(validFields).join(', ');
    return {
      valid: false,
      error: `Unknown field '${fieldName}' for type '${typePath}'. Valid fields: ${fieldList}`,
    };
  }

  return { valid: true };
}

/**
 * Validate that filter values are valid for a field (if it's an enum field).
 */
export function validateFilterValues(
  schema: Schema,
  typePath: string,
  fieldName: string,
  values: string[]
): { valid: boolean; error?: string } {
  // Empty values are always valid (means "field is missing")
  if (values.length === 0) {
    return { valid: true };
  }

  const enumName = getEnumForField(schema, typePath, fieldName);
  if (!enumName) {
    // Not an enum field, any value is valid
    return { valid: true };
  }

  const enumValues = getEnumValues(schema, enumName);
  for (const val of values) {
    if (!enumValues.includes(val)) {
      const validList = enumValues.join(', ');
      return {
        valid: false,
        error: `Invalid value '${val}' for field '${fieldName}'. Valid values: ${validList}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate all filters for a type path.
 */
export function validateFilters(
  schema: Schema,
  typePath: string,
  filters: Filter[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const filter of filters) {
    // Validate field name
    const fieldResult = validateFieldForType(schema, typePath, filter.field);
    if (!fieldResult.valid && fieldResult.error) {
      errors.push(fieldResult.error);
      continue;
    }

    // Validate filter values
    const valuesResult = validateFilterValues(schema, typePath, filter.field, filter.values);
    if (!valuesResult.valid && valuesResult.error) {
      errors.push(valuesResult.error);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

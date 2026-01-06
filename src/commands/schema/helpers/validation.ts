/**
 * Schema name validation helpers.
 */

/**
 * Validate a type name.
 * Returns an error message if invalid, undefined if valid.
 */
export function validateTypeName(name: string): string | undefined {
  if (!name) {
    return 'Type name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Type name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  if (name === 'meta') {
    return '"meta" is a reserved type name';
  }
  return undefined;
}

/**
 * Validate a field name.
 * Returns an error message if invalid, undefined if valid.
 */
export function validateFieldName(name: string): string | undefined {
  if (!name) {
    return 'Field name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Field name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  return undefined;
}

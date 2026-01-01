/**
 * Enum Utilities Module
 * 
 * Query and mutation functions for enum management.
 * Query functions work with LoadedSchema (resolved).
 * Mutation functions work with raw Schema (for writing).
 */

import type { LoadedSchema, Schema } from '../types/schema.js';

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an enum value name.
 * Returns error message if invalid, null if valid.
 */
export function validateEnumValue(value: string): string | null {
  if (!value) return 'Value cannot be empty';
  if (value !== value.trim()) return 'Value cannot have leading/trailing whitespace';
  if (value.includes(',')) return 'Value cannot contain commas';
  if (value.includes('\n')) return 'Value cannot contain newlines';
  return null;
}

/**
 * Validate an enum name.
 * Returns error message if invalid, null if valid.
 */
export function validateEnumName(name: string): string | null {
  if (!name) return 'Name cannot be empty';
  if (name !== name.trim()) return 'Name cannot have leading/trailing whitespace';
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores';
  }
  return null;
}

// ============================================================================
// Query Functions (work with LoadedSchema)
// ============================================================================

/**
 * Information about where an enum is used.
 */
export interface EnumUsage {
  typeName: string;
  fieldName: string;
}

/**
 * Get all places where an enum is used in the schema.
 */
export function getEnumUsage(schema: LoadedSchema, enumName: string): EnumUsage[] {
  const usages: EnumUsage[] = [];
  
  for (const [typeName, typeDef] of schema.types) {
    for (const [fieldName, field] of Object.entries(typeDef.fields)) {
      if (field.enum === enumName) {
        usages.push({ typeName, fieldName });
      }
    }
  }
  
  return usages;
}

/**
 * Check if an enum is currently in use by any field.
 */
export function isEnumInUse(schema: LoadedSchema, enumName: string): boolean {
  return getEnumUsage(schema, enumName).length > 0;
}

/**
 * Get all enum names from a loaded schema.
 */
export function getEnumNames(schema: LoadedSchema): string[] {
  return Array.from(schema.enums.keys()).sort();
}

/**
 * Check if an enum exists in the schema.
 */
export function enumExists(schema: LoadedSchema, enumName: string): boolean {
  return schema.enums.has(enumName);
}

// ============================================================================
// Mutation Functions (work with raw Schema)
// ============================================================================

/**
 * Add a new enum to the schema.
 * Returns a new schema object (does not mutate).
 * Throws if enum already exists or values are invalid.
 */
export function addEnum(schema: Schema, name: string, values: string[]): Schema {
  // Validate name
  const nameError = validateEnumName(name);
  if (nameError) throw new Error(nameError);
  
  // Check if exists
  if (schema.enums && schema.enums[name]) {
    throw new Error(`Enum "${name}" already exists`);
  }
  
  // Validate values
  if (values.length === 0) {
    throw new Error('Enum must have at least one value');
  }
  
  for (const value of values) {
    const valueError = validateEnumValue(value);
    if (valueError) throw new Error(`Invalid value "${value}": ${valueError}`);
  }
  
  // Check for duplicates
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) {
    throw new Error('Enum values must be unique');
  }
  
  return {
    ...schema,
    enums: {
      ...schema.enums,
      [name]: values,
    },
  };
}

/**
 * Delete an enum from the schema.
 * Returns a new schema object (does not mutate).
 * Throws if enum doesn't exist.
 */
export function deleteEnum(schema: Schema, name: string): Schema {
  if (!schema.enums || !schema.enums[name]) {
    throw new Error(`Enum "${name}" does not exist`);
  }
  
  const { [name]: _, ...remainingEnums } = schema.enums;
  
  return {
    ...schema,
    enums: remainingEnums,
  };
}

/**
 * Add a value to an existing enum.
 * Returns a new schema object (does not mutate).
 * Throws if enum doesn't exist or value already exists.
 */
export function addEnumValue(schema: Schema, enumName: string, value: string): Schema {
  if (!schema.enums || !schema.enums[enumName]) {
    throw new Error(`Enum "${enumName}" does not exist`);
  }
  
  const valueError = validateEnumValue(value);
  if (valueError) throw new Error(valueError);
  
  const existingValues = schema.enums[enumName];
  if (existingValues.includes(value)) {
    throw new Error(`Value "${value}" already exists in enum "${enumName}"`);
  }
  
  return {
    ...schema,
    enums: {
      ...schema.enums,
      [enumName]: [...existingValues, value],
    },
  };
}

/**
 * Remove a value from an enum.
 * Returns a new schema object (does not mutate).
 * Throws if enum doesn't exist, value doesn't exist, or would leave enum empty.
 */
export function removeEnumValue(schema: Schema, enumName: string, value: string): Schema {
  if (!schema.enums || !schema.enums[enumName]) {
    throw new Error(`Enum "${enumName}" does not exist`);
  }
  
  const existingValues = schema.enums[enumName];
  if (!existingValues.includes(value)) {
    throw new Error(`Value "${value}" does not exist in enum "${enumName}"`);
  }
  
  const newValues = existingValues.filter(v => v !== value);
  if (newValues.length === 0) {
    throw new Error(`Cannot remove last value from enum "${enumName}"`);
  }
  
  return {
    ...schema,
    enums: {
      ...schema.enums,
      [enumName]: newValues,
    },
  };
}

/**
 * Rename a value in an enum.
 * Returns a new schema object (does not mutate).
 * Throws if enum doesn't exist, old value doesn't exist, or new value already exists.
 */
export function renameEnumValue(
  schema: Schema,
  enumName: string,
  oldValue: string,
  newValue: string
): Schema {
  if (!schema.enums || !schema.enums[enumName]) {
    throw new Error(`Enum "${enumName}" does not exist`);
  }
  
  const valueError = validateEnumValue(newValue);
  if (valueError) throw new Error(valueError);
  
  const existingValues = schema.enums[enumName];
  if (!existingValues.includes(oldValue)) {
    throw new Error(`Value "${oldValue}" does not exist in enum "${enumName}"`);
  }
  
  if (existingValues.includes(newValue)) {
    throw new Error(`Value "${newValue}" already exists in enum "${enumName}"`);
  }
  
  const newValues = existingValues.map(v => v === oldValue ? newValue : v);
  
  return {
    ...schema,
    enums: {
      ...schema.enums,
      [enumName]: newValues,
    },
  };
}

/**
 * Bulk operation logic for modifying frontmatter.
 */

import type { BulkOperation, FieldChange, OperationType } from './types.js';

/**
 * Parse an operation argument like "field=value" or "old=new".
 * Returns [field, value] or [oldField, newField] depending on context.
 */
export function parseOperationArg(arg: string): [string, string] {
  const eqIndex = arg.indexOf('=');
  if (eqIndex === -1) {
    return [arg, ''];
  }
  return [arg.slice(0, eqIndex), arg.slice(eqIndex + 1)];
}

/**
 * Parse a value string into the appropriate type.
 * Handles:
 * - Empty string → undefined (for clear)
 * - "true" / "false" → boolean
 * - Numeric strings → number
 * - Everything else → string
 */
export function parseValue(value: string): unknown {
  if (value === '') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  // Check if it's a number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') {
    return num;
  }
  return value;
}

/**
 * Apply a single operation to frontmatter and return the change.
 * Returns null if no change was made.
 */
export function applySingleOperation(
  frontmatter: Record<string, unknown>,
  operation: BulkOperation
): FieldChange | null {
  const { type, field, value, newField } = operation;

  switch (type) {
    case 'set': {
      const oldValue = frontmatter[field];
      if (oldValue === value) {
        return null; // No change
      }
      frontmatter[field] = value;
      return {
        operation: 'set',
        field,
        oldValue,
        newValue: value,
      };
    }

    case 'clear': {
      if (!(field in frontmatter)) {
        return null; // Nothing to clear
      }
      const oldValue = frontmatter[field];
      delete frontmatter[field];
      return {
        operation: 'clear',
        field,
        oldValue,
        newValue: undefined,
      };
    }

    case 'rename': {
      if (!newField) {
        throw new Error(`Rename operation requires a new field name`);
      }
      if (!(field in frontmatter)) {
        return null; // Nothing to rename
      }
      if (newField in frontmatter) {
        throw new Error(`Cannot rename '${field}' to '${newField}': target field already exists`);
      }
      const oldValue = frontmatter[field];
      delete frontmatter[field];
      frontmatter[newField] = oldValue;
      return {
        operation: 'rename',
        field,
        oldValue,
        newValue: oldValue,
        newField,
      };
    }

    case 'delete': {
      if (!(field in frontmatter)) {
        return null; // Nothing to delete
      }
      const oldValue = frontmatter[field];
      delete frontmatter[field];
      return {
        operation: 'delete',
        field,
        oldValue,
        newValue: undefined,
      };
    }

    case 'append': {
      const oldValue = frontmatter[field];
      let newArray: unknown[];

      if (Array.isArray(oldValue)) {
        // Already an array, append to it
        if (oldValue.includes(value)) {
          return null; // Value already in array
        }
        newArray = [...oldValue, value];
      } else if (oldValue === undefined || oldValue === null) {
        // No existing value, create array with single item
        newArray = [value];
      } else {
        // Scalar value, convert to array with old and new values
        if (oldValue === value) {
          return null; // Same value
        }
        newArray = [oldValue, value];
      }

      frontmatter[field] = newArray;
      return {
        operation: 'append',
        field,
        oldValue,
        newValue: newArray,
      };
    }

    case 'remove': {
      const oldValue = frontmatter[field];
      if (!Array.isArray(oldValue)) {
        // Not an array, can't remove
        if (oldValue === value) {
          // Scalar equals the value, clear the field
          delete frontmatter[field];
          return {
            operation: 'remove',
            field,
            oldValue,
            newValue: undefined,
          };
        }
        return null; // Nothing to remove
      }

      const newArray = oldValue.filter(item => item !== value);
      if (newArray.length === oldValue.length) {
        return null; // Value wasn't in array
      }

      // Keep empty array (per design decision)
      frontmatter[field] = newArray;
      return {
        operation: 'remove',
        field,
        oldValue,
        newValue: newArray,
      };
    }

    default:
      throw new Error(`Unknown operation type: ${type}`);
  }
}

/**
 * Apply multiple operations to frontmatter.
 * Returns the modified frontmatter and list of changes.
 */
export function applyOperations(
  frontmatter: Record<string, unknown>,
  operations: BulkOperation[]
): { modified: Record<string, unknown>; changes: FieldChange[] } {
  // Work on a copy to avoid mutating the original
  const modified = { ...frontmatter };
  const changes: FieldChange[] = [];

  for (const operation of operations) {
    const change = applySingleOperation(modified, operation);
    if (change) {
      changes.push(change);
    }
  }

  return { modified, changes };
}

/**
 * Format a value for display.
 */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '(empty)';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    return `[${value.join(', ')}]`;
  }
  return String(value);
}

/**
 * Format a single field change for display.
 */
export function formatChange(change: FieldChange): string {
  switch (change.operation) {
    case 'set':
      return `${change.field}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)}`;
    case 'clear':
    case 'delete':
      return `${change.field}: ${formatValue(change.oldValue)} → (removed)`;
    case 'rename':
      return `${change.field} → ${change.newField}: ${formatValue(change.oldValue)}`;
    case 'append':
      return `${change.field}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)}`;
    case 'remove':
      return `${change.field}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)}`;
    default:
      return `${change.field}: unknown operation`;
  }
}

/**
 * Build a BulkOperation from CLI arguments.
 */
export function buildOperation(
  type: OperationType,
  arg: string
): BulkOperation {
  const [field, value] = parseOperationArg(arg);

  switch (type) {
    case 'set':
      if (value === '') {
        // --set field= means clear
        return { type: 'clear', field };
      }
      return { type: 'set', field, value: parseValue(value) };

    case 'rename':
      if (!value) {
        throw new Error(`Rename requires format: --rename old=new`);
      }
      return { type: 'rename', field, newField: value };

    case 'delete':
      return { type: 'delete', field };

    case 'append':
      if (value === '') {
        throw new Error(`Append requires a value: --append field=value`);
      }
      return { type: 'append', field, value: parseValue(value) };

    case 'remove':
      if (value === '') {
        throw new Error(`Remove requires a value: --remove field=value`);
      }
      return { type: 'remove', field, value: parseValue(value) };

    default:
      throw new Error(`Unknown operation type: ${type}`);
  }
}

/**
 * Schema entity picker prompts.
 */

import { promptSelection } from '../../../lib/prompt.js';
import { getTypeNames } from '../../../lib/schema.js';
import type { LoadedSchema } from '../../../types/schema.js';

export type SchemaEntityType = 'type' | 'field';

/**
 * Prompt user to select what kind of schema entity to work with.
 */
export async function promptSchemaEntityType(action: string): Promise<SchemaEntityType | null> {
  const result = await promptSelection(`What do you want to ${action}?`, [
    'type',
    'field',
  ]);
  if (result === null) return null;
  return result as SchemaEntityType;
}

/**
 * Prompt for type selection from available types.
 */
export async function promptTypePicker(schema: LoadedSchema, message: string = 'Select type'): Promise<string | null> {
  const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
  if (typeNames.length === 0) {
    throw new Error('No types defined in schema');
  }
  return promptSelection(message, typeNames);
}

/**
 * Prompt for field selection from a type's own fields.
 */
export async function promptFieldPicker(
  schema: LoadedSchema, 
  typeName: string, 
  message: string = 'Select field'
): Promise<string | null> {
  const typeEntry = schema.raw.types[typeName];
  if (!typeEntry?.fields || Object.keys(typeEntry.fields).length === 0) {
    throw new Error(`Type "${typeName}" has no own fields to select`);
  }
  const fieldNames = Object.keys(typeEntry.fields);
  return promptSelection(message, fieldNames);
}

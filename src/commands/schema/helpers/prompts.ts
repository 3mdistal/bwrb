/**
 * Field definition prompt helpers.
 */

import {
  printError,
  promptMultiInput,
  promptInput,
  promptConfirm,
  promptSelection,
} from '../../../lib/prompt.js';
import { getTypeNames } from '../../../lib/schema.js';
import { validateFieldName } from './validation.js';
import type { LoadedSchema, Field } from '../../../types/schema.js';

/**
 * Prompt for field definition interactively.
 * Returns null if user cancels, 'done' if user is finished adding fields.
 */
export async function promptFieldDefinition(
  schema: LoadedSchema
): Promise<{ name: string; field: Field } | null | 'done'> {
  // Get field name
  const nameResult = await promptInput('Field name (or "done" to finish)');
  if (nameResult === null) return null;
  
  const name = nameResult.trim().toLowerCase();
  if (!name || name === 'done') return 'done';
  
  // Validate field name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    printError('Field name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens');
    return promptFieldDefinition(schema); // Retry
  }
  
  // Get prompt type
  const promptTypes = [
    'text',
    'select (options)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
    'boolean (yes/no)',
    'number (numeric)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'text',
    1: 'select',
    2: 'date',
    3: 'list',
    4: 'relation',
    5: 'boolean',
    6: 'number',
    7: 'value',
  };
  const promptType = promptTypeMap[promptTypeIndex];
  
  const field: Field = {};
  
  // Handle different prompt types
  if (promptType === 'value') {
    // Fixed value
    const valueResult = await promptInput('Fixed value');
    if (valueResult === null) return null;
    field.value = valueResult;
  } else {
    field.prompt = promptType as Field['prompt'];
    
    // For select, get inline options
    if (promptType === 'select') {
      const optionsResult = await promptMultiInput('Enter options (one per line)');
      if (optionsResult === null) return null;
      if (optionsResult.length === 0) {
        printError('Select fields require at least one option');
        return promptFieldDefinition(schema);
      }
      field.options = optionsResult;
    }
    
    // For dynamic, get source type
    if (promptType === 'relation') {
      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
      if (typeNames.length === 0) {
        printError('No types defined in schema yet.');
        return promptFieldDefinition(schema);
      }
      const sourceResult = await promptSelection('Source type', typeNames);
      if (sourceResult === null) return null;
      field.source = sourceResult;
      // Note: Link format is now a vault-wide config option (config.link_format)
    }
    
    // Ask if required
    const requiredResult = await promptConfirm('Required?');
    if (requiredResult === null) return null;
    field.required = requiredResult;
    
    // If not required, ask for default
    if (!field.required) {
      const defaultResult = await promptInput('Default value (blank for none)');
      if (defaultResult === null) return null;
      if (defaultResult.trim()) {
        field.default = defaultResult.trim();
      }
    }
  }
  
  return { name, field };
}

/**
 * Prompt for a single field definition interactively.
 * Unlike promptFieldDefinition, this doesn't have a "done" option since we're
 * only adding one field.
 */
export async function promptSingleFieldDefinition(
  schema: LoadedSchema,
  fieldName?: string
): Promise<{ name: string; field: Field } | null> {
  let name = fieldName;
  
  // Get field name if not provided
  if (!name) {
    const nameResult = await promptInput('Field name');
    if (nameResult === null) return null;
    name = nameResult.trim().toLowerCase();
    
    if (!name) {
      throw new Error('Field name is required');
    }
  }
  
  // Validate field name
  const nameError = validateFieldName(name);
  if (nameError) {
    throw new Error(nameError);
  }
  
  // Get prompt type
  const promptTypes = [
    'text',
    'select (options)',
    'date',
    'list (multi-value)',
    'relation (from other notes)',
    'boolean (yes/no)',
    'number (numeric)',
    'fixed value',
  ];
  const promptTypeResult = await promptSelection('Prompt type', promptTypes);
  if (promptTypeResult === null) return null;
  
  const promptTypeIndex = promptTypes.indexOf(promptTypeResult);
  const promptTypeMap: Record<number, Field['prompt'] | 'value'> = {
    0: 'text',
    1: 'select',
    2: 'date',
    3: 'list',
    4: 'relation',
    5: 'boolean',
    6: 'number',
    7: 'value',
  };
  const promptType = promptTypeMap[promptTypeIndex];
  
  const field: Field = {};
  
  // Handle different prompt types
  if (promptType === 'value') {
    // Fixed value
    const valueResult = await promptInput('Fixed value');
    if (valueResult === null) return null;
    field.value = valueResult;
  } else {
    field.prompt = promptType as Field['prompt'];
    
    // For select, get inline options
    if (promptType === 'select') {
      const optionsResult = await promptMultiInput('Enter options (one per line)');
      if (optionsResult === null) return null;
      if (optionsResult.length === 0) {
        throw new Error('Select fields require at least one option');
      }
      field.options = optionsResult;
    }
    
    // For relation, get source type
    if (promptType === 'relation') {
      const typeNames = getTypeNames(schema).filter(t => t !== 'meta');
      if (typeNames.length === 0) {
        throw new Error('No types defined in schema yet.');
      }
      const sourceResult = await promptSelection('Source type', typeNames);
      if (sourceResult === null) return null;
      field.source = sourceResult;
      // Note: Link format is now a vault-wide config option (config.link_format)
    }
    
    // Ask if required
    const requiredResult = await promptConfirm('Required?');
    if (requiredResult === null) return null;
    field.required = requiredResult;
    
    // If not required, ask for default
    if (!field.required) {
      const defaultResult = await promptInput('Default value (blank for none)');
      if (defaultResult === null) return null;
      if (defaultResult.trim()) {
        field.default = defaultResult.trim();
      }
    }
  }
  
  return { name, field };
}

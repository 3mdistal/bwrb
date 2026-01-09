/**
 * Shared edit logic for frontmatter editing.
 * 
 * This module contains the core editing functions used by both:
 * - `edit` command (standalone)
 * - `search --edit` (unified interface)
 */

import {
  getTypeDefByPath,
  resolveTypePathFromFrontmatter,
  getFieldsForType,
  getFrontmatterOrder,
} from './schema.js';
import { parseNote, writeNote, generateBodySections } from './frontmatter.js';
import { queryByType, formatValue } from './vault.js';
import {
  promptSelection,
  promptMultiSelect,
  promptInput,
  promptConfirm,
  printSuccess,
  printInfo,
  printWarning,
} from './prompt.js';
import {
  validateFrontmatter,
  validateContextFields,
  normalizeToIsoDate,
} from './validation.js';
import { validateParentNoCycle } from './hierarchy.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from './output.js';
import type { LoadedSchema, Field, BodySection } from '../types/schema.js';
import { UserCancelledError } from './errors.js';
import { expandStaticValue } from './local-date.js';

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
 * Normalize date fields to canonical YYYY-MM-DD strings.
 * Handles both string values (ISO datetimes) and any residual Date objects.
 * Note: frontmatter parsing already normalizes Date objects, but this provides
 * defense-in-depth for any edge cases.
 */
function normalizeDateFields(
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
    if (value === undefined || value === null || value === '') continue;

    // Handle any residual Date objects (defense-in-depth)
    // Use UTC components since YAML dates are stored as midnight UTC
    if (value instanceof Date) {
      normalized[fieldName] = formatUtcDate(value);
      continue;
    }

    if (typeof value === 'string') {
      const result = normalizeToIsoDate(value);
      if (result.valid) {
        normalized[fieldName] = result.value;
      }
    }
  }

  return normalized;
}

// ============================================================================
// Types
// ============================================================================

export interface EditResult {
  updatedFields: string[];
  path: string;
}

export interface EditFromJsonOptions {
  /** Whether to output errors as JSON */
  jsonMode?: boolean;
}

export interface EditInteractiveOptions {
  /** Whether to check for missing body sections */
  checkSections?: boolean;
}

// ============================================================================
// JSON Edit Mode (Non-Interactive)
// ============================================================================

/**
 * Edit a note from JSON input (non-interactive mode with merge semantics).
 * 
 * @param schema - Loaded schema
 * @param vaultDir - Vault directory path
 * @param filePath - Absolute path to the note file
 * @param jsonInput - JSON string with patch data
 * @param options - Edit options
 * @returns Result with updated field names
 */
export async function editNoteFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  filePath: string,
  jsonInput: string,
  options: EditFromJsonOptions = {}
): Promise<EditResult> {
  const { jsonMode = true } = options;

  // Parse JSON input
  let patchData: Record<string, unknown>;
  try {
    patchData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(error);
  }

  // Parse existing note
  const { frontmatter, body } = await parseNote(filePath);

  // Resolve type path from existing frontmatter
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) {
    const error = 'Could not determine note type from frontmatter';
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(error);
  }

  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    const error = `Unknown type path: ${typePath}`;
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(error);
  }

  // Merge patch data into existing frontmatter
  const mergedFrontmatter = mergeFrontmatter(frontmatter, patchData);
  const updatedFields = Object.keys(patchData).filter(k => patchData[k] !== undefined);

  // Normalize date-like fields to canonical YYYY-MM-DD strings
  const normalizedFrontmatter = normalizeDateFields(schema, typePath, mergedFrontmatter);

  // Validate merged result
  const validation = validateFrontmatter(schema, typePath, normalizedFrontmatter);
  if (!validation.valid) {
    if (jsonMode) {
      printJson({
        success: false,
        error: 'Validation failed',
        errors: validation.errors.map(e => ({
          field: e.field,
          message: e.message,
          currentValue: frontmatter[e.field],
          ...(e.value !== undefined && { value: e.value }),
          ...(e.expected !== undefined && { expected: e.expected }),
          ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
        })),
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(`Validation failed: ${validation.errors.map(e => e.message).join(', ')}`);
  }

  // Validate context fields (source type constraints)
  const contextValidation = await validateContextFields(schema, vaultDir, typePath, normalizedFrontmatter);
  if (!contextValidation.valid) {
    if (jsonMode) {
      printJson({
        success: false,
        error: 'Context field validation failed',
        errors: contextValidation.errors.map(e => ({
          type: e.type,
          field: e.field,
          message: e.message,
          currentValue: frontmatter[e.field],
          ...(e.value !== undefined && { value: e.value }),
          ...(e.expected !== undefined && { expected: e.expected }),
        })),
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(`Context validation failed: ${contextValidation.errors.map(e => e.message).join(', ')}`);
  }

  // Validate parent field doesn't create a cycle (for recursive types)
  if (typeDef.recursive && normalizedFrontmatter['parent']) {
    const noteName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
    const cycleError = await validateParentNoCycle(
      schema,
      vaultDir,
      noteName,
      normalizedFrontmatter['parent'] as string
    );
    if (cycleError) {
      if (jsonMode) {
        printJson({
          success: false,
          error: cycleError.message,
          errors: [{
            field: cycleError.field,
            message: cycleError.message,
          }],
        });
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      throw new Error(cycleError.message);
    }
  }

  // Get field order
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(normalizedFrontmatter);

  // Write updated note
  await writeNote(filePath, normalizedFrontmatter, body, orderedFields);

  return { updatedFields, path: filePath };
}

// ============================================================================
// Interactive Edit Mode
// ============================================================================

/**
 * Edit an existing note's frontmatter interactively.
 * 
 * @param schema - Loaded schema
 * @param vaultDir - Vault directory path
 * @param filePath - Absolute path to the note file
 * @param options - Edit options
 */
export async function editNoteInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  filePath: string,
  options: EditInteractiveOptions = {}
): Promise<void> {
  const { checkSections = true } = options;
  
  const { frontmatter, body } = await parseNote(filePath);
  const fileName = filePath.split('/').pop() ?? filePath;

  printInfo(`\n=== Editing: ${fileName} ===`);

  // Resolve type path from frontmatter
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) {
    printWarning('Warning: Unknown type, showing raw frontmatter edit');
    console.log('Current frontmatter:');
    console.log(JSON.stringify(frontmatter, null, 2));
    return;
  }

  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printWarning(`Warning: Unknown type path: ${typePath}`);
    return;
  }

  printInfo(`Type path: ${typePath}\n`);

  // Edit frontmatter fields
  const newFrontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);

  // Determine actual field order
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    const currentValue = frontmatter[fieldName];
    const newValue = await promptFieldEdit(
      schema,
      vaultDir,
      fieldName,
      field,
      currentValue
    );

    if (newValue !== undefined) {
      newFrontmatter[fieldName] = newValue;
    }
  }

  // Check for missing body sections
  let updatedBody = body;
  const bodySections = typeDef.bodySections;
  if (checkSections && bodySections && bodySections.length > 0) {
    const addSections = await promptConfirm('\nCheck for missing sections?');
    if (addSections === null) {
      throw new UserCancelledError();
    }
    if (addSections) {
      updatedBody = await addMissingSections(body, bodySections);
    }
  }

  // Write updated file
  await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
  printSuccess(`\n✓ Updated: ${filePath}`);
}

// ============================================================================
// Helpers
// ============================================================================

function mergeFrontmatter(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...existing };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // Remove field
      delete result[key];
    } else {
      // Overwrite field
      result[key] = value;
    }
  }

  return result;
}

/**
 * Prompt for editing a single frontmatter field.
 * Throws UserCancelledError if user cancels any prompt.
 */
async function promptFieldEdit(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field,
  currentValue: unknown
): Promise<unknown> {
  const currentStr = formatCurrentValue(currentValue);

  // Static value - keep current or use static default
  if (field.value !== undefined) {
    if (currentValue !== undefined && currentValue !== '') {
      return currentValue;
    }
    return expandStaticValue(field.value, new Date(), schema.config.dateFormat);
  }

  console.log(`Current ${fieldName}: ${currentStr}`);

  // Prompt-based value
  switch (field.prompt) {
    case 'select': {
      if (!field.options || field.options.length === 0) return currentValue;
      const selectOptions = field.options;
      
      // Multi-select mode
      if (field.multiple) {
        // Convert current value to array for display
        const currentArr = Array.isArray(currentValue) ? currentValue : 
          (currentValue ? [String(currentValue)] : []);
        console.log(`Current ${fieldName}: ${currentArr.length > 0 ? currentArr.join(', ') : '(none)'}`);
        
        const selected = await promptMultiSelect(`New ${fieldName}:`, selectOptions);
        if (selected === null) {
          throw new UserCancelledError();
        }
        // Return current value if nothing selected (keep current)
        return selected.length > 0 ? selected : currentValue;
      }
      
      // Single-select mode
      // Add a "keep current" option at the top
      const keepLabel = '(keep current)';
      const options = [keepLabel, ...selectOptions];
      
      const selected = await promptSelection(`New ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected keep current, return the existing value
      if (selected === keepLabel) {
        return currentValue;
      }
      return selected;
    }

    case 'relation': {
      if (!field.source) return currentValue;
      const dynamicOptions = await queryByType(schema, vaultDir, field.source, field.filter);
      if (dynamicOptions.length === 0) {
        return currentValue;
      }
      
      // Add a "keep current" option at the top
      const keepLabel = '(keep current)';
      const options = [keepLabel, ...dynamicOptions];
      
      const selected = await promptSelection(`New ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected keep current, return the existing value
      if (selected === keepLabel) {
        return currentValue;
      }
      return formatValue(selected, schema.config.linkFormat);
    }

    case 'text': {
      const label = field.label ?? fieldName;
      const currentDefault = typeof currentValue === 'string' ? currentValue : '';
      const newValue = await promptInput(`New ${label} (or Enter to keep)`, currentDefault);
      if (newValue === null) {
        throw new UserCancelledError();
      }
      return newValue || currentValue;
    }

    case 'boolean': {
      const label = field.label ?? fieldName;
      const currentBool = currentValue === true || currentValue === 'true';
      const displayCurrent = currentBool ? 'yes' : 'no';
      printInfo(`Current ${label}: ${displayCurrent}`);
      const result = await promptConfirm(`New ${label}`);
      if (result === null) {
        throw new UserCancelledError();
      }
      return result;
    }

    case 'number': {
      const label = field.label ?? fieldName;
      const currentNum = typeof currentValue === 'number' ? currentValue : parseFloat(String(currentValue));
      const displayCurrent = isNaN(currentNum) ? '<empty>' : String(currentNum);
      // Loop until valid input
      while (true) {
        const newValue = await promptInput(`New ${label} (or Enter to keep "${displayCurrent}")`);
        if (newValue === null) {
          throw new UserCancelledError();
        }
        if (newValue === '') {
          return currentValue;
        }
        const parsed = parseFloat(newValue);
        if (isNaN(parsed)) {
          printWarning(`Invalid number: "${newValue}". Please enter a valid number.`);
          continue;
        }
        return parsed;
      }
    }

    default:
      return currentValue;
  }
}

/**
 * Format current value for display.
 */
function formatCurrentValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '<empty>';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

/**
 * Check for missing sections and offer to add them.
 * Throws UserCancelledError if user cancels any prompt.
 */
async function addMissingSections(
  body: string,
  sections: BodySection[]
): Promise<string> {
  let updatedBody = body;

  for (const section of sections) {
    const level = section.level ?? 2;
    const prefix = '#'.repeat(level);
    const pattern = new RegExp(`^${prefix} ${section.title}`, 'm');

    if (!pattern.test(body)) {
      printWarning(`Missing section: ${section.title}`);
      const addIt = await promptConfirm('Add it?');
      if (addIt === null) {
        throw new UserCancelledError();
      }
      if (addIt) {
        const newSection = generateBodySections([section]);
        updatedBody += '\n' + newSection;
      }
    }
  }

  return updatedBody;
}

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
import {
  isBodySectionPresent,
  flattenBodySections,
  type FlatBodySection,
} from './audit/body-sections.js';
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
  normalizeDateFields,
  applyDefaults,
} from './validation.js';
import { isBlankScalar } from './emptiness.js';
import { validateParentNoCycle } from './hierarchy.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from './output.js';
import { type LoadedSchema, type Field, type BodySection, getOptionValues } from '../types/schema.js';
import { UserCancelledError } from './errors.js';
import { expandStaticValue } from './local-date.js';
import { prepareRecurrenceFastPath, commitRecurrenceFastPath } from './recurrence-fast-path.js';

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

  // Disallow editing system-managed fields
  if ('id' in patchData && patchData['id'] !== undefined) {
    const error = "Field 'id' is system-managed and cannot be modified";
    if (jsonMode) {
      printJson(jsonError(error, {
        errors: [{ field: 'id', value: patchData['id'], message: error }],
      }));
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

  const patchValidation = validateFrontmatter(schema, typePath, patchData, { strictFields: true });
  const unknownPatchErrors = patchValidation.errors.filter(error => error.type === 'unknown_field');
  if (unknownPatchErrors.length > 0) {
    if (jsonMode) {
      printJson({
        success: false,
        error: 'Validation failed',
        errors: unknownPatchErrors.map(e => ({
          field: e.field,
          message: e.message,
          ...(e.value !== undefined && { value: e.value }),
          ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
        })),
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(`Validation failed: ${unknownPatchErrors.map(e => e.message).join(', ')}`);
  }

  // Merge patch data into existing frontmatter
  const mergedFrontmatter = mergeFrontmatter(frontmatter, patchData);
  const updatedFields = Object.keys(patchData).filter(k => patchData[k] !== undefined);

  // Normalize date-like fields to canonical YYYY-MM-DD strings
  const normalizedFrontmatter = normalizeDateFields(schema, typePath, mergedFrontmatter);

  // Materialize defaults BEFORE validating/writing — but ONLY for the parity
  // case, SURGICALLY scoped to the keys the user blanked in THIS patch.
  //
  // The write↔audit parity bug (#707): a blank (incl. whitespace-only) value for
  // a key whose field HAS a `default`/`value` passes validation —
  // `validateFrontmatter` treats it as "unset → satisfied by the default" — but
  // the blank would be PERSISTED, so `audit` then flags `empty-string-required`:
  // write says OK, audit says broken. Materializing the default for that key makes
  // write and audit agree.
  //
  // A BLANKET `applyDefaults` over the whole merged frontmatter over-corrects in
  // two ways, so we scope instead:
  //   1. Explicit removal (`{"field": null}`) is the documented way to delete a
  //      field. `mergeFrontmatter` deletes it; a blanket default would write it
  //      straight back. We EXCLUDE null (isBlankScalar is true for null, so we
  //      filter on a blank STRING specifically) → removal is preserved.
  //   2. An edit must not materialize defaults for fields the user never touched.
  //      Scoping to user-patch keys leaves untouched fields alone.
  //
  // Keys the user blanked but whose field has NO default stay blank: optional →
  // unset (trim-everywhere preserved), required → still rejected at validation.
  const blankPatchKeys = new Set(
    Object.keys(patchData).filter(
      (key) => typeof patchData[key] === 'string' && isBlankScalar(patchData[key])
    )
  );
  const resolvedFrontmatter = applyDefaults(
    schema,
    typePath,
    normalizedFrontmatter,
    blankPatchKeys
  );

  // Validate merged result
  const validation = validateFrontmatter(schema, typePath, resolvedFrontmatter);
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
  const contextValidation = await validateContextFields(schema, vaultDir, typePath, resolvedFrontmatter);
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
  if (typeDef.recursive && resolvedFrontmatter['parent']) {
    const noteName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
    const cycleError = await validateParentNoCycle(
      schema,
      vaultDir,
      noteName,
      resolvedFrontmatter['parent'] as string
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
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(resolvedFrontmatter);

  // Recurrence fast path (atomicity, #107): VALIDATE + COMPUTE the successor
  // BEFORE mutating the predecessor. If this completion would spawn a successor
  // but the spawn can't succeed (missing template, partial/unparseable offset
  // base), prepare throws here and we abort WITHOUT writing the predecessor —
  // never leaving it `done` with no successor.
  const fastPathPlan = await prepareRecurrenceFastPath(
    schema,
    vaultDir,
    typeDef.name,
    filePath,
    frontmatter,
    resolvedFrontmatter,
    body
  );

  // Write updated note (predecessor status change is now safe to commit).
  await writeNote(filePath, resolvedFrontmatter, body, orderedFields);

  // Commit the prepared spawn (create successor + back-link `next`). Identical
  // result to the audit backstop, which shares the same engine.
  await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);

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

  // Recurrence fast path (atomicity, #107): VALIDATE + COMPUTE before mutating
  // the predecessor (see editNoteFromJson). Interactive edit reconstructs the
  // full frontmatter, so `frontmatter` (read at the top) is the old state.
  const fastPathPlan = await prepareRecurrenceFastPath(
    schema,
    vaultDir,
    typeDef.name,
    filePath,
    frontmatter,
    newFrontmatter,
    updatedBody
  );

  // Write updated file (predecessor change is now safe to commit).
  await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
  printSuccess(`\n✓ Updated: ${filePath}`);

  // Commit the prepared spawn.
  const fastPath = await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
  if (fastPath.successorPath) {
    printSuccess(`✓ Spawned recurrence successor: ${fastPath.successorPath}`);
  }
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
      const selectOptions = getOptionValues(field.options);
      
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
 * Collect the declared body-section headings missing from `body`, in tree order.
 *
 * Recurses the FULL `body_sections` tree (top-level AND nested children) via the
 * shared {@link flattenBodySections} tree-walk that the audit
 * `missing-body-section` detector uses, so `edit`'s candidate set agrees with
 * audit's missing-section set (#697). A declared child heading whose parent is
 * already present is still reported (at its own declared level) — previously
 * such a child was skipped because `edit` only iterated top-level sections and
 * emitted children solely via the parent's scaffold. Presence is checked with
 * the shared {@link isBodySectionPresent} helper (#653), so present headings
 * (incl. trailing-ws / ATX-closing-`##` / code-fenced-not-counted) are not
 * reported.
 */
export function collectMissingBodySections(
  body: string,
  sections: BodySection[]
): FlatBodySection[] {
  return flattenBodySections(sections).filter(
    ({ title, level }) => !isBodySectionPresent(body, level, title)
  );
}

/**
 * Append a single declared heading's scaffold to `body`, WITHOUT its children
 * (children are appended on their own turn in the tree-walk). Mirrors the audit
 * auto-fix (`applyBodySectionFix`) spacing/placement so `edit` and `audit`
 * produce consistent output, and so re-running adds nothing (idempotent — the
 * caller re-checks presence against the growing body before each append).
 */
export function appendBodySection(body: string, section: BodySection): string {
  const sectionScaffold = generateBodySections([{ ...section, children: undefined }]);
  const existing = body.replace(/\s*$/, '');
  return existing.length > 0 ? `${existing}\n\n${sectionScaffold}` : sectionScaffold;
}

/**
 * Check for missing sections and offer to add them.
 * Throws UserCancelledError if user cancels any prompt.
 *
 * Iterates the shared tree-walk so it agrees with audit (#697); for each missing
 * heading it prompts, then appends just that heading. The presence re-check runs
 * against the growing `updatedBody`, so a heading is never duplicated within a
 * single run.
 */
async function addMissingSections(
  body: string,
  sections: BodySection[]
): Promise<string> {
  let updatedBody = body;

  for (const { section, title, level } of flattenBodySections(sections)) {
    if (isBodySectionPresent(updatedBody, level, title)) continue;

    printWarning(`Missing section: ${title}`);
    const addIt = await promptConfirm('Add it?');
    if (addIt === null) {
      throw new UserCancelledError();
    }
    if (addIt) {
      updatedBody = appendBodySection(updatedBody, section);
    }
  }

  return updatedBody;
}

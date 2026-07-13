/**
 * Shared edit logic for frontmatter editing.
 * 
 * This module contains the core editing functions used by both:
 * - `edit` command (standalone)
 * - `search --edit` (unified interface)
 */

import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import {
  getTypeDefByPath,
  resolveTypePathFromFrontmatter,
  getFieldsForType,
  getFrontmatterOrder,
} from './schema.js';
import { parseNote, writeNote, writeFileAtomic, generateBodySections } from './frontmatter.js';
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
import { ConcurrentNoteModificationError, UserCancelledError } from './errors.js';
import { expandStaticValue } from './local-date.js';
import { prepareRecurrenceFastPath, commitRecurrenceFastPath } from './recurrence-fast-path.js';
import { validateRelativeDateCalendarOffsetsForWrite } from './relative-date.js';
import { isBwrbReservedFrontmatterField } from './frontmatter/systemFields.js';
import { withLineageMutationLocks } from './lineage-lock.js';
import { assertNoteBytesUnchanged } from './note-write-concurrency.js';
import { assertExpectedRevision, noteRevision } from './note-revision.js';
import { assertTransitionGuards, transitionGuardTargetPaths } from './transition-guards.js';
import { commitTransitionEffects, prepareTransitionEffects, rollbackTransitionEffects, transitionEffectTargetPaths } from './transition-effects.js';

// ============================================================================
// Types
// ============================================================================

export interface EditResult {
  updatedFields: string[];
  path: string;
  revision: string;
}

export interface EditFromJsonOptions {
  /** Whether to output errors as JSON */
  jsonMode?: boolean;
  /** Opaque raw-note revision that must still match before this patch writes. */
  expectedRevision?: string;
  /**
   * Internal, opt-in mutation boundary observer used by deterministic fault
   * fixtures. It is deliberately not wired to the CLI: production callers get
   * the same behavior unless they explicitly supply it.
   */
  mutationFaultInjector?: MutationFaultInjector;
}

/** Explicitly named commit boundaries for mutation fault fixtures. */
export type MutationFaultPoint =
  | 'source-read'
  | 'expected-revision-check'
  | 'lock-acquisition'
  | 'guard-evaluation'
  | 'source-write'
  | 'related-effects'
  | 'recurrence'
  | 'compensation';

export interface MutationFaultInjector {
  before?: (point: MutationFaultPoint) => Promise<void> | void;
  after?: (point: MutationFaultPoint) => Promise<void> | void;
}

export interface EditInteractiveOptions {
  /** Whether to check for missing body sections */
  checkSections?: boolean;
  /** Internal dependency hook for deterministic commit-race tests. */
  beforeCommit?: () => Promise<void>;
}

const JSON_EDIT_ATTEMPTS = 3;

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
  const { jsonMode = true, expectedRevision, mutationFaultInjector } = options;

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
  const reservedField = Object.keys(patchData).find(isBwrbReservedFrontmatterField);
  if (reservedField) {
    const error = `Field '${reservedField}' is system-managed and cannot be modified`;
    if (jsonMode) {
      printJson(jsonError(error, {
        errors: [{ field: reservedField, value: patchData[reservedField], message: error }],
      }));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(error);
  }

  // A guarded caller must reread and reconsider a stale patch; replaying it
  // against unseen bytes would defeat the revision precondition.
  const attempts = expectedRevision === undefined ? JSON_EDIT_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await editNoteFromJsonAttempt(
        schema,
        vaultDir,
        filePath,
        patchData,
        jsonMode,
        attempt,
        expectedRevision,
        mutationFaultInjector
      );
    } catch (error) {
      if (
        error instanceof ConcurrentNoteModificationError &&
        attempt < attempts
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new ConcurrentNoteModificationError(filePath, attempts);
}

async function editNoteFromJsonAttempt(
  schema: LoadedSchema,
  vaultDir: string,
  filePath: string,
  patchData: Record<string, unknown>,
  jsonMode: boolean,
  attempt: number,
  expectedRevision: string | undefined,
  mutationFaultInjector: MutationFaultInjector | undefined
): Promise<EditResult> {

  // Parse existing note
  await injectMutationFault(mutationFaultInjector, 'before', 'source-read');
  const { frontmatter, body, raw } = await parseNote(filePath);
  await injectMutationFault(mutationFaultInjector, 'after', 'source-read');

  if (expectedRevision !== undefined) {
    await injectMutationFault(mutationFaultInjector, 'before', 'expected-revision-check');
    assertExpectedRevision(expectedRevision, raw);
    await injectMutationFault(mutationFaultInjector, 'after', 'expected-revision-check');
  }

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
  const fields = getFieldsForType(schema, typePath);
  const blankPatchKeys = new Set(
    Object.keys(patchData).filter((key) => {
      if (typeof patchData[key] !== 'string' || !isBlankScalar(patchData[key])) return false;
      // Plain prompt:list fields must validate as arrays on write (#742). Do
      // not let a default such as [] hide a user-supplied scalar patch before
      // validation gets to enforce the same shape audit expects.
      return fields[key]?.prompt !== 'list';
    })
  );
  const defaultedFrontmatter = applyDefaults(
    schema,
    typePath,
    mergedFrontmatter,
    blankPatchKeys
  );

  // Normalize date-like fields to canonical YYYY-MM-DD strings — AFTER defaults
  // are materialized (#707). A materialized date default can be non-canonical
  // (e.g. `default: "12/25/2026"`); `validateFrontmatter` accepts the slash form,
  // so without normalizing it here the raw default would be PERSISTED and `audit`
  // would then flag `invalid-date-format`. Running the single date-normalization
  // pass after `applyDefaults` canonicalizes BOTH user-supplied date values and
  // any date default we just filled in, so write and audit agree on the stored
  // form. (Mirrors `new`/json-mode, which materializes defaults before building
  // the note.)
  const resolvedFrontmatter = normalizeDateFields(schema, typePath, defaultedFrontmatter);

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

  const relativeDateDiagnostics = await validateRelativeDateCalendarOffsetsForWrite(
    schema,
    vaultDir,
    typePath,
    resolvedFrontmatter,
    relative(vaultDir, filePath)
  );
  if (relativeDateDiagnostics.length > 0) {
    if (jsonMode) {
      printJson({
        success: false,
        error: 'Validation failed',
        errors: relativeDateDiagnostics.map(diagnostic => ({
          field: diagnostic.field,
          message: diagnostic.message,
          currentValue: frontmatter[diagnostic.field],
          value: resolvedFrontmatter[diagnostic.field],
        })),
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(`Validation failed: ${relativeDateDiagnostics.map(diagnostic => diagnostic.message).join(', ')}`);
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

  await injectMutationFault(mutationFaultInjector, 'before', 'guard-evaluation');
  await assertTransitionGuards(schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter);
  await injectMutationFault(mutationFaultInjector, 'after', 'guard-evaluation');
  const guardTargetPaths = await transitionGuardTargetPaths(
    schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter
  );
  const transitionEffects = await prepareTransitionEffects(
    schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter, filePath
  );

  await waitForEditCommitBarrier(attempt, filePath);

  await injectMutationFault(mutationFaultInjector, 'before', 'lock-acquisition');
  const revision = await withLineageMutationLocks(vaultDir, [filePath, ...guardTargetPaths, ...transitionEffectTargetPaths(transitionEffects)], async () => {
    await injectMutationFault(mutationFaultInjector, 'after', 'lock-acquisition');
    if (expectedRevision !== undefined) {
      // Re-read while holding the shared mutation lock, closing the
      // validation-to-write race with other Bowerbird writers.
      await injectMutationFault(mutationFaultInjector, 'before', 'expected-revision-check');
      assertExpectedRevision(expectedRevision, await readFile(filePath, 'utf-8'));
      await injectMutationFault(mutationFaultInjector, 'after', 'expected-revision-check');
    }
    await assertNoteBytesUnchanged(filePath, raw, attempt);
    for (const effect of transitionEffects) await assertNoteBytesUnchanged(effect.path, effect.raw, attempt);
    // Relation state can change after validation. Re-evaluate immediately
    // before the source write while its mutation lock is held.
    await injectMutationFault(mutationFaultInjector, 'before', 'guard-evaluation');
    await assertTransitionGuards(schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter);
    await injectMutationFault(mutationFaultInjector, 'after', 'guard-evaluation');

    // Recurrence prepare, predecessor write, and successor/back-link commit are
    // one guarded commit phase. A retry always re-prepares from fresh bytes.
    await injectMutationFault(mutationFaultInjector, 'before', 'recurrence');
    const fastPathPlan = await prepareRecurrenceFastPath(
      schema,
      vaultDir,
      typeDef.name,
      filePath,
      frontmatter,
      resolvedFrontmatter,
      body
    );
    await injectMutationFault(mutationFaultInjector, 'after', 'recurrence');
    let writtenSource = '';
    let committedEffects;
    try {
      await injectMutationFault(mutationFaultInjector, 'before', 'source-write');
      await writeNote(filePath, resolvedFrontmatter, body, orderedFields);
      writtenSource = await readFile(filePath, 'utf-8');
      await injectMutationFault(mutationFaultInjector, 'after', 'source-write');
      await injectMutationFault(mutationFaultInjector, 'before', 'related-effects');
      committedEffects = await commitTransitionEffects(transitionEffects);
      await injectMutationFault(mutationFaultInjector, 'after', 'related-effects');
      await injectMutationFault(mutationFaultInjector, 'before', 'recurrence');
      await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
      await injectMutationFault(mutationFaultInjector, 'after', 'recurrence');
      return noteRevision(await readFile(filePath, 'utf-8'));
    } catch (error) {
      // Restore only the exact source bytes this invocation wrote. A newer
      // writer wins; it must never be erased by our compensating rollback.
      await injectMutationFault(mutationFaultInjector, 'before', 'compensation');
      if (await readFile(filePath, 'utf-8').catch(() => '') === writtenSource) {
        await writeFileAtomic(filePath, raw);
      }
      if (committedEffects) await rollbackTransitionEffects(committedEffects);
      await injectMutationFault(mutationFaultInjector, 'after', 'compensation');
      throw error;
    }
  });

  return {
    updatedFields,
    path: filePath,
    revision,
  };
}

async function injectMutationFault(
  injector: MutationFaultInjector | undefined,
  phase: 'before' | 'after',
  point: MutationFaultPoint
): Promise<void> {
  await injector?.[phase]?.(point);
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
  const { checkSections = true, beforeCommit } = options;
  
  const { frontmatter, body, raw } = await parseNote(filePath);
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
  // Preserve system-managed fields without offering them as editable schema
  // input, even if a vault schema happens to declare a same-named field.
  const newFrontmatter: Record<string, unknown> = Object.fromEntries(
    Object.entries(frontmatter).filter(([fieldName]) =>
      isBwrbReservedFrontmatterField(fieldName)
    )
  );
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);

  // Determine actual field order
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  for (const fieldName of orderedFields) {
    if (isBwrbReservedFrontmatterField(fieldName)) continue;
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

  await beforeCommit?.();
  await assertTransitionGuards(schema, vaultDir, typeDef.name, frontmatter, newFrontmatter);
  const guardTargetPaths = await transitionGuardTargetPaths(
    schema, vaultDir, typeDef.name, frontmatter, newFrontmatter
  );
  const transitionEffects = await prepareTransitionEffects(
    schema, vaultDir, typeDef.name, frontmatter, newFrontmatter, filePath
  );
  const fastPath = await withLineageMutationLocks(vaultDir, [filePath, ...guardTargetPaths, ...transitionEffectTargetPaths(transitionEffects)], async () => {
    await assertNoteBytesUnchanged(filePath, raw);
    for (const effect of transitionEffects) await assertNoteBytesUnchanged(effect.path, effect.raw);
    await assertTransitionGuards(schema, vaultDir, typeDef.name, frontmatter, newFrontmatter);
    const fastPathPlan = await prepareRecurrenceFastPath(
      schema,
      vaultDir,
      typeDef.name,
      filePath,
      frontmatter,
      newFrontmatter,
      updatedBody
    );
    await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
    const writtenSource = await readFile(filePath, 'utf-8');
    let committedEffects;
    try {
      committedEffects = await commitTransitionEffects(transitionEffects);
      return await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
    } catch (error) {
      if (await readFile(filePath, 'utf-8').catch(() => '') === writtenSource) {
        await writeFileAtomic(filePath, raw);
      }
      if (committedEffects) await rollbackTransitionEffects(committedEffects);
      throw error;
    }
  });
  printSuccess(`\n✓ Updated: ${filePath}`);
  if (fastPath.successorPath) {
    printSuccess(`✓ Spawned recurrence successor: ${fastPath.successorPath}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** File handshake used only by cross-process race tests. */
async function waitForEditCommitBarrier(attempt: number, filePath: string): Promise<void> {
  if (process.env.BWRB_TEST_EDIT_BARRIER_ENABLED !== '1') return;
  const barrierDir = process.env.BWRB_TEST_EDIT_BARRIER_DIR;
  if (!barrierDir) return;

  await mkdir(barrierDir, { recursive: true });
  const readyPath = join(barrierDir, `edit-read-${attempt}.ready`);
  const commitPath = join(barrierDir, `edit-commit-${attempt}.go`);
  await writeFile(readyPath, `${filePath}\n`, 'utf-8');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(commitPath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for edit test barrier: ${commitPath}`);
}

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

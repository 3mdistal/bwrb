You are completing a PR readiness review after the same exact-model full-diff review was truncated. The prior review content is embedded below. It started NO BLOCKERS, completed SPEC FIDELITY, and identified one docs ambiguity plus remaining non-blocking risk analysis before truncation. That docs ambiguity is now fixed. Review the bounded high-risk code/tests and follow-up delta below, especially concurrency windows, rollback clobber risk, recurrence lock scope, output mapping, and the explicit test barrier gate.

Constraints:
- No tools or edits.
- Start with exactly one of BLOCKERS, NON-BLOCKING, or NO BLOCKERS.
- Separate SPEC FIDELITY and STANDARDS AND RISK.
- Treat this as the final PR gate.
- Block only concrete correctness/data-loss/spec/repo-policy defects.
- Do not re-flag the user-required .task-sweep artifacts.
- Maximum 450 words. Finish the answer.

Task: BWRB #820 prevents ordinary edit from overwriting concurrent new --fork ID backfill or lineage-adopt ID/forked-from writes. JSON has 3 total attempts (initial plus at most 2 retries); interactive stale answers are not replayed. Unsafe conflict returns numeric code 2 with reason/retryable/path/attempts. Exact bytes, system immutability, recurrence, rollback safety, docs, and deterministic edit-vs-fork/adopt coverage are required. Scope excludes other writers.

Verified evidence:
- Node22 exact parity 3037 pass/3 skip, build/package/typecheck/lint/knip.
- independent tester PASS: 593 focused/repeated assertions; concurrency suite 5x source + 5x built dist; real built edit/adopt race; audit/lineage clean; exact bodies and reserved field rejection; docs gates/build.
- Windows Lock Tests green on the draft implementation commit.
- follow-up docs/test-hook commit passed Node22 typecheck/lint/knip, concurrency 6/6, all docs gates/build.
- External unrelated editors cannot take BWRB locks; docs state the remaining tiny check-to-rename window honestly.

PRIOR TRUNCATED REVIEW:
NO BLOCKERS

## SPEC FIDELITY

All five acceptance criteria are substantively met by the embedded diff:

1. **Conflict detection** — `src/lib/note-write-concurrency.ts` provides `assertNoteBytesUnchanged`, wired into edit's guarded commit (`src/lib/edit.ts:351-368, 462-474`), fork source-ID backfill (`src/new/fork.ts:216`), and adopt's pre-write phase (`src/commands/lineage/adopt.ts:273-282`). Edit's barrier/lock ordering is correct: the read/validation is unlocked, the lock is taken only for the commit phase, and interactive prompts (and the test barrier) occur *before* lock acquisition — consistent with "do not hold lineage locks across human prompts."
2. **Stable typed output** — `ConcurrentNoteModificationError` maps to numeric `code: 2` + `data.{reason,retryable,path,attempts}` in edit, new, search, and lineage adopt handlers.
3. **Race coverage** — `tests/ts/commands/edit-lineage-concurrency.test.ts` covers edit-vs-fork replay, edit-vs-adopt replay, JSON/text retry exhaustion, search --edit mapping, and interactive stale; `lineage-adopt.test.ts:268` covers the newer-writer rollback guard.
4. **Byte invariants** — replay tests verify BOM/CRLF/comment/provider preservation via sequential-edit byte equality; adopt rollback only restores over its own bytes.
5. Suite green claims are evidence-only; consistent with the diff.

Spec-fidelity notes (non-blocking):
- **Doc drift on retry count**: implementation is 3 total attempts (`JSON_EDIT_ATTEMPTS = 3`, loop at `src/lib/edit.ts:127`), i.e. 2 replays after the first attempt. `docs-site/.../json-mode.md` ("retries internally up to three times"), `edit.md` ("replayed ... up to three times"), and `SKILL.md` ("replay from fresh bytes up to three times") all imply 3 replays. `data.attempts: 3` is accurate; the prose is not. Suggest "up to three attempts."
- `.task-sweep/logs` plan artifacts are asserted committed but excluded from the packet; unverifiable here — accept per spec statement, but the merge gate should confirm they exist at the manifest paths.

## STANDARDS AND RISK

Non-blocking items, roughly in priority order:

1. **Test seam in production code** (`src/lib/edit.ts:487-506`): `waitForEditCommitBarrier` is env-activated (`BWRB_TEST_EDIT_BARRIER_DIR`) in the shipped JSON edit path with a 20s poll loop, plus the `beforeCommit` hook in the public `EditInteractiveOptions` interface (`src/lib/edit.ts:72`). If the env var leaks into a real environment, every JSON edit hangs up to 20s per attempt and then fails. Consider prefix-validating the dir or gating on an explicit test marker; at minimum document it as test-only.
2. **"Exact raw-byte" is actually UTF-8-string comparison** (`note-write-concurrency.

BOUND HIGH-RISK PACKET:
## errors/concurrency
```
    super('User cancelled');
    this.name = 'UserCancelledError';
  }
}

/**
 * A note changed after a command's authoritative read but before its guarded
 * write. Callers must retry from a fresh snapshot rather than overwriting the
 * newer bytes.
 */
export class ConcurrentNoteModificationError extends Error {
  readonly path: string;
  readonly attempts: number;

  constructor(path: string, attempts = 1) {
    super('Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.');
    this.name = 'ConcurrentNoteModificationError';
    this.path = path;
    this.attempts = attempts;
  }
}
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { ConcurrentNoteModificationError } from './errors.js';
import { writeFileAtomic } from './frontmatter.js';

/** Assert that a note still has the exact bytes used to prepare a mutation. */
export async function assertNoteBytesUnchanged(
  filePath: string,
  expectedRaw: string,
  attempts = 1
): Promise<void> {
  const currentRaw = await readFile(filePath, 'utf-8');
  if (currentRaw !== expectedRaw) {
    throw new ConcurrentNoteModificationError(filePath, attempts);
  }
}

/**
 * Restore a prior snapshot only when the file still contains this command's
 * own write. A newer writer always wins; rollback must never erase it.
 */
export async function rollbackNoteIfUnchanged(
  filePath: string,
  writtenRaw: string,
  originalRaw: string
): Promise<boolean> {
  const currentRaw = await readFile(filePath, 'utf-8');
  if (currentRaw !== writtenRaw) return false;
  await writeFileAtomic(filePath, originalRaw);
  return true;
}

/** Stable agent-facing details shared by every guarded note writer. */
export function concurrentModificationData(
  vaultDir: string,
  error: ConcurrentNoteModificationError
): { reason: string; retryable: true; path: string; attempts: number } {
  return {
    reason: 'note-modified-concurrently',
    retryable: true,
    path: relative(vaultDir, error.path).replace(/\\/g, '/'),
    attempts: error.attempts,
  };
}

```

## edit core
```
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

  for (let attempt = 1; attempt <= JSON_EDIT_ATTEMPTS; attempt++) {
    try {
      return await editNoteFromJsonAttempt(
        schema,
        vaultDir,
        filePath,
        patchData,
        jsonMode,
        attempt
      );
    } catch (error) {
      if (
        error instanceof ConcurrentNoteModificationError &&
        attempt < JSON_EDIT_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new ConcurrentNoteModificationError(filePath, JSON_EDIT_ATTEMPTS);
}

async function editNoteFromJsonAttempt(
  schema: LoadedSchema,
  vaultDir: string,
  filePath: string,
  patchData: Record<string, unknown>,
  jsonMode: boolean,
  attempt: number
): Promise<EditResult> {

  // Parse existing note
  const { frontmatter, body, raw } = await parseNote(filePath);

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

  await waitForEditCommitBarrier(attempt, filePath);

  await withLineageMutationLocks(vaultDir, [filePath], async () => {
    await assertNoteBytesUnchanged(filePath, raw, attempt);

    // Recurrence prepare, predecessor write, and successor/back-link commit are
    // one guarded commit phase. A retry always re-prepares from fresh bytes.
    const fastPathPlan = await prepareRecurrenceFastPath(
      schema,
      vaultDir,
      typeDef.name,
      filePath,
      frontmatter,
      resolvedFrontmatter,
      body
    );
    await writeNote(filePath, resolvedFrontmatter, body, orderedFields);
    await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
  });

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
  const fastPath = await withLineageMutationLocks(vaultDir, [filePath], async () => {
    await assertNoteBytesUnchanged(filePath, raw);
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
    return commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
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

```

## fork/adopt
```
  schema: LoadedSchema,
  vaultDir: string,
  sourcePath: string
): Promise<string> {
  return withNoteIdAssignmentLock(vaultDir, async () => {
    const parsed = await parseNote(sourcePath);
    const existing = parsed.frontmatter.id;
    if (existing !== undefined) {
      if (!isValidNoteId(existing)) {
        throw new Error(`Fork source has an invalid id and was not modified: ${relative(vaultDir, sourcePath)}`);
      }
      await assertSourceIdUnique(schema, vaultDir, sourcePath, existing);
      return existing;
    }

    const id = await generateUniqueNoteId(vaultDir);
    const collisions = await findNotesWithId(schema, vaultDir, id);
    if (collisions.length > 0) {
      throw new Error('Generated source ID collides with an existing note; retry the command.');
    }
    const nextRaw = insertFrontmatterScalarPreservingBytes(parsed.raw, 'id', id);
    await assertNoteBytesUnchanged(sourcePath, parsed.raw);
    await writeFileAtomic(sourcePath, nextRaw);
    try {
      await registerIssuedNoteId(vaultDir, id, sourcePath);
    } catch (error) {
      const rolledBack = await rollbackNoteIfUnchanged(sourcePath, nextRaw, parsed.raw);
      if (!rolledBack) {
        throw new Error(
          `Source ID registration failed (${formatError(error)}) and rollback was skipped because ` +
          'the source changed again; newer bytes were preserved.'
        );
      }
      throw error;
    }
    return id;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertSourceIdUnique(
  schema: LoadedSchema,
  vaultDir: string,
  sourcePath: string,
  id: string
): Promise<void> {
  const matches = await findNotesWithId(schema, vaultDir, id);
  const otherMatches = matches.filter(file => resolve(file.path) !== resolve(sourcePath));
    },
  };
}

async function applyPreparedAdoption(
  vaultDir: string,
  prepared: PreparedAdoption,
  registerIds: typeof registerIssuedNoteIds
): Promise<void> {
  let parentWritten = false;
  let childWritten = false;
  try {
    if (prepared.parentNextRaw !== prepared.parentOriginal.raw) {
      await assertNoteBytesUnchanged(
        prepared.parent.file.path,
        prepared.parentOriginal.raw
      );
      await writeFileAtomic(prepared.parent.file.path, prepared.parentNextRaw);
      parentWritten = true;
    }
    await assertNoteBytesUnchanged(
      prepared.child.file.path,
      prepared.childOriginal.raw
    );
    await writeFileAtomic(prepared.child.file.path, prepared.childNextRaw);
    childWritten = true;
    await registerIds(vaultDir, prepared.registrations);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (childWritten) {
      await rollbackNoteIfUnchanged(
        prepared.child.file.path,
        prepared.childNextRaw,
        prepared.childOriginal.raw
      ).then(rolledBack => {
        if (!rolledBack) {
          rollbackErrors.push(`${prepared.child.file.relativePath} changed again; newer bytes left as-is`);
        }
      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (parentWritten) {
      await rollbackNoteIfUnchanged(
        prepared.parent.file.path,
        prepared.parentNextRaw,
        prepared.parentOriginal.raw
      ).then(rolledBack => {
        if (!rolledBack) {
          rollbackErrors.push(`${prepared.parent.file.relativePath} changed again; newer bytes left as-is`);
        }
      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Lineage adoption failed (${formatError(error)}) and rollback was incomplete: ${rollbackErrors.join('; ')}`
      );
    }
    throw error;
  }
}

function assertDifferentNotes(
  vaultDir: string,
  child: ResolvedExactNoteTarget,
  parent: ResolvedExactNoteTarget
): void {
  const childLock = getLineageMutationLockPath(vaultDir, child.file.path);
  const parentLock = getLineageMutationLockPath(vaultDir, parent.file.path);
  if (childLock === parentLock) {
    throw new Error(`Cannot adopt a note under itself: ${child.file.relativePath}.`);
  }
}

```

## handlers
```
diff --git a/src/commands/edit.ts b/src/commands/edit.ts
index 4ebd46e..b1be2bd 100644
--- a/src/commands/edit.ts
+++ b/src/commands/edit.ts
@@ -26,7 +26,8 @@ import {
   type OpenResultData,
 } from './open.js';
 import { resolveTargets, hasAnyTargeting, type TargetingOptions } from '../lib/targeting.js';
-import { UserCancelledError } from '../lib/errors.js';
+import { ConcurrentNoteModificationError, UserCancelledError } from '../lib/errors.js';
+import { concurrentModificationData } from '../lib/note-write-concurrency.js';
 import type { ResolvedConfig } from '../types/schema.js';
 
 // ============================================================================
@@ -163,6 +164,7 @@ Precedence (for --open app mode):
     // rather than silently falling back to the default app.
     const appModeInput = options.app ?? mode;
     let jsonMode = patchMode;
+    let resolvedVaultDir: string | undefined;
     try {
       const globalOpts = getGlobalOpts(cmd);
       jsonMode = resolveEditJsonMode(options, globalOpts.output);
@@ -179,6 +181,7 @@ Precedence (for --open app mode):
       const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
       if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
       const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
+      resolvedVaultDir = vaultDir;
       const schema = await loadSchema(vaultDir);
 
       if (globalOpts.nonInteractive && !patchMode) {
@@ -374,6 +377,17 @@ Precedence (for --open app mode):
         return;
       }
     } catch (err) {
+      if (err instanceof ConcurrentNoteModificationError) {
+        if (jsonMode) {
+          printJson(jsonError(err.message, {
+            code: ExitCodes.IO_ERROR,
+            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), err),
+          }));
+          process.exit(ExitCodes.IO_ERROR);
+        }
+        printError(err.message);
+        process.exit(ExitCodes.IO_ERROR);
+      }
       if (err instanceof UserCancelledError) {
         if (jsonMode) {
           printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
diff --git a/src/commands/lineage/index.ts b/src/commands/lineage/index.ts
index 470b501..d6b1450 100644
--- a/src/commands/lineage/index.ts
+++ b/src/commands/lineage/index.ts
@@ -5,6 +5,8 @@ import { getGlobalOpts } from '../../lib/command.js';
 import { ExitCodes, jsonError, printJson } from '../../lib/output.js';
 import { printError, printInfo, printSuccess } from '../../lib/prompt.js';
 import { adoptLineage } from './adopt.js';
+import { ConcurrentNoteModificationError } from '../../lib/errors.js';
+import { concurrentModificationData } from '../../lib/note-write-concurrency.js';
 
 interface AdoptCommandOptions {
   from?: string;
@@ -27,6 +29,7 @@ Examples:
 `)
   .action(async (child: string, options: AdoptCommandOptions, command: Command) => {
     const jsonMode = options.output === 'json';
+    let resolvedVaultDir: string | undefined;
     try {
       if (options.output !== 'text' && options.output !== 'json') {
         throw new Error('--output must be text or json.');
@@ -44,6 +47,7 @@ Examples:
         allowFindDown: true,
         jsonMode,
       });
+      resolvedVaultDir = vaultDir;
       const schema = await loadSchema(vaultDir);
       const result = await adoptLineage(schema, vaultDir, {
         child,
@@ -73,6 +77,18 @@ Examples:
       );
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
+      if (error instanceof ConcurrentNoteModificationError) {
+        if (jsonMode) {
+          printJson(jsonError(message, {
+            code: ExitCodes.IO_ERROR,
+            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), error),
+          }));
+        } else {
+          printError(message);
+        }
+        process.exitCode = ExitCodes.IO_ERROR;
+        return;
+      }
       if (jsonMode) {
         printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR }));
       } else {
diff --git a/src/commands/new.ts b/src/commands/new.ts
index 6eae656..b8d188f 100644
--- a/src/commands/new.ts
+++ b/src/commands/new.ts
@@ -23,7 +23,8 @@ import {
   type InheritedTemplateResolution,
 } from '../lib/template.js';
 import type { LoadedSchema, Template } from '../types/schema.js';
-import { UserCancelledError } from '../lib/errors.js';
+import { ConcurrentNoteModificationError, UserCancelledError } from '../lib/errors.js';
+import { concurrentModificationData } from '../lib/note-write-concurrency.js';
 import { createNoteFromJson } from './new/json-mode.js';
 import { resolveTypePath } from './new/type-selection.js';
 import { createNoteInteractive } from './new/interactive.js';
@@ -93,6 +94,7 @@ Template management:
     const forkJsonMode = forkMode && options.output === 'json';
     const jsonMode = options.json !== undefined || forkJsonMode;
     const typePath = options.type ?? positionalType;
+    let resolvedVaultDir: string | undefined;
 
     try {
       const globalOpts = getGlobalOpts(cmd);
@@ -103,6 +105,7 @@ Template management:
       const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
       if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
       const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
+      resolvedVaultDir = vaultDir;
       const schema = await loadSchema(vaultDir);
 
       validateForkOptions(positionalType, options);
@@ -240,6 +243,17 @@ Template management:
         await openNote(vaultDir, filePath, resolveAppMode(undefined, schema.config), schema.config, false);
       }
     } catch (err) {
+      if (err instanceof ConcurrentNoteModificationError) {
+        if (jsonMode) {
+          printJson(jsonError(err.message, {
+            code: ExitCodes.IO_ERROR,
+            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), err),
+          }));
+          process.exit(ExitCodes.IO_ERROR);
+        }
+        printError(err.message);
+        process.exit(ExitCodes.IO_ERROR);
+      }
       if (err instanceof JsonCommandError) {
         if (!err.result.success) {
           err.result.code = err.exitCode;
diff --git a/src/commands/search.ts b/src/commands/search.ts
index 4754725..c7a3fa4 100644
--- a/src/commands/search.ts
+++ b/src/commands/search.ts
@@ -47,7 +47,8 @@ import {
 } from '../lib/fuzzy-search.js';
 import { parseNote } from '../lib/frontmatter.js';
 import { applyWhereExpressions } from '../lib/where-targeting.js';
-import { UserCancelledError } from '../lib/errors.js';
+import { ConcurrentNoteModificationError, UserCancelledError } from '../lib/errors.js';
+import { concurrentModificationData } from '../lib/note-write-concurrency.js';
 import { resolveTargets, type TargetingOptions } from '../lib/targeting.js';
 
 // ============================================================================
@@ -311,6 +312,7 @@ export async function runSearchCommand(
     // Resolve output format from deprecated flags and new --output option
     const outputFormat = resolveSearchOutputFormat(options);
     const jsonMode = outputFormat === 'json';
+    let resolvedVaultDir: string | undefined;
 
     // App-mode precedence: an explicit --app flag wins over the positional
     // [mode] (the convenience form). Fold the resolved value back into
@@ -387,6 +389,7 @@ export async function runSearchCommand(
       const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
       if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
       const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
+      resolvedVaultDir = vaultDir;
       const schema = await loadSchema(vaultDir);
 
       if (globalOpts.nonInteractive && options.edit && !options.json) {
@@ -408,6 +411,17 @@ export async function runSearchCommand(
         await handleNameSearch(query, effectiveOptions, vaultDir, schema, jsonMode, outputFormat);
       }
     } catch (err) {
+      if (err instanceof ConcurrentNoteModificationError) {
+        if (jsonMode) {
+          printJson(jsonError(err.message, {
+            code: ExitCodes.IO_ERROR,
+            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), err),
+          }));
+          process.exit(ExitCodes.IO_ERROR);
+        }
+        printError(err.message);
+        process.exit(ExitCodes.IO_ERROR);
+      }
       if (err instanceof UserCancelledError) {
         if (jsonMode) {
           printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));

```

## docs fix delta
```
diff --git a/docs-site/src/content/docs/automation/json-mode.md b/docs-site/src/content/docs/automation/json-mode.md
index 126157c..9e98bfc 100644
--- a/docs-site/src/content/docs/automation/json-mode.md
+++ b/docs-site/src/content/docs/automation/json-mode.md
@@ -35,8 +35,9 @@ complete JSON value, but success shapes differ by workflow:
 Guarded note writers use numeric top-level error codes. If edit, fork, or
 adoption observes newer note bytes, exit code `2` includes
 `data.reason: "note-modified-concurrently"`, `data.retryable: true`, the
-vault-relative `data.path`, and `data.attempts`. JSON edit retries internally up
-to three times before returning that error.
+vault-relative `data.path`, and `data.attempts`. JSON edit makes up to three
+total attempts (the initial attempt plus at most two retries) before returning
+that error.
 
 Normal list output is intentionally a raw array:
 
diff --git a/docs-site/src/content/docs/reference/commands/edit.md b/docs-site/src/content/docs/reference/commands/edit.md
index cdbc77f..0a7f294 100644
--- a/docs-site/src/content/docs/reference/commands/edit.md
+++ b/docs-site/src/content/docs/reference/commands/edit.md
@@ -65,13 +65,14 @@ bwrb edit -t task --where "status == 'active'" "Deploy" --json '{"priority":"hig
 
 The final edit commit shares the note's lineage mutation lock with `new --fork`
 and `lineage adopt`. Bowerbird compares the note's exact raw bytes after taking
-the lock. A JSON patch that became stale is replayed against the latest note up
-to three times, so a concurrent `id` backfill or `forked-from` edge is preserved.
+the lock. A JSON patch that became stale is retried against the latest note for
+up to three total attempts, so a concurrent `id` backfill or `forked-from` edge
+is preserved.
 Interactive answers are never replayed against unseen values; the command asks
 you to retry instead.
 
-If all JSON retries become stale, JSON output uses numeric exit code `2` and
-stable retry context:
+If all three JSON attempts become stale, JSON output uses numeric exit code `2`
+and stable retry context:
 
 ```json
 {
diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index 29e19c4..e1565d0 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -399,7 +399,7 @@ bwrb edit --type task --where "status == 'active'" "Deploy" --json '{"status": "
 Notes:
 - If multiple notes share the same name, `bwrb edit` errors and lists candidates. Disambiguate with `--type`, `--path`, or a vault-relative path.
 - `bwrb new --json` rejects unknown frontmatter fields after merging template defaults. `bwrb edit --json` rejects unknown fields in the patch.
-- Edit commits coordinate with fork/adopt lineage writes. JSON patches replay from fresh bytes up to three times; on exhaustion, retry only when JSON has numeric `code: 2`, `data.reason: "note-modified-concurrently"`, and `data.retryable: true`. Interactive edits do not replay answers gathered from stale values.
+- Edit commits coordinate with fork/adopt lineage writes. JSON patches make up to three total attempts (the initial attempt plus at most two retries) from fresh bytes; on exhaustion, retry only when JSON has numeric `code: 2`, `data.reason: "note-modified-concurrently"`, and `data.retryable: true`. Interactive edits do not replay answers gathered from stale values.
 
 ### Deleting Notes
 
diff --git a/src/lib/edit.ts b/src/lib/edit.ts
index 9c9ebb4..eea71fb 100644
--- a/src/lib/edit.ts
+++ b/src/lib/edit.ts
@@ -486,6 +486,7 @@ export async function editNoteInteractive(
 
 /** File handshake used only by cross-process race tests. */
 async function waitForEditCommitBarrier(attempt: number, filePath: string): Promise<void> {
+  if (process.env.BWRB_TEST_EDIT_BARRIER_ENABLED !== '1') return;
   const barrierDir = process.env.BWRB_TEST_EDIT_BARRIER_DIR;
   if (!barrierDir) return;
 
diff --git a/tests/ts/commands/edit-lineage-concurrency.test.ts b/tests/ts/commands/edit-lineage-concurrency.test.ts
index dd793b3..c3f6310 100644
--- a/tests/ts/commands/edit-lineage-concurrency.test.ts
+++ b/tests/ts/commands/edit-lineage-concurrency.test.ts
@@ -37,6 +37,7 @@ function spawnCli(args: string[], cwd: string, barrierDir: string): RunningCli {
     env: withTestCliNodeOptions({
       ...process.env,
       NO_COLOR: '1',
+      BWRB_TEST_EDIT_BARRIER_ENABLED: '1',
       BWRB_TEST_EDIT_BARRIER_DIR: barrierDir,
     }, { useDist: USE_DIST }),
     stdio: ['ignore', 'pipe', 'pipe'],

```

## key tests
```
import { spawn } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_PATH,
  PROJECT_ROOT,
  cleanupTestVault,
  createTestVault,
  runCLI,
  waitForFile,
  withTestCliNodeOptions,
} from '../fixtures/setup.js';
import { insertFrontmatterScalarPreservingBytes, parseNote } from '../../../src/lib/frontmatter.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { editNoteInteractive } from '../../../src/lib/edit.js';
import { ConcurrentNoteModificationError } from '../../../src/lib/errors.js';

const CLI_SRC_PATH = join(PROJECT_ROOT, 'src/index.ts');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const USE_DIST = process.env.BWRB_TEST_DIST === '1';
const CHILD_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

interface RunningCli {
  completion: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  kill: () => void;
}

function spawnCli(args: string[], cwd: string, barrierDir: string): RunningCli {
  const command = process.execPath;
  const cliArgs = USE_DIST
    ? [CLI_PATH, '--vault', cwd, ...args]
    : [TSX_CLI, CLI_SRC_PATH, '--vault', cwd, ...args];
  const child = spawn(command, cliArgs, {
    cwd,
    env: withTestCliNodeOptions({
      ...process.env,
      NO_COLOR: '1',
      BWRB_TEST_EDIT_BARRIER_ENABLED: '1',
      BWRB_TEST_EDIT_BARRIER_DIR: barrierDir,
    }, { useDist: USE_DIST }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      }));
    }
  );
  return { completion, kill: () => child.kill('SIGKILL') };
}

async function releaseAttempt(barrierDir: string, attempt: number): Promise<void> {
  await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
  await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
}

describe('edit versus lineage identity writes', () => {
  let vaultDir: string;
  const running: RunningCli[] = [];

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    for (const process of running) process.kill();
    await cleanupTestVault(vaultDir);
  });

  it('replays a JSON edit after new --fork backfills the source ID', async () => {
    const sourcePath = join(vaultDir, 'Ideas/Fork Race Source.md');
    const sourceRaw = '\uFEFF---\r\ntype: "idea" # quoted\r\nstatus: raw\r\npriority: medium\r\nprovider: { remote: keep-me }\r\n---\r\nBody bytes.\r\n';
    await writeFile(sourcePath, sourceRaw);
    const barrierDir = join(vaultDir, '.barrier-fork');
    const edit = spawnCli([
      'edit', sourcePath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir, barrierDir);
    running.push(edit);

    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
    const fork = await runCLI([
      'new', '--fork', sourcePath, '--name', 'Fork Race Child', '--output', 'json',
    ], vaultDir);
    expect(fork.exitCode, fork.stderr || fork.stdout).toBe(0);
    const forkJson = JSON.parse(fork.stdout) as { id: string; forked_from: string; path: string };
    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
    await releaseAttempt(barrierDir, 2);

    const edited = await edit.completion;
    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({ success: true, updated: ['priority'] });
    const source = await parseNote(sourcePath);
    expect(source.frontmatter).toMatchObject({
      id: forkJson.forked_from,
      priority: 'high',
      provider: { remote: 'keep-me' },
    });
    expect(source.body).toBe('Body bytes.\r\n');
    expect((await parseNote(join(vaultDir, forkJson.path))).frontmatter['forked-from'])
      .toBe(forkJson.forked_from);

    const expectedPath = join(vaultDir, 'Ideas/Fork Race Expected.md');
    await writeFile(
      expectedPath,
      insertFrontmatterScalarPreservingBytes(sourceRaw, 'id', forkJson.forked_from)
    );
    const sequential = await runCLI([
      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir);
    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
    expect(await readFile(sourcePath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
  });

  it('replays a JSON edit after lineage adopt writes immutable provenance', async () => {
    const childPath = join(vaultDir, 'Ideas/Adopt Race Child.md');
    const parentPath = join(vaultDir, 'Ideas/Adopt Race Parent.md');
    const childRaw = `---\ntype: idea\nid: ${CHILD_ID}\nstatus: raw\npriority: medium\nprovider: { remote: child }\n---\nChild body.\n`;
    const parentRaw = `---\ntype: idea\nid: ${PARENT_ID}\nstatus: raw\npriority: medium\n---\nParent body.\n`;
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const barrierDir = join(vaultDir, '.barrier-adopt');
    const edit = spawnCli([
      'edit', childPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir, barrierDir);
    running.push(edit);

    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
    const adopted = await runCLI([
      'lineage', 'adopt', childPath, '--from', parentPath, '--execute', '--output', 'json',
    ], vaultDir);
    expect(adopted.exitCode, adopted.stderr || adopted.stdout).toBe(0);
    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
    await releaseAttempt(barrierDir, 2);

    const edited = await edit.completion;
    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
    const child = await parseNote(childPath);
    expect(child.frontmatter).toMatchObject({
      id: CHILD_ID,
      'forked-from': PARENT_ID,
      priority: 'high',
      provider: { remote: 'child' },
    });
    expect(child.body).toBe('Child body.\n');

    const expectedPath = join(vaultDir, 'Ideas/Adopt Race Expected.md');
    await writeFile(
      expectedPath,
      insertFrontmatterScalarPreservingBytes(childRaw, 'forked-from', PARENT_ID)
    );
    const sequential = await runCLI([
      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
    ], vaultDir);
    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
    expect(await readFile(childPath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
  });

  it.each(['json', 'text'] as const)(
    'preserves the newest bytes and emits a stable retryable %s error after retry exhaustion',
    async (output) => {
      const notePath = join(vaultDir, `Ideas/Retry Exhaustion ${output}.md`);
      let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nOriginal body.\n';
      await writeFile(notePath, currentRaw);
      const barrierDir = join(vaultDir, `.barrier-${output}`);
      const edit = spawnCli([
        'edit', notePath, '--json', '{"priority":"high"}', '--output', output,
      ], vaultDir, barrierDir);
      running.push(edit);

      for (let attempt = 1; attempt <= 3; attempt++) {
        await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
        currentRaw = currentRaw.replace('Original body.', `Original body. external-${attempt}`);
        await writeFile(notePath, currentRaw);
        await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
      }

      const result = await edit.completion;
      expect(result.exitCode).toBe(2);
      expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
      if (output === 'json') {
        expect(JSON.parse(result.stdout)).toEqual({
          success: false,
          error: 'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.',
          code: 2,
          data: {
            reason: 'note-modified-concurrently',
            retryable: true,
            path: `Ideas/Retry Exhaustion ${output}.md`,
            attempts: 3,
          },
        });
      } else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.'
        );
      }
    }
  );

  it('does not replay interactive answers or write when its snapshot is stale', async () => {
    const notePath = join(vaultDir, 'Ideas/Interactive Stale.md');
    const originalRaw = '---\ntype: idea\nstatus: raw\n---\nOriginal body.\n';
    const newerRaw = '---\ntype: idea\nid: 33333333-3333-4333-8333-333333333333\nstatus: raw\n---\nOriginal body.\n';
    await writeFile(notePath, originalRaw);
    const schema = await loadSchema(vaultDir);
    const idea = schema.types.get('idea')!;
    idea.fields = { type: { value: 'idea' } };
    idea.fieldOrder = ['type'];

    await expect(editNoteInteractive(schema, vaultDir, notePath, {
      checkSections: false,
      beforeCommit: async () => { await writeFile(notePath, newerRaw); },
    })).rejects.toBeInstanceOf(ConcurrentNoteModificationError);
    expect(await readFile(notePath, 'utf-8')).toBe(newerRaw);
  });

  it('maps stale search --edit JSON through the same numeric retryable contract', async () => {
    const notePath = join(vaultDir, 'Ideas/Search Retry Exhaustion.md');
    let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nSearch body.\n';
    await writeFile(notePath, currentRaw);
    const barrierDir = join(vaultDir, '.barrier-search');
    const edit = spawnCli([
      'search', 'Search Retry Exhaustion', '--edit', '--json', '{"priority":"high"}',
      '--output', 'json', '--picker', 'none',
    ], vaultDir, barrierDir);
    running.push(edit);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
      currentRaw = currentRaw.replace('Search body.', `Search body. external-${attempt}`);
      await writeFile(notePath, currentRaw);
      await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
    }

    const result = await edit.completion;
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      code: 2,
      data: {
        reason: 'note-modified-concurrently',
        retryable: true,
        path: 'Ideas/Search Retry Exhaustion.md',
        attempts: 3,
      },
    });
    expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
  });
});
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
    const registryBefore = await readFile(registryPath, 'utf-8').catch(() => null);
    const schema = await loadSchema(vaultDir);

    await expect(adoptLineage(
      schema,
      vaultDir,
      { child: 'Rollback Child', parent: 'Rollback Parent', execute: true },
      { registerIds: async () => { throw new Error('injected registry failure'); } }
    )).rejects.toThrow('injected registry failure');

    expect(await readFile(childPath, 'utf-8')).toBe(childRaw);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
    expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);
  });

  it('never rolls adoption back over bytes written after its own child write', async () => {
    const childPath = join(vaultDir, 'Ideas/Rollback Race Child.md');
    const parentPath = join(vaultDir, 'Ideas/Rollback Race Parent.md');
    const childRaw = noteRaw({ body: 'Original child bytes\n' });
    const parentRaw = noteRaw({ body: 'Original parent bytes\n' });
    const newerChildRaw = noteRaw({
      id: C,
      extra: 'provider: { newer: true }\n',
      body: 'Newer child bytes\n',
    });
    await writeFile(childPath, childRaw);
    await writeFile(parentPath, parentRaw);
    const schema = await loadSchema(vaultDir);

    await expect(adoptLineage(
      schema,
      vaultDir,
      { child: 'Rollback Race Child', parent: 'Rollback Race Parent', execute: true },
      {
        registerIds: async () => {
          await writeFile(childPath, newerChildRaw);
          throw new Error('injected registry failure after a newer writer');
        },
      }
    )).rejects.toThrow('newer bytes left as-is');

    expect(await readFile(childPath, 'utf-8')).toBe(newerChildRaw);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
  });

  it('refuses cycles and ambiguous or missing exact targets', async () => {
    await writeFile(join(vaultDir, 'Ideas/Cycle Root.md'), noteRaw({ id: A }));
    await writeFile(join(vaultDir, 'Ideas/Cycle Child.md'), noteRaw({ id: B, parent: A }));
    const cycle = await runCLI([
      'lineage', 'adopt', 'Cycle Root', '--from', 'Cycle Child', '--execute', '--output', 'json',
    ], vaultDir);
    expect(cycle.exitCode).toBe(1);
    expect(JSON.parse(cycle.stdout).error).toContain('would create a cycle');

    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
    await writeFile(join(vaultDir, 'Ideas/Ambiguous.md'), noteRaw());
    await writeFile(join(vaultDir, 'Ideas/Nested/Ambiguous.md'), noteRaw());
    for (const [child, parent, noun] of [

```


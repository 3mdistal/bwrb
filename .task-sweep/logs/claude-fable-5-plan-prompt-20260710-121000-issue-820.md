# TaskSweep early planning packet — BWRB issue #820

You are advising before implementation. You have no tools. Give a concise, concrete plan; do not mutate anything or broaden beyond this issue.

## Normalized task

- ID/source: GitHub issue #820, https://github.com/3mdistal/bwrb/issues/820
- Title: Prevent concurrent edits from being overwritten by lineage identity writes
- Repo/base: 3mdistal/bwrb, origin/main at merge commit 7093f233ffc0e43c5086e184ed19e518148211c8 (PR #821)
- Branch/lane: codex/820-lineage-edit-concurrency in an isolated worktree
- Problem: new --fork source ID backfill and lineage adopt atomically rewrite raw note bytes while holding path-keyed lineage locks. Ordinary edit reads a note without those locks and later rewrites serialized frontmatter/body. A stale edit can overwrite an id or forked-from inserted after its read. PR #821 hardened the lock cross-platform; this issue now closes the remaining edit-vs-lineage race.
- Acceptance:
  1. Identity/provenance writes detect when note bytes changed after their authoritative read and fail or safely retry without overwriting the concurrent ordinary edit.
  2. Text and JSON behavior is deterministic, with stable retryable output when automatic retry is unsafe.
  3. Focused deterministic edit-vs-new --fork and edit-vs-lineage-adopt races.
  4. Preserve byte-sensitive YAML/body invariants and keep forked-from immutable outside sanctioned lineage workflows.
  5. Existing fork, adoption, audit, lineage-lock, edit, recurrence, and full suites remain green.
- User authorized draft PR, full TaskSweep, ready transition, and normal merge after every gate. Do not merge early.
- Scope: solve one-note ordinary edit coordination with fork/adopt identity writes. Do not redesign all bulk/audit/template/migration writers unless a tiny shared primitive is strictly required by this issue.

## Repo facts and constraints

- TypeScript ESM Commander CLI; Node 22; pnpm 10.11.0.
- Full parity exact order: build, verify:pack, typecheck, lint, knip, non-PTY tests.
- User behavior docs are canonical in docs-site/src/content/docs/; update docs/skill/SKILL.md for automation contract changes and changelogs when behavior changes.
- System fields id and forked-from are already rejected from JSON patch input and omitted from interactive edit prompts.
- withLineageMutationLocks sorts path locks and fails closed. Fork/adopt take path locks; adopt then takes the global note-ID assignment lock. PR #821 adds real child-process lock fixtures and Windows CI.
- writeFileAtomic uses temp + fsync + rename but has no compare-and-swap. writeNote is a direct write.
- JSON edit and interactive edit both parse near the beginning, validate/prepare recurrence work, then write much later.
- Recurrence edit planning/commit must not regress atomicity.
- Holding a cross-process lock throughout human prompts is likely undesirable; evaluate commit-phase locking plus stale detection/retry.
- A read/check/rename CAS cannot exclude an unrelated external editor between check and rename. The acceptance is specifically ordinary BWRB edit versus sanctioned lineage mutations; clarify the honest guarantee rather than claiming general filesystem CAS.

## Questions for the plan

1. What is the smallest safe architecture? Compare:
   - wrapping the entire JSON/interactive edit in the lineage path lock;
   - commit-phase lock with exact raw-byte stale detection;
   - bounded automatic retry for JSON patches against the latest note while interactive edits return a stable retryable error.
2. Which code should own the retryable error and output mapping? Propose exact text, exit code, and JSON data shape consistent with current BWRB conventions.
3. How should recurrence preparation/commit interact with the lock and possible retry so no predecessor/successor inconsistency is introduced?
4. Do fork/adopt need their own pre-write raw-byte assertions after this change, or does making ordinary edit lock-aware satisfy the stated race? If assertions are added, ensure rollback cannot clobber a newer edit.
5. Give a deterministic test design for edit-vs-fork and edit-vs-adopt, preferably exercising actual CLI processes with explicit handshakes rather than sleeps. Identify any minimal dependency seam/test-only fixture needed.
6. List docs/changelog/agent-skill updates, focused commands, full gates, and scope traps.
7. Call out lock-order or rollback deadlocks/data-loss risks.

## Relevant current code

### src/lib/edit.ts
```ts

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

```

### src/commands/new/fork.ts
```ts
  vaultDir: string,
  options: ForkNoteOptions
): Promise<ForkNoteResult> {
  const source = await resolveForkSource(schema, vaultDir, options.target);
  if (isValidNoteId(source.frontmatter.id)) {
    await assertSourceIdUnique(schema, vaultDir, source.file.path, source.frontmatter.id);
  }
  assertOwnedForkAllowed(schema, source.file);

  const sourceName = resolveSourceName(source);
  const childName = await resolveChildName(sourceName, options);

  return withLineageMutationLocks(vaultDir, [source.file.path], async () => {
    // The path-keyed lock begins before legacy ID backfill and remains held
    // through the child registry append. A concurrent non-force delete either
    // removes the source first or observes this completed child.
    const sourceId = await ensureSourceId(schema, vaultDir, source.file.path);

    // Re-read after a possible ID backfill so the child copies the source's
    // current frontmatter rather than a stale pre-lock snapshot.
    const current = await parseNote(source.file.path);
    const currentType = resolveTypeFromFrontmatter(schema, current.frontmatter);
    if (!currentType) {
      throw new Error(`Fork source no longer has a valid schema type: ${source.file.relativePath}`);
    }

    const warnings = collectSchemaDriftWarnings(schema, currentType, current.frontmatter);
    const frontmatter = normalizeDateFields(
      schema,
      currentType,
      buildForkFrontmatter(
        schema,
        currentType,
        current.frontmatter,
        childName,
        sourceId
      )
    );
    const childId = await generateUniqueNoteId(vaultDir);
    frontmatter.id = childId;

    const pathResult = buildNotePath(dirname(source.file.path), childName, 'interactive');
    const relativePath = relative(vaultDir, pathResult.path);
    if (relativePath.length > PORTABLE_PATH_MAX_LENGTH) {
      throw new Error(
        `Note path is ${relativePath.length} characters, exceeding the portable limit of ${PORTABLE_PATH_MAX_LENGTH}: ${relativePath}`
      );
    }

    const pathLengthWarning = relativePath.length > PORTABLE_PATH_WARNING_LENGTH
      ? {
          path: relativePath,
          length: relativePath.length,
          threshold: PORTABLE_PATH_WARNING_LENGTH,
          max: PORTABLE_PATH_MAX_LENGTH,
        }
      : undefined;

    const orderedFields = buildForkFieldOrder(current.frontmatter, frontmatter);
    try {
      await writeNoteExclusive(pathResult.path, frontmatter, current.body, orderedFields);
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new Error(`File already exists: ${relativePath}`);
      }
      throw error;
    }

    try {
      await registerIssuedNoteId(vaultDir, childId, pathResult.path);
    } catch (error) {
      // A note without a registry row is not a completed creation. Roll it
      // back; the source ID backfill intentionally remains durable.
      await unlink(pathResult.path).catch(() => undefined);
      throw error;
    }
  if (selected === null) throw new UserCancelledError();
  if (!selected.trim()) throw new Error('Fork name cannot be empty.');
  return selected.trim();
}

async function ensureSourceId(
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
    await writeFileAtomic(sourcePath, nextRaw);
    try {
      await registerIssuedNoteId(vaultDir, id, sourcePath);
    } catch (error) {
      await writeFileAtomic(sourcePath, parsed.raw);
      throw error;
    }
    return id;
  });
}

async function assertSourceIdUnique(
  schema: LoadedSchema,
  vaultDir: string,
  sourcePath: string,
  id: string
): Promise<void> {
  const matches = await findNotesWithId(schema, vaultDir, id);
  const otherMatches = matches.filter(file => resolve(file.path) !== resolve(sourcePath));

```

### src/commands/lineage/adopt.ts
```ts
  registrations: Array<{ id: string; notePath: string }>;
}

/** Preview or apply one guarded immediate-source edge between existing notes. */
export async function adoptLineage(
  schema: LoadedSchema,
  vaultDir: string,
  options: LineageAdoptOptions,
  dependencies: LineageAdoptDependencies = {}
): Promise<LineageAdoptResult> {
  const initial = await resolveTargets(schema, vaultDir, options.child, options.parent);
  assertDifferentNotes(vaultDir, initial.child, initial.parent);

  if (!options.execute) {
    return (await prepareAdoption(schema, vaultDir, initial.child, initial.parent, 'dry-run')).result;
  }

  const lockedPaths = [initial.child.file.path, initial.parent.file.path];
  return withLineageMutationLocks(vaultDir, lockedPaths, async () =>
    withNoteIdAssignmentLock(vaultDir, async () => {
      const current = await resolveTargets(schema, vaultDir, options.child, options.parent);
      assertTargetsStayedLocked(vaultDir, initial, current);
      const prepared = await prepareAdoption(
        schema,
        vaultDir,
        current.child,
        current.parent,
        'execute'
      );
      await applyPreparedAdoption(
        vaultDir,
        prepared,
        dependencies.registerIds ?? registerIssuedNoteIds
      );
      return prepared.result;
    })
  );
}

async function resolveTargets(
  schema: LoadedSchema,
  vaultDir: string,
  childTarget: string,
  parentTarget: string
): Promise<{ child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget }> {
  const child = await resolveExactNoteTarget(schema, vaultDir, childTarget, {
    purpose: 'adoption child',
  });
  const parent = await resolveExactNoteTarget(schema, vaultDir, parentTarget, {
    purpose: 'adoption parent',
  });
      `parent ${parent.file.relativePath} is ${parent.typeName}.`
    );
  }

  assertNoExistingProvenance(child);
  assertValidExistingId(child, 'child');
  assertValidExistingId(parent, 'parent');

  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  assertGraphSafe(snapshot);

  const usedIds = new Set<string>();
  for (const note of snapshot.notes) {
    const id = note.frontmatter?.id;
    if (isValidNoteId(id)) usedIds.add(normalizeNoteId(id));
  }

  const parentExistingId = parent.frontmatter.id;
  const parentId = isValidNoteId(parentExistingId)
    ? parentExistingId
    : await generateProspectiveId(vaultDir, usedIds);
  usedIds.add(normalizeNoteId(parentId));

  const childExistingId = child.frontmatter.id;
  const childId = isValidNoteId(childExistingId)
    ? childExistingId
    : await generateProspectiveId(vaultDir, usedIds);
  usedIds.add(normalizeNoteId(childId));

  if (normalizeNoteId(childId) === normalizeNoteId(parentId)) {
    throw new Error('Cannot adopt a note under itself: child and parent have the same stable id.');
  }

  const prospective = withProspectiveEdge(
    snapshot,
    child.file.path,
    parent.file.path,
    childId,
    parentId
  );
  assertGraphSafe(prospective, true);

  const parentRaw = await readFile(parent.file.path, 'utf-8');
  const childRaw = await readFile(child.file.path, 'utf-8');
  const parentNextRaw = isValidNoteId(parentExistingId)
    ? parentRaw
    : insertFrontmatterScalarPreservingBytes(parentRaw, 'id', parentId);
  let childNextRaw = childRaw;
  if (!isValidNoteId(childExistingId)) {
    childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'id', childId);
  }
  childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'forked-from', parentId);

  const childOriginal = parseNoteContent(childRaw);
  const parentOriginal = parseNoteContent(parentRaw);
  const childNext = parseNoteContent(childNextRaw);
  const parentNext = parseNoteContent(parentNextRaw);
  assertOnlySystemFieldsChanged(child.file.relativePath, childOriginal, childNext);
  assertOnlySystemFieldsChanged(parent.file.relativePath, parentOriginal, parentNext);

  const status = mode === 'execute' ? 'applied' : 'planned';
  const changes: LineageAdoptChange[] = [];
  if (!isValidNoteId(parentExistingId)) {
    changes.push({ path: parent.file.relativePath, field: 'id', value: parentId, status });
  }
  if (!isValidNoteId(childExistingId)) {
    changes.push({ path: child.file.relativePath, field: 'id', value: childId, status });
  }
  changes.push({
    path: child.file.relativePath,
    field: 'forked-from',
    value: parentId,
    status,
  });

  const registrations: Array<{ id: string; notePath: string }> = [];
  if (!isValidNoteId(parentExistingId)) {
    registrations.push({ id: parentId, notePath: parent.file.path });
  }
  if (!isValidNoteId(childExistingId)) {
    registrations.push({ id: childId, notePath: child.file.path });
  }

  return {
    child,
    parent,
    childOriginal,
    parentOriginal,
    childNextRaw,
    parentNextRaw,
    registrations,
    result: {
      mode,
      child: {
        path: child.file.relativePath,
        id: childId,
        id_generated: !isValidNoteId(childExistingId),
      },
      parent: {
        path: parent.file.relativePath,
        id: parentId,
        id_generated: !isValidNoteId(parentExistingId),
      },
      changes,
      warnings: mode === 'dry-run' && registrations.length > 0
        ? ['Generated IDs in a dry run are provisional; execute revalidates and assigns fresh UUIDs.']
        : [],
      body_invariance: {
        child: buildBodyEvidence(childOriginal.body, childNext.body),
        parent: buildBodyEvidence(parentOriginal.body, parentNext.body),
      },
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
      await writeFileAtomic(prepared.parent.file.path, prepared.parentNextRaw);
      parentWritten = true;
    }
    await writeFileAtomic(prepared.child.file.path, prepared.childNextRaw);
    childWritten = true;
    await registerIds(vaultDir, prepared.registrations);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (childWritten) {
      await writeFileAtomic(prepared.child.file.path, prepared.childOriginal.raw)
        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (parentWritten) {
      await writeFileAtomic(prepared.parent.file.path, prepared.parentOriginal.raw)
        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Lineage adoption failed (${formatError(error)}) and rollback was incomplete: ${rollbackErrors.join('; ')}`
      );
    }
    throw error;

```

### src/lib/frontmatter.ts
```ts
  }

  return value;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

/** Parse an in-memory markdown note using the same normalization as parseNote. */
export function parseNoteContent(content: string): ParsedNote {
  const { data, content: body } = matter(content);
  return {
    frontmatter: normalizeMatterValue(data) as Record<string, unknown>,
    body,
    raw: content,
  };
}

/**
 * Parse a markdown file's frontmatter and body.
 */
export async function parseNote(filePath: string): Promise<ParsedNote> {
  const content = await readFile(filePath, 'utf-8');
  return parseNoteContent(content);
}

/**
 * Parse frontmatter from a string.
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const { data } = matter(content);
  return normalizeMatterValue(data) as Record<string, unknown>;
}

/**
 * Insert a plain scalar into a note's top-level frontmatter without
 * reserializing any existing YAML.
 *
 * This is intentionally narrow: callers must supply a plain-safe key and
 * value. The original bytes (including BOM, EOL style, comments, anchors,
 * quote style, block scalars, and body) are otherwise left untouched.
 */
export function insertFrontmatterScalarPreservingBytes(
  content: string,
  key: string,
  value: string
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`Cannot insert unsafe frontmatter key: ${key}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Cannot insert non-plain frontmatter value for ${key}`);
  }

  const structural = readStructuralFrontmatterFromRaw(content);
  const block = structural.primaryBlock;
  const doc = structural.doc;
  if (
    !block ||
    !structural.atTop ||
    !doc ||
    structural.yamlErrors.length > 0 ||
    !isMap(doc.contents)
  ) {
    throw new Error('Cannot insert field: note does not have valid top-level mapping frontmatter');
  }

  const map = doc.contents as YAMLMap;
  const pairs = map.items as Pair[];
  if (pairs.some(pair => String((pair.key as Scalar | null | undefined)?.value ?? '') === key)) {
    throw new Error(`Cannot insert field: frontmatter already contains '${key}'`);
  }

  const yaml = structural.yaml ?? '';
  const typePair = pairs.find(
    pair => String((pair.key as Scalar | null | undefined)?.value ?? '') === 'type'
  );
  const typeEnd = (typePair?.value as { range?: [number, number, number] } | null | undefined)
    ?.range?.[2];
  const insertionOffset = typeof typeEnd === 'number' ? typeEnd : yaml.length;
  const insertionPoint = block.yamlStart + insertionOffset;
  const eol = detectEol(content);
  const before = content.slice(0, insertionPoint);
  const separator = before.endsWith('\n') ? '' : eol;
  return `${before}${separator}${key}: ${value}${eol}${content.slice(insertionPoint)}`;
}

/** Replace a UTF-8 file atomically via a same-directory temporary file. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const mode = await stat(filePath).then(info => info.mode).catch(() => undefined);
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.bwrb-${process.pid}-${randomUUID()}.tmp`
  );
  const handle = await open(tempPath, 'wx', mode);
  let renamed = false;

  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Serialize frontmatter to YAML string (without delimiters).
 * Always puts 'type' first if present.
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  order?: string[]
): string {
export function buildNoteContent(
  frontmatter: Record<string, unknown>,
  body: string,
  frontmatterOrder?: string[]
): string {
  const yaml = serializeFrontmatter(frontmatter, frontmatterOrder);
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Write a note to disk, creating directories as needed.
 */
export async function writeNote(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  frontmatterOrder?: string[]
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = buildNoteContent(frontmatter, body, frontmatterOrder);
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Create a note without ever replacing an existing path.
 *
 * The exclusive `wx` open is the filesystem-level reservation: concurrent
 * callers for the same path cannot both succeed. If writing fails after the
 * reservation is created, the partial file is removed before the error is
 * rethrown. Existing write paths keep their current overwrite semantics by
 * continuing to use {@link writeNote}.
 */
export async function writeNoteExclusive(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  frontmatterOrder?: string[]
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = buildNoteContent(frontmatter, body, frontmatterOrder);
  const handle = await open(filePath, 'wx');

```

### src/lib/lineage-lock.ts
```ts
import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';

const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 1_500;
const STALE_LOCK_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const LOCK_VERSION = 1;

export interface OwnershipFileLockOptions {
  retryMs: number;
  attempts: number;
  staleMs: number;
  heartbeatMs: number;
}

interface LockMetadata {
  version: number;
  pid: number;
  token: string;
  createdAt: number;
  heartbeatAt: number;
  pathKey: string;
}

interface LockSnapshot {
  raw: string;
  metadata: LockMetadata | null;
  device: number;
  inode: number;
  modifiedAt: number;
  size: number;
}

type LockSnapshotRead =
  | { kind: 'present'; snapshot: LockSnapshot }
  | { kind: 'missing' }
  | { kind: 'busy' };

const DEFAULT_OPTIONS: OwnershipFileLockOptions = {
  retryMs: LOCK_RETRY_MS,
  attempts: LOCK_ATTEMPTS,
  staleMs: STALE_LOCK_MS,
  heartbeatMs: HEARTBEAT_MS,
};

/**
 * Serialize mutations that can create or remove fork edges for a source file.
 *
 * The key is the source's canonical vault-relative path rather than its UUID:
 * legacy notes without IDs must participate in the same critical section as
 * the fork that may assign their first ID.
 */
export async function withLineageMutationLocks<T>(
  vaultDir: string,
  sourcePaths: string[],
  task: () => Promise<T>,
  optionOverrides: Partial<OwnershipFileLockOptions> = {}
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
  const lockPaths = Array.from(new Set(
    sourcePaths.map(sourcePath => getLineageMutationLockPath(vaultDir, sourcePath))
  )).sort((a, b) => a.localeCompare(b, 'en'));

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const lockPath of lockPaths) {
      releases.push(await acquireLock(
        lockPath,
        options,
        'Timed out waiting for a fork-lineage mutation lock; retry the command.'
      ));
    }
    return await task();
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) {
      await releases[index]!();
    }
  }
}

/**
 * Run one task while holding an ownership-safe lock at an existing lock path.
 *
 * This is shared by lineage-edge locks and the fixed note-ID coordination
 * locks. Recovery and release are token/inode aware, so an old holder cannot
 * remove a successor that has taken over the same pathname.
 */
export async function withOwnershipFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  optionOverrides: Partial<OwnershipFileLockOptions> = {},
  timeoutMessage = 'Timed out waiting for a file lock; retry the command.'
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
  const release = await acquireLock(resolve(lockPath), options, timeoutMessage);
  try {
    return await task();
  } finally {
    await release();
  }
}

export function getLineageMutationLockPath(vaultDir: string, sourcePath: string): string {
  const vaultRoot = resolve(vaultDir);
  const absoluteSource = resolve(sourcePath);
  const relativeSource = relative(vaultRoot, absoluteSource).replace(/\\/g, '/');
  if (
    relativeSource === '' ||
    relativeSource === '..' ||
    relativeSource.startsWith('../') ||
    relativeSource.startsWith('/')
  ) {
    throw new Error(`Lineage lock source must be a file inside the vault: ${sourcePath}`);
  }

  // Lower-casing intentionally over-serializes case-only path variants. That
  // is safer on case-insensitive filesystems and the digest remains portable.
  const key = createHash('sha256').update(relativeSource.normalize('NFC').toLowerCase()).digest('hex');

```

### src/commands/edit.ts
```ts

interface EditOptions {
  picker?: string;
  type?: string;
  path?: string;
  where?: string[];
  id?: string;
  body?: string;
  json?: string;
  output?: string;
  open?: boolean;
  app?: string;
}

function resolveEditJsonMode(options: EditOptions, globalOutput?: string): boolean {
  const requested = options.output ?? globalOutput;
  if (requested === undefined) {
    return options.json !== undefined;
  }
  return requested === 'json';
}

interface EditOpenJsonData {
  open: OpenResultData;
}

async function openAfterEdit(
  vaultDir: string,
  notePath: string,
  appMode: AppMode,
  config: ResolvedConfig,
  jsonMode: boolean
): Promise<EditOpenJsonData | undefined> {
  if (jsonMode) {
    const openData = getOpenResultData(vaultDir, notePath, appMode, config);
    if (appMode !== 'print') {
      await openNote(vaultDir, notePath, appMode, config, false);
    }
    return { open: openData };
  }

  await openNote(vaultDir, notePath, appMode, config, false);
  return undefined;
}

function printEditSuccess(
  path: string,
  updatedFields: string[],
  jsonMode: boolean,
  data?: EditOpenJsonData
): void {
  if (jsonMode) {
    printJson(jsonSuccess({ path, updated: updatedFields, ...(data ? { data } : {}) }));
    return;
  }

  const updatedText = updatedFields.length > 0
    ? ` (${updatedFields.join(', ')})`
    : '';
  printSuccess(`Updated: ${path}${updatedText}`);
}

// ============================================================================
// Command Definition
// ============================================================================

export const editCommand = new Command('edit')
  .description('Edit an existing note')
  .argument('[query]', 'Note name or path to edit')
  .argument('[mode]', 'App mode for --open: system, editor, visual, obsidian, print')
  .option('--picker <mode>', 'Picker mode: fzf, numbered, none', 'fzf')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-p, --path <glob>', 'Filter by path pattern')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression')
  .option('--id <uuid>', 'Filter by stable note id')
  .option('-b, --body <pattern>', 'Filter by body content')
  .option('--json <patch>', 'Non-interactive patch/merge mode')
  .option('--output <format>', 'Output format: text or json (default: json with --json)')
  .option('-o, --open', 'Open the note in Obsidian after editing')
  .option('--app <mode>', 'App mode for --open: system (default), editor, visual, obsidian, print')
  .addHelpText('after', `
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      if (globalOpts.nonInteractive && !patchMode) {
        printError('bwrb edit requires --json <patch> when --non-interactive is set.');
        process.exit(1);
      }

      // Validate the app mode eagerly (mirrors `open`): an invalid value from
      // either --app or the positional [mode] errors loudly here rather than
      // being silently ignored when --open isn't requested. Surface it as a
      // VALIDATION_ERROR (exit 1) with a clear message, consistent with `open`.
      if (appModeInput !== undefined) {
        try {
          parseAppMode(appModeInput);
        } catch (modeErr) {
          const message = modeErr instanceof Error ? modeErr.message : String(modeErr);
          if (jsonMode) {
            printJson(jsonError(message));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(message);
          process.exit(1);
        }
      }

      // Validate type if provided
      if (options.type) {
        const typeDef = getTypeDefByPath(schema, options.type);
        if (!typeDef) {
          const error = formatUnknownTypeError(schema, options.type);
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      // Check if query is an absolute path to an existing file
      if (query && isAbsolute(query)) {
        // Only the existence check may fall through to name resolution. Once we
        // know the file exists, edit errors (e.g. a recurrence spawn failure:
        // "Recurrence template 'X' was not found", "Cannot compute recurrence
        // offset: ...") MUST propagate to the outer catch so the user sees the
        // real message — never swallowed into a misleading "No matching notes".
        let fileExists = false;
        try {
          await fs.access(query);
          fileExists = true;
        } catch {
          // File doesn't exist or isn't accessible - fall through to normal resolution.
        }

        if (fileExists) {
          // It's a valid absolute path - use it directly.
          if (patchMode) {
            const editResult = await editNoteFromJson(schema, vaultDir, query, options.json!, { jsonMode });
            let openData: EditOpenJsonData | undefined;
            if (options.open) {
              const appMode = resolveAppMode(appModeInput, schema.config);
              if (!jsonMode) {
                printEditSuccess(relative(vaultDir, query), editResult.updatedFields, jsonMode);
                await openAfterEdit(vaultDir, query, appMode, schema.config, jsonMode);
                return;
              }
              openData = await openAfterEdit(vaultDir, query, appMode, schema.config, jsonMode);
            }
            printEditSuccess(relative(vaultDir, query), editResult.updatedFields, jsonMode, openData);
          } else {
            await editNoteInteractive(schema, vaultDir, query, {});
            printSuccess(`Updated ${basename(query, '.md')}`);
            if (options.open) {
              const appMode = resolveAppMode(appModeInput, schema.config);
              await openNote(vaultDir, query, appMode, schema.config, false);
            }
          }
          return;
        }
      }

      // Build targeting options
      const targeting: TargetingOptions = {};
      if (options.type) targeting.type = options.type;
      if (options.path) targeting.path = options.path;
      if (options.where) targeting.where = options.where;
      if (options.id) targeting.id = options.id;
      if (options.body) targeting.body = options.body;

      // Determine if we have targeting constraints
      const hasTargeting = hasAnyTargeting(targeting);

      // Determine picker mode
      const pickerMode = parsePickerMode(resolveGlobalPickerMode(options.picker, globalOpts, 'fzf'));
      const effectivePickerMode: PickerMode = patchMode ? 'none' : pickerMode;

      // In JSON mode without interactive picker, require a query or targeting
      if (patchMode && !query && !hasTargeting) {
        const error = 'Query required when using --json without targeting options';
        if (jsonMode) {
          printJson(jsonError(error));
        } else {
          printError(error);
        }
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      // Build candidates based on targeting
      let candidates: ManagedFile[];
      const index = await buildNoteIndex(schema, vaultDir);

      if (hasTargeting) {
        // Use resolveTargets for proper filtering
        const targetingResult = await resolveTargets(targeting, schema, vaultDir);
        if (targetingResult.error) {
          exitWithResolutionError(targetingResult.error, targetingResult.files, jsonMode);
        }
        candidates = targetingResult.files;
      } else {
        candidates = index.allFiles;
      }

      // Create a filtered index for resolution
      const candidatePaths = new Set(candidates.map((candidate) => candidate.relativePath));
      const filteredIndex = {
        ...index,
        allFiles: candidates,
        byPath: new Map(
          [...index.byPath].filter(([path]) => candidatePaths.has(path))
        ),
        byBasename: new Map<string, ManagedFile[]>(),
        byAlias: new Map(
          [...index.byAlias]
            .map(([alias, files]): [string, ManagedFile[]] => [
              alias,
              files.filter((file) => candidatePaths.has(file.relativePath)),
            ])
            .filter(([, files]) => files.length > 0)
        ),
      };
      // Rebuild byBasename for filtered candidates
      for (const file of candidates) {
        const fileBasename = basename(file.relativePath, '.md');
        const existing = filteredIndex.byBasename.get(fileBasename) ?? [];
        existing.push(file);
        filteredIndex.byBasename.set(fileBasename, existing);
      }

      const result = await resolveAndPick(filteredIndex, query, {
        pickerMode: effectivePickerMode,
        prompt: 'Select note to edit',
        preview: false,
        vaultDir,
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const targetFile = result.file;

      // Perform the edit
      if (patchMode) {
        // JSON patch mode: non-interactive patch with selectable output format
        const editResult = await editNoteFromJson(schema, vaultDir, targetFile.path, options.json!, { jsonMode });
        let openData: EditOpenJsonData | undefined;

        // Open after edit if requested
        if (options.open) {
          const appMode = resolveAppMode(appModeInput, schema.config);
          if (!jsonMode) {
            printEditSuccess(targetFile.relativePath, editResult.updatedFields, jsonMode);
            await openAfterEdit(vaultDir, targetFile.path, appMode, schema.config, jsonMode);
            return;
          }
          openData = await openAfterEdit(vaultDir, targetFile.path, appMode, schema.config, jsonMode);
        }
        printEditSuccess(targetFile.relativePath, editResult.updatedFields, jsonMode, openData);
        return;
      } else {
        // Interactive mode
        await editNoteInteractive(schema, vaultDir, targetFile.path);
        printSuccess(`Updated: ${targetFile.relativePath}`);

        // Open after edit if requested
        if (options.open) {
          const appMode = resolveAppMode(appModeInput, schema.config);
          await openNote(vaultDir, targetFile.path, appMode, schema.config, false);
        }
        return;
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenConfigurationError) {
        if (jsonMode) {
          printJson(jsonError(message));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }

```

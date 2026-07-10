You are reviewing an embedded pull request diff for correctness bugs, missed edge cases, security/data-loss issues, test gaps, documentation drift, runtime risk, and release risk.

Review on separate axes:
- SPEC FIDELITY: missing/partial requirements, wrong behavior, unrequested scope.
- STANDARDS AND RISK: repo conventions plus correctness, data safety, tests, runtime, maintainability.

Constraints:
- Review only the embedded spec, standards, and diff.
- No tools, edits, GitHub actions, or repository mutations.
- Treat this as a PR readiness gate.
- Cite paths and line numbers where possible.
- First line exactly one of: BLOCKERS, NON-BLOCKING, NO BLOCKERS.
- Separate blockers from non-blocking suggestions. Block only concrete defects.
- Review docs against implementation.
- Keep concise but inspect concurrency and rollback carefully.

BEGIN TASK / SPEC
GitHub issue #820: Prevent concurrent edits from being overwritten by lineage identity writes.
Base: BWRB origin/main@7093f233 (merged PR #821).
Problem: new --fork and lineage adopt hold path-keyed lineage locks while inserting id/forked-from with byte-preserving atomic writes. Ordinary edit previously read without those locks and later serialized stale bytes, so it could erase identity/provenance.
Acceptance:
1. Identity/provenance writes detect note-byte changes after authoritative reads and fail or safely retry without overwriting concurrent ordinary edit.
2. Deterministic text and JSON behavior with stable retryable error when automatic retry is unsafe.
3. Focused deterministic edit-vs-new --fork and edit-vs-lineage adopt race coverage.
4. Preserve byte-sensitive YAML/body invariants and forked-from immutability outside sanctioned workflows.
5. Existing fork, adoption, audit, lineage-lock, edit, recurrence, and full suites stay green.
Scope: narrowly edit/fork/adopt coordination; no general bulk/audit/template/migration transaction redesign.

Implemented design/evidence:
- edit performs full unlocked read/validation, then short withLineageMutationLocks commit phase and exact raw-byte comparison.
- JSON patch retries from a new full parse/validation up to three attempts; interactive edit does not replay stale answers.
- recurrence prepare/write/commit occurs inside the guarded phase per fresh attempt.
- fork/adopt pre-write assertions; rollback restores only when bytes still equal this command's own write.
- shared typed conflict maps top-level numeric code 2 and data.reason=note-modified-concurrently, retryable=true, vault-relative path, attempts across edit, search --edit, new --fork, lineage adopt.
- real CLI handshake tests: edit-vs-fork; edit-vs-adopt; JSON/text retry exhaustion; search --edit mapping; interactive stale unit path; adoption rollback newer-writer guard.
- Node22 exact parity: build, verify:pack, typecheck, lint, knip, 3037 passed/3 skipped across 115 files.
- built dist disposable user story: adopt backfilled IDs during paused edit, edit replayed, lineage list correct, audit issue codes empty, body hashes unchanged/prose retained.
- docs gates/build passed.
- unrelated external editors cannot take BWRB locks; docs honestly limit the guarantee and note exact-byte precommit detection.
- originating user explicitly requires durable plan/review artifacts under .task-sweep/logs. The already-committed early plan prompt/output/metadata are intentional evidence and excluded from the implementation diff below only to keep this review packet bounded; their manifest is:
  .task-sweep/logs/claude-fable-5-plan-prompt-20260710-121000-issue-820.md
  .task-sweep/logs/claude-fable-5-plan-output-20260710-121000-issue-820.md
  .task-sweep/logs/claude-fable-5-plan-20260710-121000-issue-820.log
END TASK / SPEC

BEGIN REPO STANDARDS
- TypeScript ESM Commander CLI, Node 22, pnpm 10.11.0.
- Exact parity order: build; verify:pack; typecheck; lint; knip; pnpm test excluding PTY.
- Canonical behavior docs under docs-site/src/content/docs; update docs/skill/SKILL.md when automation contract changes.
- id and forked-from are reserved system fields and ordinary edit must not accept them.
- lineage path locks are cross-process, path-keyed, sorted, fail-closed; established nesting order is path locks then note-ID assignment lock.
- writeFileAtomic is temp+fsync+rename, not a general compare-and-swap.
- Do not hold lineage locks across human prompts.
- Generated task-sweep logs are user-required evidence, not runtime code.
END REPO STANDARDS

BEGIN IMPLEMENTATION DIFF
diff --git a/CHANGELOG.md b/CHANGELOG.md
index d9529af..4f24f6c 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -10,6 +10,7 @@ All notable changes to Bowerbird are documented in this file.
 
 ### Fixed
 
+- **Edit/lineage write races** — ordinary edit commits now coordinate with fork/adopt path locks and compare exact raw-byte snapshots; JSON patches replay safely from fresh bytes, exhausted or unsafe conflicts return stable retryable text/JSON output, and fork/adopt pre-write plus rollback guards preserve newer note bytes (#820).
 - **Portable lineage mutation locking** — lineage and note-ID locks now fail closed on Windows sharing/permission errors, have deterministic real-process stress coverage plus a focused Windows CI lane, and return stable retryable text/JSON context when a non-force delete target disappears before its authoritative under-lock recheck (#807).
 - **Body-only content targeting** — `--body` now excludes YAML frontmatter in both note filtering and detailed match reports while preserving original file line numbers and body-only context (#812).
 

diff --git a/docs-site/src/content/docs/automation/json-mode.md b/docs-site/src/content/docs/automation/json-mode.md
index 822bdec..126157c 100644
--- a/docs-site/src/content/docs/automation/json-mode.md
+++ b/docs-site/src/content/docs/automation/json-mode.md
@@ -32,6 +32,12 @@ complete JSON value, but success shapes differ by workflow:
 | `new --fork ... --output json` | `{ "success": true, "path", "id", "forked_from", "warnings" }` |
 | `lineage adopt ... --output json` | `{ "success": true, "mode", "child", "parent", "changes", "warnings", "body_invariance" }` |
 
+Guarded note writers use numeric top-level error codes. If edit, fork, or
+adoption observes newer note bytes, exit code `2` includes
+`data.reason: "note-modified-concurrently"`, `data.retryable: true`, the
+vault-relative `data.path`, and `data.attempts`. JSON edit retries internally up
+to three times before returning that error.
+
 Normal list output is intentionally a raw array:
 
 ```bash

diff --git a/docs-site/src/content/docs/changelog.md b/docs-site/src/content/docs/changelog.md
index 38859b3..c4b8b82 100644
--- a/docs-site/src/content/docs/changelog.md
+++ b/docs-site/src/content/docs/changelog.md
@@ -13,6 +13,7 @@ For the complete changelog with all details, see [CHANGELOG.md](https://github.c
 
 - **Existing-note lineage adoption** — `bwrb lineage adopt <child> --from <parent>` adds a dry-run-first, lock-coordinated path for recording known derivation between existing same-type notes without rewriting their bodies or ordinary metadata
 - **Portable lineage mutation locking** — fork, adopt, delete, and note-ID coordination now have real cross-process stress coverage, a focused Windows CI lane, and stable retryable output when a non-force delete target disappears while waiting for its lock
+- **Edit/lineage concurrency** — edit commits now share fork/adopt path locks, replay stale JSON patches from fresh bytes, and return stable retryable output without overwriting newer identity or provenance writes
 
 ### 0.2.3
 

diff --git a/docs-site/src/content/docs/reference/commands/edit.md b/docs-site/src/content/docs/reference/commands/edit.md
index 12260aa..cdbc77f 100644
--- a/docs-site/src/content/docs/reference/commands/edit.md
+++ b/docs-site/src/content/docs/reference/commands/edit.md
@@ -61,6 +61,37 @@ bwrb edit -t task --where "status == 'active'" "Deploy" --json '{"priority":"hig
 
 `--json` mode rejects patch fields that are not defined for the resolved note type. Existing legacy or unknown fields in the note are preserved unless the patch changes them.
 
+## Concurrent lineage changes
+
+The final edit commit shares the note's lineage mutation lock with `new --fork`
+and `lineage adopt`. Bowerbird compares the note's exact raw bytes after taking
+the lock. A JSON patch that became stale is replayed against the latest note up
+to three times, so a concurrent `id` backfill or `forked-from` edge is preserved.
+Interactive answers are never replayed against unseen values; the command asks
+you to retry instead.
+
+If all JSON retries become stale, JSON output uses numeric exit code `2` and
+stable retry context:
+
+```json
+{
+  "success": false,
+  "error": "Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.",
+  "code": 2,
+  "data": {
+    "reason": "note-modified-concurrently",
+    "retryable": true,
+    "path": "Ideas/My Note.md",
+    "attempts": 3
+  }
+}
+```
+
+This coordination covers Bowerbird edit, fork, and adoption processes. The
+raw-byte check also detects an external editor change that lands before the
+guarded comparison, but Bowerbird cannot lock unrelated editors; retry if an
+external writer remains active.
+
 ### Edit and Open
 
 ```bash
@@ -105,4 +136,5 @@ When multiple notes match your query:
 
 - [bwrb list](/reference/commands/list/) — Find or open notes without editing
 - [bwrb bulk](/reference/commands/bulk/) — Batch frontmatter changes
+- [bwrb lineage](/reference/commands/lineage/) — Guarded document provenance
 - [Targeting Model](/reference/targeting/) — Selector reference

diff --git a/docs-site/src/content/docs/reference/commands/lineage.md b/docs-site/src/content/docs/reference/commands/lineage.md
index 3f36e49..6e94f34 100644
--- a/docs-site/src/content/docs/reference/commands/lineage.md
+++ b/docs-site/src/content/docs/reference/commands/lineage.md
@@ -52,14 +52,20 @@ ID, execute mode assigns a fresh UUID and records it in `.bwrb/ids.jsonl` as
 part of the guarded operation. Parent and child paths are locked together, the
 notes and graph are re-read under those locks, and ID assignment shares the
 same lock used by `new --fork`. Concurrent fork, non-force delete, and adoption
-operations therefore serialize on every path they share.
+operations therefore serialize on every path they share. Ordinary `bwrb edit`
+now joins those path locks for its short commit phase and replays a stale JSON
+patch from fresh bytes, preventing an edit from erasing a newly assigned ID or
+provenance edge.
 
 Only the missing `id` fields and the child's new `forked-from` field may change.
 The writer inserts plain scalars without reserializing YAML, and verifies that
 the parsed bodies and all ordinary frontmatter remain unchanged. Filenames,
 aliases, provider metadata, bodies, and other frontmatter are not rewritten.
 If the two-note write or registry update fails, changed note bytes are rolled
-back before the command reports failure.
+back before the command reports failure. Rollback restores a note only when it
+still contains adoption's own write; bytes from a newer writer are left intact.
+A pre-write byte conflict is retryable and uses numeric JSON `code: 2` with
+`data.reason: "note-modified-concurrently"`.
 
 ## Examples
 

diff --git a/docs-site/src/content/docs/reference/commands/new.md b/docs-site/src/content/docs/reference/commands/new.md
index bb2feb2..865c258 100644
--- a/docs-site/src/content/docs/reference/commands/new.md
+++ b/docs-site/src/content/docs/reference/commands/new.md
@@ -182,7 +182,11 @@ bwrb new --fork "Launch Brief" --label alternate --output json
 Targets are exact: bwrb never substitutes a fuzzy near-match. Duplicate names
 or aliases must be disambiguated with a path or UUID. A legacy source without an
 `id` receives one before the fork is written; an invalid existing ID is rejected
-without modification.
+without modification. Source-ID backfill and ordinary `bwrb edit` commits share
+a path lock and compare their authoritative raw-byte snapshots before writing,
+so a stale writer cannot erase the other operation. A detected conflict is
+retryable; JSON uses `data.reason: "note-modified-concurrently"` and numeric
+`code: 2`.
 
 The child copies the source body and frontmatter, then:
 

diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index eead77a..29e19c4 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -223,6 +223,13 @@ plus the child's `forked-from`. A successful JSON result has `mode`, `child`,
 `body_invariance.*.unchanged` values to be `true`. IDs shown as generated in a
 dry run are provisional until execute revalidates under locks.
 
+Fork, adoption, and ordinary edit commits share path locks. If a guarded
+identity/provenance write observes changed raw bytes, JSON reports numeric
+`code: 2` with `data.reason: "note-modified-concurrently"`,
+`data.retryable: true`, `data.path`, and `data.attempts`. Re-resolve and retry;
+never work around the conflict by attempting to set `id` or `forked-from`
+through ordinary edit.
+
 Deleting a document with direct fork children refuses unless `--force` is
 supplied. With `--force`, bwrb deletes only the selected document: children keep
 their `forked-from` value, which surfaces as `dangling-forked-from` in
@@ -392,6 +399,7 @@ bwrb edit --type task --where "status == 'active'" "Deploy" --json '{"status": "
 Notes:
 - If multiple notes share the same name, `bwrb edit` errors and lists candidates. Disambiguate with `--type`, `--path`, or a vault-relative path.
 - `bwrb new --json` rejects unknown frontmatter fields after merging template defaults. `bwrb edit --json` rejects unknown fields in the patch.
+- Edit commits coordinate with fork/adopt lineage writes. JSON patches replay from fresh bytes up to three times; on exhaustion, retry only when JSON has numeric `code: 2`, `data.reason: "note-modified-concurrently"`, and `data.retryable: true`. Interactive edits do not replay answers gathered from stale values.
 
 ### Deleting Notes
 

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

diff --git a/src/commands/lineage/adopt.ts b/src/commands/lineage/adopt.ts
index 57621b1..85efb0a 100644
--- a/src/commands/lineage/adopt.ts
+++ b/src/commands/lineage/adopt.ts
@@ -23,6 +23,10 @@ import {
   getLineageMutationLockPath,
   withLineageMutationLocks,
 } from '../../lib/lineage-lock.js';
+import {
+  assertNoteBytesUnchanged,
+  rollbackNoteIfUnchanged,
+} from '../../lib/note-write-concurrency.js';
 
 export type LineageAdoptMode = 'dry-run' | 'execute';
 
@@ -266,21 +270,43 @@ async function applyPreparedAdoption(
   let childWritten = false;
   try {
     if (prepared.parentNextRaw !== prepared.parentOriginal.raw) {
+      await assertNoteBytesUnchanged(
+        prepared.parent.file.path,
+        prepared.parentOriginal.raw
+      );
       await writeFileAtomic(prepared.parent.file.path, prepared.parentNextRaw);
       parentWritten = true;
     }
+    await assertNoteBytesUnchanged(
+      prepared.child.file.path,
+      prepared.childOriginal.raw
+    );
     await writeFileAtomic(prepared.child.file.path, prepared.childNextRaw);
     childWritten = true;
     await registerIds(vaultDir, prepared.registrations);
   } catch (error) {
     const rollbackErrors: string[] = [];
     if (childWritten) {
-      await writeFileAtomic(prepared.child.file.path, prepared.childOriginal.raw)
-        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
+      await rollbackNoteIfUnchanged(
+        prepared.child.file.path,
+        prepared.childNextRaw,
+        prepared.childOriginal.raw
+      ).then(rolledBack => {
+        if (!rolledBack) {
+          rollbackErrors.push(`${prepared.child.file.relativePath} changed again; newer bytes left as-is`);
+        }
+      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
     }
     if (parentWritten) {
-      await writeFileAtomic(prepared.parent.file.path, prepared.parentOriginal.raw)
-        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
+      await rollbackNoteIfUnchanged(
+        prepared.parent.file.path,
+        prepared.parentNextRaw,
+        prepared.parentOriginal.raw
+      ).then(rolledBack => {
+        if (!rolledBack) {
+          rollbackErrors.push(`${prepared.parent.file.relativePath} changed again; newer bytes left as-is`);
+        }
+      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
     }
     if (rollbackErrors.length > 0) {
       throw new Error(

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

diff --git a/src/commands/new/fork.ts b/src/commands/new/fork.ts
index c7032c6..89694b6 100644
--- a/src/commands/new/fork.ts
+++ b/src/commands/new/fork.ts
@@ -28,6 +28,10 @@ import { promptInput } from '../../lib/prompt.js';
 import { UserCancelledError } from '../../lib/errors.js';
 import { resolveExactNoteTarget } from '../../lib/exact-note-target.js';
 import { withLineageMutationLocks } from '../../lib/lineage-lock.js';
+import {
+  assertNoteBytesUnchanged,
+  rollbackNoteIfUnchanged,
+} from '../../lib/note-write-concurrency.js';
 
 const PORTABLE_PATH_WARNING_LENGTH = 200;
 const PORTABLE_PATH_MAX_LENGTH = 260;
@@ -209,17 +213,28 @@ async function ensureSourceId(
       throw new Error('Generated source ID collides with an existing note; retry the command.');
     }
     const nextRaw = insertFrontmatterScalarPreservingBytes(parsed.raw, 'id', id);
+    await assertNoteBytesUnchanged(sourcePath, parsed.raw);
     await writeFileAtomic(sourcePath, nextRaw);
     try {
       await registerIssuedNoteId(vaultDir, id, sourcePath);
     } catch (error) {
-      await writeFileAtomic(sourcePath, parsed.raw);
+      const rolledBack = await rollbackNoteIfUnchanged(sourcePath, nextRaw, parsed.raw);
+      if (!rolledBack) {
+        throw new Error(
+          `Source ID registration failed (${formatError(error)}) and rollback was skipped because ` +
+          'the source changed again; newer bytes were preserved.'
+        );
+      }
       throw error;
     }
     return id;
   });
 }
 
+function formatError(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
+
 async function assertSourceIdUnique(
   schema: LoadedSchema,
   vaultDir: string,

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

diff --git a/src/lib/edit.ts b/src/lib/edit.ts
index 1dad10b..9c9ebb4 100644
--- a/src/lib/edit.ts
+++ b/src/lib/edit.ts
@@ -6,7 +6,8 @@
  * - `search --edit` (unified interface)
  */
 
-import { relative } from 'path';
+import { access, mkdir, writeFile } from 'fs/promises';
+import { join, relative } from 'path';
 import {
   getTypeDefByPath,
   resolveTypePathFromFrontmatter,
@@ -43,11 +44,13 @@ import {
   ExitCodes,
 } from './output.js';
 import { type LoadedSchema, type Field, type BodySection, getOptionValues } from '../types/schema.js';
-import { UserCancelledError } from './errors.js';
+import { ConcurrentNoteModificationError, UserCancelledError } from './errors.js';
 import { expandStaticValue } from './local-date.js';
 import { prepareRecurrenceFastPath, commitRecurrenceFastPath } from './recurrence-fast-path.js';
 import { validateRelativeDateCalendarOffsetsForWrite } from './relative-date.js';
 import { isBwrbReservedFrontmatterField } from './frontmatter/systemFields.js';
+import { withLineageMutationLocks } from './lineage-lock.js';
+import { assertNoteBytesUnchanged } from './note-write-concurrency.js';
 
 // ============================================================================
 // Types
@@ -66,8 +69,12 @@ export interface EditFromJsonOptions {
 export interface EditInteractiveOptions {
   /** Whether to check for missing body sections */
   checkSections?: boolean;
+  /** Internal dependency hook for deterministic commit-race tests. */
+  beforeCommit?: () => Promise<void>;
 }
 
+const JSON_EDIT_ATTEMPTS = 3;
+
 // ============================================================================
 // JSON Edit Mode (Non-Interactive)
 // ============================================================================
@@ -117,8 +124,41 @@ export async function editNoteFromJson(
     throw new Error(error);
   }
 
+  for (let attempt = 1; attempt <= JSON_EDIT_ATTEMPTS; attempt++) {
+    try {
+      return await editNoteFromJsonAttempt(
+        schema,
+        vaultDir,
+        filePath,
+        patchData,
+        jsonMode,
+        attempt
+      );
+    } catch (error) {
+      if (
+        error instanceof ConcurrentNoteModificationError &&
+        attempt < JSON_EDIT_ATTEMPTS
+      ) {
+        continue;
+      }
+      throw error;
+    }
+  }
+
+  throw new ConcurrentNoteModificationError(filePath, JSON_EDIT_ATTEMPTS);
+}
+
+async function editNoteFromJsonAttempt(
+  schema: LoadedSchema,
+  vaultDir: string,
+  filePath: string,
+  patchData: Record<string, unknown>,
+  jsonMode: boolean,
+  attempt: number
+): Promise<EditResult> {
+
   // Parse existing note
-  const { frontmatter, body } = await parseNote(filePath);
+  const { frontmatter, body, raw } = await parseNote(filePath);
 
   // Resolve type path from existing frontmatter
   const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
@@ -308,27 +348,25 @@ export async function editNoteFromJson(
   const fieldOrder = getFrontmatterOrder(typeDef);
   const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(resolvedFrontmatter);
 
-  // Recurrence fast path (atomicity, #107): VALIDATE + COMPUTE the successor
-  // BEFORE mutating the predecessor. If this completion would spawn a successor
-  // but the spawn can't succeed (missing template, partial/unparseable offset
-  // base), prepare throws here and we abort WITHOUT writing the predecessor —
-  // never leaving it `done` with no successor.
-  const fastPathPlan = await prepareRecurrenceFastPath(
-    schema,
-    vaultDir,
-    typeDef.name,
-    filePath,
-    frontmatter,
-    resolvedFrontmatter,
-    body
-  );
+  await waitForEditCommitBarrier(attempt, filePath);
 
-  // Write updated note (predecessor status change is now safe to commit).
-  await writeNote(filePath, resolvedFrontmatter, body, orderedFields);
+  await withLineageMutationLocks(vaultDir, [filePath], async () => {
+    await assertNoteBytesUnchanged(filePath, raw, attempt);
 
-  // Commit the prepared spawn (create successor + back-link `next`). Identical
-  // result to the audit backstop, which shares the same engine.
-  await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
+    // Recurrence prepare, predecessor write, and successor/back-link commit are
+    // one guarded commit phase. A retry always re-prepares from fresh bytes.
+    const fastPathPlan = await prepareRecurrenceFastPath(
+      schema,
+      vaultDir,
+      typeDef.name,
+      filePath,
+      frontmatter,
+      resolvedFrontmatter,
+      body
+    );
+    await writeNote(filePath, resolvedFrontmatter, body, orderedFields);
+    await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
+  });
 
   return { updatedFields, path: filePath };
 }
@@ -351,9 +389,9 @@ export async function editNoteInteractive(
   filePath: string,
   options: EditInteractiveOptions = {}
 ): Promise<void> {
-  const { checkSections = true } = options;
+  const { checkSections = true, beforeCommit } = options;
   
-  const { frontmatter, body } = await parseNote(filePath);
+  const { frontmatter, body, raw } = await parseNote(filePath);
   const fileName = filePath.split('/').pop() ?? filePath;
 
   printInfo(`\n=== Editing: ${fileName} ===`);
@@ -421,25 +459,22 @@ export async function editNoteInteractive(
     }
   }
 
-  // Recurrence fast path (atomicity, #107): VALIDATE + COMPUTE before mutating
-  // the predecessor (see editNoteFromJson). Interactive edit reconstructs the
-  // full frontmatter, so `frontmatter` (read at the top) is the old state.
-  const fastPathPlan = await prepareRecurrenceFastPath(
-    schema,
-    vaultDir,
-    typeDef.name,
-    filePath,
-    frontmatter,
-    newFrontmatter,
-    updatedBody
-  );
-
-  // Write updated file (predecessor change is now safe to commit).
-  await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
+  await beforeCommit?.();
+  const fastPath = await withLineageMutationLocks(vaultDir, [filePath], async () => {
+    await assertNoteBytesUnchanged(filePath, raw);
+    const fastPathPlan = await prepareRecurrenceFastPath(
+      schema,
+      vaultDir,
+      typeDef.name,
+      filePath,
+      frontmatter,
+      newFrontmatter,
+      updatedBody
+    );
+    await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
+    return commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
+  });
   printSuccess(`\n✓ Updated: ${filePath}`);
-
-  // Commit the prepared spawn.
-  const fastPath = await commitRecurrenceFastPath(schema, vaultDir, fastPathPlan);
   if (fastPath.successorPath) {
     printSuccess(`✓ Spawned recurrence successor: ${fastPath.successorPath}`);
   }
@@ -449,6 +484,28 @@ export async function editNoteInteractive(
 // Helpers
 // ============================================================================
 
+/** File handshake used only by cross-process race tests. */
+async function waitForEditCommitBarrier(attempt: number, filePath: string): Promise<void> {
+  const barrierDir = process.env.BWRB_TEST_EDIT_BARRIER_DIR;
+  if (!barrierDir) return;
+
+  await mkdir(barrierDir, { recursive: true });
+  const readyPath = join(barrierDir, `edit-read-${attempt}.ready`);
+  const commitPath = join(barrierDir, `edit-commit-${attempt}.go`);
+  await writeFile(readyPath, `${filePath}\n`, 'utf-8');
+
+  const deadline = Date.now() + 20_000;
+  while (Date.now() < deadline) {
+    try {
+      await access(commitPath);
+      return;
+    } catch {
+      await new Promise(resolve => setTimeout(resolve, 5));
+    }
+  }
+  throw new Error(`Timed out waiting for edit test barrier: ${commitPath}`);
+}
+
 function mergeFrontmatter(
   existing: Record<string, unknown>,
   patch: Record<string, unknown>

diff --git a/src/lib/errors.ts b/src/lib/errors.ts
index f28e598..ef5a48d 100644
--- a/src/lib/errors.ts
+++ b/src/lib/errors.ts
@@ -21,3 +21,20 @@ export class UserCancelledError extends Error {
     this.name = 'UserCancelledError';
   }
 }
+
+/**
+ * A note changed after a command's authoritative read but before its guarded
+ * write. Callers must retry from a fresh snapshot rather than overwriting the
+ * newer bytes.
+ */
+export class ConcurrentNoteModificationError extends Error {
+  readonly path: string;
+  readonly attempts: number;
+
+  constructor(path: string, attempts = 1) {
+    super('Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.');
+    this.name = 'ConcurrentNoteModificationError';
+    this.path = path;
+    this.attempts = attempts;
+  }
+}

diff --git a/src/lib/note-write-concurrency.ts b/src/lib/note-write-concurrency.ts
new file mode 100644
index 0000000..4709795
--- /dev/null
+++ b/src/lib/note-write-concurrency.ts
@@ -0,0 +1,44 @@
+import { readFile } from 'fs/promises';
+import { relative } from 'path';
+import { ConcurrentNoteModificationError } from './errors.js';
+import { writeFileAtomic } from './frontmatter.js';
+
+/** Assert that a note still has the exact bytes used to prepare a mutation. */
+export async function assertNoteBytesUnchanged(
+  filePath: string,
+  expectedRaw: string,
+  attempts = 1
+): Promise<void> {
+  const currentRaw = await readFile(filePath, 'utf-8');
+  if (currentRaw !== expectedRaw) {
+    throw new ConcurrentNoteModificationError(filePath, attempts);
+  }
+}
+
+/**
+ * Restore a prior snapshot only when the file still contains this command's
+ * own write. A newer writer always wins; rollback must never erase it.
+ */
+export async function rollbackNoteIfUnchanged(
+  filePath: string,
+  writtenRaw: string,
+  originalRaw: string
+): Promise<boolean> {
+  const currentRaw = await readFile(filePath, 'utf-8');
+  if (currentRaw !== writtenRaw) return false;
+  await writeFileAtomic(filePath, originalRaw);
+  return true;
+}
+
+/** Stable agent-facing details shared by every guarded note writer. */
+export function concurrentModificationData(
+  vaultDir: string,
+  error: ConcurrentNoteModificationError
+): { reason: string; retryable: true; path: string; attempts: number } {
+  return {
+    reason: 'note-modified-concurrently',
+    retryable: true,
+    path: relative(vaultDir, error.path).replace(/\\/g, '/'),
+    attempts: error.attempts,
+  };
+}

diff --git a/tests/ts/commands/edit-lineage-concurrency.test.ts b/tests/ts/commands/edit-lineage-concurrency.test.ts
new file mode 100644
index 0000000..dd793b3
--- /dev/null
+++ b/tests/ts/commands/edit-lineage-concurrency.test.ts
@@ -0,0 +1,260 @@
+import { spawn } from 'child_process';
+import { mkdir, readFile, writeFile } from 'fs/promises';
+import { join } from 'path';
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import {
+  CLI_PATH,
+  PROJECT_ROOT,
+  cleanupTestVault,
+  createTestVault,
+  runCLI,
+  waitForFile,
+  withTestCliNodeOptions,
+} from '../fixtures/setup.js';
+import { insertFrontmatterScalarPreservingBytes, parseNote } from '../../../src/lib/frontmatter.js';
+import { loadSchema } from '../../../src/lib/schema.js';
+import { editNoteInteractive } from '../../../src/lib/edit.js';
+import { ConcurrentNoteModificationError } from '../../../src/lib/errors.js';
+
+const CLI_SRC_PATH = join(PROJECT_ROOT, 'src/index.ts');
+const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
+const USE_DIST = process.env.BWRB_TEST_DIST === '1';
+const CHILD_ID = '11111111-1111-4111-8111-111111111111';
+const PARENT_ID = '22222222-2222-4222-8222-222222222222';
+
+interface RunningCli {
+  completion: Promise<{ stdout: string; stderr: string; exitCode: number }>;
+  kill: () => void;
+}
+
+function spawnCli(args: string[], cwd: string, barrierDir: string): RunningCli {
+  const command = process.execPath;
+  const cliArgs = USE_DIST
+    ? [CLI_PATH, '--vault', cwd, ...args]
+    : [TSX_CLI, CLI_SRC_PATH, '--vault', cwd, ...args];
+  const child = spawn(command, cliArgs, {
+    cwd,
+    env: withTestCliNodeOptions({
+      ...process.env,
+      NO_COLOR: '1',
+      BWRB_TEST_EDIT_BARRIER_DIR: barrierDir,
+    }, { useDist: USE_DIST }),
+    stdio: ['ignore', 'pipe', 'pipe'],
+  });
+
+  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
+    (resolve, reject) => {
+      let stdout = '';
+      let stderr = '';
+      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
+      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
+      child.on('error', reject);
+      child.on('close', code => resolve({
+        stdout: stdout.trim(),
+        stderr: stderr.trim(),
+        exitCode: code ?? 0,
+      }));
+    }
+  );
+  return { completion, kill: () => child.kill('SIGKILL') };
+}
+
+async function releaseAttempt(barrierDir: string, attempt: number): Promise<void> {
+  await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
+  await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
+}
+
+describe('edit versus lineage identity writes', () => {
+  let vaultDir: string;
+  const running: RunningCli[] = [];
+
+  beforeEach(async () => {
+    vaultDir = await createTestVault();
+  });
+
+  afterEach(async () => {
+    for (const process of running) process.kill();
+    await cleanupTestVault(vaultDir);
+  });
+
+  it('replays a JSON edit after new --fork backfills the source ID', async () => {
+    const sourcePath = join(vaultDir, 'Ideas/Fork Race Source.md');
+    const sourceRaw = '\uFEFF---\r\ntype: "idea" # quoted\r\nstatus: raw\r\npriority: medium\r\nprovider: { remote: keep-me }\r\n---\r\nBody bytes.\r\n';
+    await writeFile(sourcePath, sourceRaw);
+    const barrierDir = join(vaultDir, '.barrier-fork');
+    const edit = spawnCli([
+      'edit', sourcePath, '--json', '{"priority":"high"}', '--output', 'json',
+    ], vaultDir, barrierDir);
+    running.push(edit);
+
+    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
+    const fork = await runCLI([
+      'new', '--fork', sourcePath, '--name', 'Fork Race Child', '--output', 'json',
+    ], vaultDir);
+    expect(fork.exitCode, fork.stderr || fork.stdout).toBe(0);
+    const forkJson = JSON.parse(fork.stdout) as { id: string; forked_from: string; path: string };
+    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
+    await releaseAttempt(barrierDir, 2);
+
+    const edited = await edit.completion;
+    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
+    expect(JSON.parse(edited.stdout)).toMatchObject({ success: true, updated: ['priority'] });
+    const source = await parseNote(sourcePath);
+    expect(source.frontmatter).toMatchObject({
+      id: forkJson.forked_from,
+      priority: 'high',
+      provider: { remote: 'keep-me' },
+    });
+    expect(source.body).toBe('Body bytes.\r\n');
+    expect((await parseNote(join(vaultDir, forkJson.path))).frontmatter['forked-from'])
+      .toBe(forkJson.forked_from);
+
+    const expectedPath = join(vaultDir, 'Ideas/Fork Race Expected.md');
+    await writeFile(
+      expectedPath,
+      insertFrontmatterScalarPreservingBytes(sourceRaw, 'id', forkJson.forked_from)
+    );
+    const sequential = await runCLI([
+      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
+    ], vaultDir);
+    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
+    expect(await readFile(sourcePath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
+  });
+
+  it('replays a JSON edit after lineage adopt writes immutable provenance', async () => {
+    const childPath = join(vaultDir, 'Ideas/Adopt Race Child.md');
+    const parentPath = join(vaultDir, 'Ideas/Adopt Race Parent.md');
+    const childRaw = `---\ntype: idea\nid: ${CHILD_ID}\nstatus: raw\npriority: medium\nprovider: { remote: child }\n---\nChild body.\n`;
+    const parentRaw = `---\ntype: idea\nid: ${PARENT_ID}\nstatus: raw\npriority: medium\n---\nParent body.\n`;
+    await writeFile(childPath, childRaw);
+    await writeFile(parentPath, parentRaw);
+    const barrierDir = join(vaultDir, '.barrier-adopt');
+    const edit = spawnCli([
+      'edit', childPath, '--json', '{"priority":"high"}', '--output', 'json',
+    ], vaultDir, barrierDir);
+    running.push(edit);
+
+    await waitForFile(join(barrierDir, 'edit-read-1.ready'), { timeoutMs: 10_000 });
+    const adopted = await runCLI([
+      'lineage', 'adopt', childPath, '--from', parentPath, '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(adopted.exitCode, adopted.stderr || adopted.stdout).toBe(0);
+    await writeFile(join(barrierDir, 'edit-commit-1.go'), 'go\n');
+    await releaseAttempt(barrierDir, 2);
+
+    const edited = await edit.completion;
+    expect(edited.exitCode, edited.stderr || edited.stdout).toBe(0);
+    const child = await parseNote(childPath);
+    expect(child.frontmatter).toMatchObject({
+      id: CHILD_ID,
+      'forked-from': PARENT_ID,
+      priority: 'high',
+      provider: { remote: 'child' },
+    });
+    expect(child.body).toBe('Child body.\n');
+
+    const expectedPath = join(vaultDir, 'Ideas/Adopt Race Expected.md');
+    await writeFile(
+      expectedPath,
+      insertFrontmatterScalarPreservingBytes(childRaw, 'forked-from', PARENT_ID)
+    );
+    const sequential = await runCLI([
+      'edit', expectedPath, '--json', '{"priority":"high"}', '--output', 'json',
+    ], vaultDir);
+    expect(sequential.exitCode, sequential.stderr || sequential.stdout).toBe(0);
+    expect(await readFile(childPath, 'utf-8')).toBe(await readFile(expectedPath, 'utf-8'));
+  });
+
+  it.each(['json', 'text'] as const)(
+    'preserves the newest bytes and emits a stable retryable %s error after retry exhaustion',
+    async (output) => {
+      const notePath = join(vaultDir, `Ideas/Retry Exhaustion ${output}.md`);
+      let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nOriginal body.\n';
+      await writeFile(notePath, currentRaw);
+      const barrierDir = join(vaultDir, `.barrier-${output}`);
+      const edit = spawnCli([
+        'edit', notePath, '--json', '{"priority":"high"}', '--output', output,
+      ], vaultDir, barrierDir);
+      running.push(edit);
+
+      for (let attempt = 1; attempt <= 3; attempt++) {
+        await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
+        currentRaw = currentRaw.replace('Original body.', `Original body. external-${attempt}`);
+        await writeFile(notePath, currentRaw);
+        await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
+      }
+
+      const result = await edit.completion;
+      expect(result.exitCode).toBe(2);
+      expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
+      if (output === 'json') {
+        expect(JSON.parse(result.stdout)).toEqual({
+          success: false,
+          error: 'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.',
+          code: 2,
+          data: {
+            reason: 'note-modified-concurrently',
+            retryable: true,
+            path: `Ideas/Retry Exhaustion ${output}.md`,
+            attempts: 3,
+          },
+        });
+      } else {
+        expect(result.stdout).toBe('');
+        expect(result.stderr).toContain(
+          'Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.'
+        );
+      }
+    }
+  );
+
+  it('does not replay interactive answers or write when its snapshot is stale', async () => {
+    const notePath = join(vaultDir, 'Ideas/Interactive Stale.md');
+    const originalRaw = '---\ntype: idea\nstatus: raw\n---\nOriginal body.\n';
+    const newerRaw = '---\ntype: idea\nid: 33333333-3333-4333-8333-333333333333\nstatus: raw\n---\nOriginal body.\n';
+    await writeFile(notePath, originalRaw);
+    const schema = await loadSchema(vaultDir);
+    const idea = schema.types.get('idea')!;
+    idea.fields = { type: { value: 'idea' } };
+    idea.fieldOrder = ['type'];
+
+    await expect(editNoteInteractive(schema, vaultDir, notePath, {
+      checkSections: false,
+      beforeCommit: async () => { await writeFile(notePath, newerRaw); },
+    })).rejects.toBeInstanceOf(ConcurrentNoteModificationError);
+    expect(await readFile(notePath, 'utf-8')).toBe(newerRaw);
+  });
+
+  it('maps stale search --edit JSON through the same numeric retryable contract', async () => {
+    const notePath = join(vaultDir, 'Ideas/Search Retry Exhaustion.md');
+    let currentRaw = '---\ntype: idea\nstatus: raw\npriority: medium\n---\nSearch body.\n';
+    await writeFile(notePath, currentRaw);
+    const barrierDir = join(vaultDir, '.barrier-search');
+    const edit = spawnCli([
+      'search', 'Search Retry Exhaustion', '--edit', '--json', '{"priority":"high"}',
+      '--output', 'json', '--picker', 'none',
+    ], vaultDir, barrierDir);
+    running.push(edit);
+
+    for (let attempt = 1; attempt <= 3; attempt++) {
+      await waitForFile(join(barrierDir, `edit-read-${attempt}.ready`), { timeoutMs: 10_000 });
+      currentRaw = currentRaw.replace('Search body.', `Search body. external-${attempt}`);
+      await writeFile(notePath, currentRaw);
+      await writeFile(join(barrierDir, `edit-commit-${attempt}.go`), 'go\n');
+    }
+
+    const result = await edit.completion;
+    expect(result.exitCode).toBe(2);
+    expect(JSON.parse(result.stdout)).toMatchObject({
+      success: false,
+      code: 2,
+      data: {
+        reason: 'note-modified-concurrently',
+        retryable: true,
+        path: 'Ideas/Search Retry Exhaustion.md',
+        attempts: 3,
+      },
+    });
+    expect(await readFile(notePath, 'utf-8')).toBe(currentRaw);
+  });
+});

diff --git a/tests/ts/commands/lineage-adopt.test.ts b/tests/ts/commands/lineage-adopt.test.ts
index 667a38e..aa7de9c 100644
--- a/tests/ts/commands/lineage-adopt.test.ts
+++ b/tests/ts/commands/lineage-adopt.test.ts
@@ -265,6 +265,36 @@ describe('lineage adopt', () => {
     expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);
   });
 
+  it('never rolls adoption back over bytes written after its own child write', async () => {
+    const childPath = join(vaultDir, 'Ideas/Rollback Race Child.md');
+    const parentPath = join(vaultDir, 'Ideas/Rollback Race Parent.md');
+    const childRaw = noteRaw({ body: 'Original child bytes\n' });
+    const parentRaw = noteRaw({ body: 'Original parent bytes\n' });
+    const newerChildRaw = noteRaw({
+      id: C,
+      extra: 'provider: { newer: true }\n',
+      body: 'Newer child bytes\n',
+    });
+    await writeFile(childPath, childRaw);
+    await writeFile(parentPath, parentRaw);
+    const schema = await loadSchema(vaultDir);
+
+    await expect(adoptLineage(
+      schema,
+      vaultDir,
+      { child: 'Rollback Race Child', parent: 'Rollback Race Parent', execute: true },
+      {
+        registerIds: async () => {
+          await writeFile(childPath, newerChildRaw);
+          throw new Error('injected registry failure after a newer writer');
+        },
+      }
+    )).rejects.toThrow('newer bytes left as-is');
+
+    expect(await readFile(childPath, 'utf-8')).toBe(newerChildRaw);
+    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
+  });
+
   it('refuses cycles and ambiguous or missing exact targets', async () => {
     await writeFile(join(vaultDir, 'Ideas/Cycle Root.md'), noteRaw({ id: A }));
     await writeFile(join(vaultDir, 'Ideas/Cycle Child.md'), noteRaw({ id: B, parent: A }));

END IMPLEMENTATION DIFF


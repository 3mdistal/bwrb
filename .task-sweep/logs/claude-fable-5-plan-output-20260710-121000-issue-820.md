# Plan — #820 edit-vs-lineage write race

## 1. Architecture choice

| Option | Verdict |
|---|---|
| Wrap whole JSON/interactive edit in the lineage path lock | ❌ Interactive edit holds a cross-process lock through human prompts; JSON edit holds it through vault-wide scans (context validation, cycle check, snapshot builds). Long holds + 30s acquisition timeout = spurious failures. |
| Commit-phase lock + exact raw-byte stale detection | ✅ Core of the fix. Smallest surface, honest guarantee. |
| Bounded auto-retry (JSON) / stable retryable error (interactive) | ✅ Layer on top of the above for behavior on staleness. |

**Recommended shape** (all in `src/lib/edit.ts`):

1. `parseNote` already returns `raw` — keep the snapshot's `raw` bytes from the initial read.
2. At commit time, wrap the final phase in `withLineageMutationLocks(vaultDir, [filePath], ...)`:
   - Re-read the file, compare **exact raw bytes** to the snapshot.
   - If equal: `prepareRecurrenceFastPath` → `writeNote` → `commitRecurrenceFastPath`, all inside the lock (see Q3).
   - If stale:
     - **JSON edit**: release the lock (or loop inside a fresh acquisition), re-run the full pipeline (parse → merge → defaults → normalize → validate → recurrence prepare) against the *latest* bytes, bounded to **3 attempts**. Safe because the patch is declarative merge semantics — replaying it against the new state is exactly what a user retry would do. After 3 attempts, emit the retryable error.
     - **Interactive edit**: do **not** silently replay (the user's answers were shown against stale current-values). Emit the stable retryable error; nothing written.
3. This means recurrence prepare moves *inside* the lock for the JSON path (it must be re-run per retry attempt anyway since old-frontmatter changes). Interactive edit: run prompts fully unlocked, then do prepare + stale-check + write inside the lock.

Honest guarantee to document: this serializes **BWRB edit vs. BWRB fork/adopt** on the same note. It does not (and cannot, without O_EXCL-rename CAS the filesystem doesn't offer) exclude an unrelated external editor between check and rename — say so explicitly in docs; do not claim general CAS.

## 2. Error ownership and output mapping

- New exported error class in `src/lib/edit.ts` (or a tiny `src/lib/concurrency-error.ts` if fork/adopt share it per Q4): `ConcurrentNoteModificationError { path: string; attempts?: number }`.
- The **command layer** (`src/commands/edit.ts` catch block, alongside `UserCancelledError` handling) owns output mapping — consistent with existing conventions.
- Text: `Error: Note changed on disk while editing; no changes were written. Retry the command.` — exit with the same generic failure code the lineage-lock timeout path uses today (keep exit-code surface unchanged; the *machine* signal lives in JSON).
- JSON (via existing `jsonError` extras):

```json
{
  "success": false,
  "error": "Note changed on disk while editing; no changes were written. Retry the command.",
  "code": "note-modified-concurrently",
  "retryable": true,
  "data": { "path": "<vault-relative>", "attempts": 3 }
}
```

Also map the lock-acquisition timeout inside edit to the same `retryable: true` shape (`code: "lock-timeout"`) so automation has one contract.

## 3. Recurrence interaction

- **Prepare inside the lock, per attempt.** `prepareRecurrenceFastPath` takes old + new frontmatter; on a retry the "old" state changed, so a cached plan is invalid. Re-prepare against the freshly read snapshot inside the lock each attempt. Prepare failing still aborts before `writeNote` — atomicity invariant preserved.
- **Commit inside the same lock.** `commitRecurrenceFastPath` back-links `next` onto the predecessor; that second predecessor write must not race a lineage mutation either, so keep it within the held lock.
- **Reentrancy trap:** `withLineageMutationLocks` is not reentrant. Verify `commitRecurrenceFastPath` (and successor ID registration) never acquires a *path* lock for the predecessor — if it takes the global note-ID assignment lock, that's fine and matches the established order (path locks → ID lock, same as fork/adopt). Never the reverse.

## 4. Fork/adopt pre-write assertions

Making edit lock-aware closes the stated race by itself (lineage writers already hold the lock across read→write). But acceptance #1 asks identity writes to *detect* staleness, and it's cheap defense-in-depth against non-BWRB writers:

- `ensureSourceId` (fork): it re-parses inside the lock and writes almost immediately — add a re-read + byte-compare against `parsed.raw` immediately before `writeFileAtomic`; on mismatch throw the retryable error. **Rollback guard:** the registry-failure rollback (`writeFileAtomic(sourcePath, parsed.raw)`) must first read current bytes and only restore if they equal `nextRaw` we just wrote; otherwise report incomplete rollback without clobbering.
- `applyPreparedAdoption`: before each of the two writes, re-read and compare with `parentOriginal.raw` / `childOriginal.raw`. **Rollback guard (data-loss risk):** current rollback blindly restores originals — if a newer write landed, rollback destroys it. Change each rollback to CAS-style: restore only if current bytes == the `nextRaw` this process wrote; else append to `rollbackErrors` with a "left as-is" note.

Map these to the same `note-modified-concurrently` retryable output in the fork/adopt command handlers (fork could safely auto-retry once since it holds the lock; a single bounded retry inside the lock is acceptable, but failing retryable is also fine — keep it simple: fail retryable).

## 5. Deterministic tests

Use real CLI child processes with **file-based handshakes** (matches the PR #821 fixture style), no sleeps:

- **Seam:** a tiny test-only barrier in edit's commit path: if `BWRB_TEST_BARRIER_DIR` is set, after the initial `parseNote` write `<dir>/edit-read.ready`, then poll (short interval, generous deadline) for `<dir>/edit-commit.go` before entering the lock. No-op when unset; keep it one guarded function so knip/lint stay clean.
- **Test A (edit-vs-fork, JSON retry):** start `bwrb edit --json '{"status":"done"}'` with barrier dir → wait for `edit-read.ready` → run `bwrb new --fork <source>` to completion → touch `edit-commit.go` → assert edit exits 0, final file contains **both** the backfilled `id` (byte-exact insertion preserved) and the patch, registry consistent.
- **Test B (edit-vs-adopt, same shape):** adopt inserts `forked-from` (+ maybe `id`) during the pause; assert JSON edit retry preserves both system fields; assert `forked-from` value untouched by the edit.
- **Test C (interactive stale):** same handshake but interactive edit driven via scripted stdin (existing non-PTY interactive harness); assert stable retryable error, exit code, and **file bytes unchanged** from the lineage result.
- **Test D (lock blocking):** fixture child holds the path lock (existing #821 fixture) while `bwrb edit --json` runs → assert edit blocks then succeeds after release; and a never-released hold → assert `lock-timeout` retryable JSON (use small `retryMs/attempts` override if the fixture exposes it, or accept the env-tunable override if one exists — don't add new prod knobs beyond what #821 established).
- **Test E (adopt rollback guard):** unit-level — inject failing `dependencies.registerIds`, mutate child bytes between write and rollback via the dependency hook, assert rollback does not restore stale originals.
- Byte-invariant assertions everywhere: compare full file contents, not parsed frontmatter, to protect EOL/quote/comment preservation.

## 6. Docs, gates, scope traps

**Docs:** docs-site edit page (concurrent-modification behavior, retryable JSON contract, honest external-editor caveat), fork + lineage adopt pages (new conflict error), `docs/skill/SKILL.md` (new `code`/`retryable` fields = automation contract change), changelog entry.

**Focused commands:** targeted vitest runs for the new concurrency specs, then existing edit, fork, adoption, lineage-lock, audit, recurrence suites.

**Full gates, exact order:** `build`, `verify:pack`, `typecheck`, `lint`, `knip`, non-PTY tests. Draft PR → full TaskSweep → ready → normal merge after every gate; no early merge.

**Scope traps:** don't convert `writeNote`/`writeFileAtomic` into a general CAS primitive; don't touch bulk/audit/template/migration writers; don't add locks around interactive prompts; don't extend to multi-note edit coordination; don't change exit-code numbering.

## 7. Deadlock / data-loss callouts

1. **Lock order invariant:** path lineage locks (sorted) → global note-ID lock, always. Edit's new lock nests recurrence commit's ID registration correctly; audit the recurrence engine to confirm it never takes a path lock.
2. **Non-reentrant locks:** edit must own the lock scope and never call anything that re-acquires the same path lock (recurrence back-link is the risk point).
3. **Adopt rollback clobber:** fixed via CAS-guarded rollback (Q4) — this is the single real data-loss bug beyond the headline race; fix it in the same PR since it's in-scope for "rollback cannot clobber a newer edit."
4. **Retry livelock:** bounded at 3 attempts with the retryable error as the floor — deterministic output either way.
5. **Fork's `ensureSourceId` rollback** has the same clobber shape; guard identically.
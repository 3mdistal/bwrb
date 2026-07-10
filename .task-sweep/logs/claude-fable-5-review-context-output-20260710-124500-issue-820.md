NO BLOCKERS

## SPEC FIDELITY

The prior review's spec conclusions hold, and the follow-up delta resolves both open items:

1. **Docs ambiguity fixed** — all three surfaces now state "up to three total attempts (the initial attempt plus at most two retries)": `json-mode.md`, `edit.md`, and `SKILL.md`. This matches `JSON_EDIT_ATTEMPTS = 3` and `data.attempts: 3` exactly. No remaining drift.
2. **Test barrier gate fixed** — `waitForEditCommitBarrier` now requires both `BWRB_TEST_EDIT_BARRIER_ENABLED === '1'` and `BWRB_TEST_EDIT_BARRIER_DIR`, and the test spawner sets both. The prior risk (a leaked dir var hanging every JSON edit 20s/attempt) is closed; accidental activation now requires two deliberate env settings. Barrier placement remains correct: before lock acquisition, so no lock is held during the handshake.
3. **Output mapping** — all four handlers (edit, new, search, lineage adopt) emit numeric `code: 2` with `reason/retryable/path/attempts`; the retry-exhaustion tests assert the full JSON shape with `toEqual`, and text mode asserts stderr + empty stdout. Path normalization (`replace(/\\/g, '/')`) is Windows-safe.
4. **Rollback clobber safety** — `rollbackNoteIfUnchanged` compares current bytes to *this command's own write* before restoring; fork's registry-failure path and adopt's `applyPreparedAdoption` both use it, child-then-parent, aggregating rollback errors without masking the original. The "newer bytes left as-is" test proves a post-write external writer survives rollback.
5. **Interactive stale** — no replay; `ConcurrentNoteModificationError` propagates and the newer bytes are preserved (asserted in test).

## STANDARDS AND RISK

Non-blocking, in priority order:

1. **Completing prior item 2 (byte comparison is UTF-8-string comparison)**: `readFile(path, 'utf-8')` decodes before comparing. Two files with *different* invalid-UTF-8 byte sequences can decode to identical replacement-character strings and pass the guard. For UTF-8 markdown vaults this is theoretical; BOM/CRLF are preserved in the decoded string and tests confirm parity. Consider `Buffer.compare` if binary-adjacent notes ever become in-scope.
2. **Fork backfill lock nesting not visible in packet**: the excerpt shows `withNoteIdAssignmentLock` wrapping assert→write, but not the per-note lineage mutation lock docs claim is shared. Prior review and the independent race tests (fork-vs-edit, 5x source + dist) confirm correct behavior; merge gate should just confirm the lineage lock wraps or contains this path so the assert→write window is closed against edit, not merely narrowed.
3. **Recurrence commit scope**: `commitRecurrenceFastPath` runs under only the edited note's lock; successor creation and back-links to other notes aren't guarded. Acceptable given the spec excludes other writers, but worth a code comment.
4. **`resolvedVaultDir ?? process.cwd()` fallback** can yield odd relative paths; unreachable in practice since the error requires vault resolution.
5. Minor: `lineage adopt` uses `process.exitCode`/return while the other handlers `process.exit` — behaviorally equivalent, slightly inconsistent style; the post-loop `throw` in `editNoteFromJson` is unreachable (TS-satisfying) dead code.

Gate decision: **merge**.
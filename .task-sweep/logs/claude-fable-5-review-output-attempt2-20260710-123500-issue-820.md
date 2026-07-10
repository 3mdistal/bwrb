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
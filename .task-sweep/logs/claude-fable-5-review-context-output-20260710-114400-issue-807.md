NO BLOCKERS

## SPEC FIDELITY

All three follow-up requirements are implemented and consistent with the acceptance evidence:

- **Windows coverage**: additive `windows_lock_tests` job (`.github/workflows/ci.yml:151–177`) builds then runs the focused lock/delete suites; job name is new so required checks (`Test`, `PTY Tests`, `Vercel`) are untouched, per TaskSweep.
- **Deterministic real cross-process stress**: `tests/ts/fixtures/lineage-lock-worker.ts` + `tests/ts/lib/lineage-lock-cross-process.test.ts` use real `spawn`, NDJSON handshakes (not sleeps), sentinel-based overlap detection, dead-holder crash/recovery, successor protection, and artifact cleanup assertions.
- **Disappearance classification**: `DeleteTargetDisappearedError` (`src/commands/delete.ts:907–914`) is thrown only from the under-lock recheck (`classifyMissingAsDisappeared=true` at 685, 868); initial-selection ENOENT path preserved (930–935). Docs (`docs-site/.../delete.md:104–133`), SKILL.md, and both changelogs match the implemented text/JSON (`code: 2`, `data.reason/retryable/paths`) and the built-CLI test assertions exactly.
- **Scope**: no #820 edit-vs-lineage work; lock changes are fail-closed classification only. `.task-sweep/logs/` files are sanctioned per additional context.

Note: merge remains contingent on the separately-running GitHub Windows gate, as the spec itself states. That is external to this packet and not a diff defect.

## STANDARDS AND RISK

No blockers. Non-blocking suggestions:

1. **Self-heartbeat skipped on `busy`** (`src/lib/lineage-lock.ts:216–223`): if `readLockSnapshot` of the holder's *own* lock returns `busy`, `handle.utimes` is skipped. Persistent transient errors would let the mtime go stale; a holder that stops other liveness signals could degrade toward recovery pressure. Low likelihood (holder has the handle open), but consider heartbeating on `busy` since the handle identity check already protects against touching a replacement.
2. **Release on `busy` leaves an orphan** (`unlinkIfOwned`, lines ~389–396): transient error during token-safe release returns `false` silently, leaving a live-PID lock that only clears after staleness. Fail-closed and self-healing, but worth a short retry or a debug log.
3. **`readLockSnapshot` now rethrows unclassified errors** (lines ~365) where it previously returned `null`. This surfaces new failure modes on exotic filesystems (e.g., `EIO`, `EMFILE`). Acceptable, but confirm the acquisition loop's `continue` after `recoverStaleLock` doesn't skip attempt counting/delay under repeated transient recovery failures (loop body not fully visible in the diff).
4. **Plural disappearance message untested/undocumented**: `Delete targets disappeared...` (delete.ts:911) has no test and no doc example; docs show only the single-target form.
5. **CI job uses `pnpm exec vitest run`** (ci.yml:176) rather than `pnpm test`. The standard scopes `pnpm test` to local execution and the command is non-watch, so this is acceptable, but a focused `test:windows` script would keep invocation conventions in one place. Adding `pnpm typecheck` to the Windows job would also cheaply catch platform-conditional type issues.
6. **Timing allowance in the JSON CLI test** (`expectStillRunningFor`, cross-process test ~line 342): acknowledged in the comment; residual flake risk on slow Windows runners. If it flakes, consider an observable selection-complete marker instead of the bounded alive check.
7. **`chmod 0o000` test** (`lineage-lock.test.ts:153`) will pass on non-root runners but would silently succeed-to-read under root; the `skipIf(win32)` guard is right — consider also skipping when `process.getuid?.() === 0`.

Docs-vs-implementation check: delete.md JSON example, SKILL.md contract, and both changelog entries all match the code and tests. Knip entry for the worker fixture is semantically justified per AGENTS.md.
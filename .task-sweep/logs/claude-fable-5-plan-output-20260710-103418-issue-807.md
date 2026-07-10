# Implementation Plan — Issue #807

## 1. Production changes for Windows semantics (keep minimal)

**Principle: preserve fail-closed timeout behavior.** Windows sharing violations during recovery should be treated as "holder may be alive" and retried within the acquisition loop — never as license to steal.

Smallest set of changes:

- **Classify errors in `readLockSnapshot` instead of swallowing everything.** Distinguish: `ENOENT` (gone, retry acquire), `EBUSY`/`EPERM`/`EACCES` on Windows (likely open handle → treat as live holder, back off), parse errors (corrupt → existing quarantine path). Return a discriminated result (`{ kind: 'missing' | 'busy' | 'corrupt' | 'ok', ... }`) rather than `null`. This is the single most important seam.
- **Recovery rename/unlink:** wrap the quarantine `rename` and `unlink` in a small retry that treats `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` as transient; after N attempts, fall through to the normal wait loop (fail-closed). On Windows a rename of an open file fails — that's evidence the holder is alive, which is the correct outcome.
- **Identity check in token-safe release:** on Windows, `ino`/`dev` from `fs.stat` are frequently 0 or unstable across filesystems. Gate the inode/dev comparison behind `stat.ino !== 0 && stat.dev !== 0` (or a platform check), falling back to token + mtime + size. Do not weaken the token check itself.
- **`process.kill(pid, 0)`** works on Windows Node for liveness (throws `ESRCH` for dead PIDs); no change needed, but add a test asserting the semantics you rely on. Note the known caveat: PID reuse — TTL + heartbeat already mitigates; document it in a comment, don't engineer around it.
- **`handle.utimes` heartbeat:** verify on Windows CI; if it fails on open handles (unlikely), fall back to path-based `utimes` on the owned lock. Don't preemptively change.

Do **not** add flock/LockFileEx native bindings or restructure the metadata format.

## 2. Deterministic cross-process test harness

Design a small child-process fixture, not in-process promises:

- **Fixture script** (`tests/ts/fixtures/lock-holder.mjs` or `.ts` run via `tsx`/compiled): a child that acquires the lock on a given path, writes structured events (`acquired`, `heartbeat`, `entered-critical`, `exited-critical`, `released`) to stdout as NDJSON, and responds to stdin commands (`hold`, `release`, `crash` via `process.exit(1)` without cleanup, `kill` self via SIGKILL where supported / `process.abort()` on Windows).
- **Injectable timing:** thread TTL/heartbeat/poll intervals through env vars (`BWRB_LOCK_TTL_MS` etc.) read by `lineage-lock.ts` (or an options object the fixture passes). Use ~50–200ms values in tests.
- **Scenarios (all real `spawn`, deterministic via event handshakes, not sleeps):**
  1. *Live-holder protection:* child A acquires + heartbeats; child B attempts with short timeout → B times out; assert lock file still owned by A's token.
  2. *Dead-holder recovery + successor ownership:* A acquires then `crash`es; B acquires after TTL; assert B's token in lock file, no `.recovery`/`.quarantine-*` residue after B releases.
  3. *No overlap:* N=4 children loop through the critical section appending `enter:<pid>`/`exit:<pid>` to a shared journal file (append-only writes); parent asserts strict alternation — every `enter` is followed by its own `exit` before any other `enter`. Bounded iterations (e.g., 20 each) keep it deterministic-enough and fast.
  4. *Cleanup:* after all children exit, lock dir contains no lock/recovery/quarantine artifacts.
- **Mutation-kill check:** verify the harness fails on a broken implementation by temporarily (in a review note, not committed) disabling the token check — scenario 3 should catch overlap. Mention this validation in the PR description; don't commit a mutation-testing framework.
- Run these under the regular non-PTY suite; they must pass on both OSes. Guard flaky primitives (e.g., SIGKILL) with platform-appropriate crash modes.

## 3. CI shape

- Add a **separate matrix job or standalone `windows-tests` job** in `ci.yml`: `windows-latest`, Node 22, pnpm 10.11.0, running **only** build + typecheck + a focused test glob (`vitest run tests/ts/lib/lineage-lock* tests/ts/lib/note-id-lock* tests/ts/commands/delete-lineage*` plus the new cross-process file). Do not run PTY tests or the full suite on Windows.
- Do **not** touch the existing required-check names (`Test`, `PTY Tests`, `Vercel`). The Windows job is additive; whether it becomes required is a repo-policy decision outside this PR — flag it in the PR description.
- Cache pnpm store; use `vitest run` explicitly (no watch). Set generous but bounded timeouts (Windows FS is slower).

## 4. Delete-disappearance contract

- New typed error, e.g. `DeleteTargetDisappearedError` in the delete/lineage module, thrown by `assessCurrentDeleteLineage` (or the call site) **only** when the target was present at selection but missing under lock. Carry `{ paths: string[], retryable: true }`.
- **Text:** `Target was deleted by another process while waiting for the lock: <relative-path>. Re-run to confirm.` Exit with the existing validation/retryable error class, not generic IO.
- **JSON:** `{ success: false, error: "<same text>", code: "TARGET_DISAPPEARED", retryable: true, paths: ["..."] }`. Yes to `retryable` and paths; skip a separate `reason` field — the code is the reason. Confirm `TARGET_DISAPPEARED` fits the existing error-code enum conventions before inventing it; if codes are a closed set, extend it in one place.
- **Do not change** initial-selection `ENOENT` behavior (`File not found or already deleted`, `IO_ERROR`).
- Bulk path: if bulk delete flows through the same under-lock assessor, classify per-path — disappeared targets reported with the new code, others processed normally. If bulk uses a different assessor, cover only the shared path and note the gap.

## 5. Verification, docs, failure modes

**Focused checks:**
- New `tests/ts/lib/lineage-lock-crossproc.test.ts` (scenarios above).
- New delete test: acquire the lock from a helper child, delete the target file out-of-band, release; assert delete emits the new text/JSON code and leaves no lock artifacts.
- Existing lineage-lock, note-id-lock, delete-lineage suites unchanged and green.
- Real CLI: `bwrb delete <path>` and `--json` variant against the staged disappearance scenario.

**Full parity in exact order:** build → verify:pack → typecheck → lint → knip → non-PTY tests.

**Docs:** update `docs-site/src/content/docs/` delete command page with the new error text/JSON code; update `docs/skill/SKILL.md` since command behavior (error contract) changes. Changelog entry per repo convention.

**Likely failure modes:** knip flagging the child fixture as unused (add to knip entry config); Windows CI pnpm/tsx path issues; test flakes from too-tight TTLs on slow Windows runners (use handshakes, not timing assertions); fixture zombie processes (always `kill` in `afterEach`); NDJSON stdout buffering (flush per line, read incrementally).

## 6. Scope traps / #820 boundaries

- **Do not** generalize the lock into an edit/identity-write primitive, add write-intent modes, or refactor `withOwnershipFileLock`'s public API for future consumers. The only shareable artifact is the injectable-timing option and error-classified `readLockSnapshot`, both of which #807 needs anyway.
- Do not reopen or re-test the #817 old-holder/successor fix beyond the successor scenario already in the cross-process harness (which covers it as a side effect — fine, but don't duplicate `note-id-lock.test.ts` logic).
- Do not touch fork/adopt logic; only the delete under-lock recheck classification.
- Keep the Windows job additive; changing required checks or branch protection is out of scope.
- Open a **draft PR** only; do not mark ready or merge.
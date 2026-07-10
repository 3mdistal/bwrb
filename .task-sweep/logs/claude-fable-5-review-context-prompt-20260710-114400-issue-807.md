You are reviewing an embedded pull request diff for correctness bugs, missed edge cases, security issues, test gaps, documentation drift, runtime risk, and release risk.

Review on two separate axes:
- SPEC FIDELITY: missing or partial requirements, wrong behavior, and unrequested scope.
- STANDARDS AND RISK: documented repo conventions plus correctness, security, tests, runtime behavior, and maintainability.

The repo's documented standards override generic advice.

Constraints:
- Review only the embedded task/spec, standards, and diff below.
- Do not use tools.
- Do not edit files or take any repository/GitHub action.
- Treat this as a PR readiness gate.
- Cite file paths and line numbers where possible.
- Start with exactly one verdict label: BLOCKERS, NON-BLOCKING, or NO BLOCKERS.
- Separate blockers from non-blocking suggestions. Only blockers go back through the fix loop.
- Report SPEC FIDELITY and STANDARDS AND RISK separately.
- Review docs against implementation.
- Keep the response short.

BEGIN TASK / SPEC
GitHub issue #807: Harden lineage lock portability and cross-process errors.
Context: PR #806 added a path-keyed cross-process lock for new --fork and non-force delete. Existing local/Linux coverage handled active-owner protection, heartbeat, dead/corrupt recovery, token-safe release, in-process contenders, and CLI races.
Required follow-up:
- Add Windows CI or focused Windows harness, especially open-handle behavior during heartbeat, recovery rename, quarantine cleanup, and close-before-release unlink.
- Add deterministic real cross-process stress, not only in-process contenders/CLI race repetitions.
- Classify target disappearance between delete selection and authoritative under-lock recheck instead of generic ENOENT.
Acceptance:
- Shared lineage lock preserves mutual exclusion and cleans artifacts on supported Windows and POSIX.
- Target removed during delete gets stable documented text and JSON errors.
- Existing new --fork, delete-lineage, note-ID lock, adoption, and repository suites stay green.
Scope: do not implement issue #820 edit-vs-lineage concurrency. One PR, docs/changelog/agent skill as repository conventions require.
Evidence supplied by implementation and independent tester:
- Exact Node 22 local parity: build, verify:pack, typecheck, lint, knip, 3030 tests passed/3 skipped.
- Focused suites 29/29; repeated cross-process suite 5 times 20/20; delete regression 22/22.
- Independent built-CLI bulk disappearance: exit 2, stable retry text, remaining target untouched.
- Independent initial-no-match text/JSON unchanged: exit/code 1, no retryable data.
- Canonical docs checks and 42-page Astro build pass.
GitHub Windows execution is a separate gate still running and must pass before merge.
END TASK / SPEC

BEGIN REPO STANDARDS
AGENTS.md:
- Canonical user-facing behavior docs live under docs-site/src/content/docs/.
- Update docs/skill/SKILL.md for changed CLI automation behavior.
- CI source is .github/workflows/ci.yml; Node 22; pnpm 10.11.0.
- Exact local parity order: pnpm build; pnpm verify:pack; pnpm typecheck; pnpm lint; pnpm knip; pnpm test -- --exclude='**/*.pty.test.ts'.
- Always use pnpm test for local Vitest execution; CI commands must be non-watch.
- Knip should use semantically justified entries/exports, not broad ignores.
- Include the entire diff for external review because worktree paths may be inaccessible.
TaskSweep:
- Additive Windows job must not rename required checks.
- Final reviewer has no tools; judge only this packet.
- Blockers are concrete correctness/spec/repository-policy issues, not generic preferences.
END REPO STANDARDS

BEGIN DIFF
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 45b86a2..b7e2f26 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -148,6 +148,33 @@ jobs:
         env:
           BWRB_TEST_DIST: 1
 
+  windows_lock_tests:
+    name: Windows Lock Tests
+    runs-on: windows-latest
+    timeout-minutes: 15
+    steps:
+      - uses: actions/checkout@v4
+
+      - name: Install pnpm
+        uses: pnpm/action-setup@v4
+        with:
+          version: 10.11.0
+
+      - name: Setup Node.js
+        uses: actions/setup-node@v4
+        with:
+          node-version: 22
+          cache: pnpm
+
+      - name: Install dependencies
+        run: pnpm install --frozen-lockfile
+
+      - name: Build
+        run: pnpm build
+
+      - name: Run focused lineage lock tests
+        run: pnpm exec vitest run tests/ts/lib/lineage-lock.test.ts tests/ts/lib/lineage-lock-cross-process.test.ts tests/ts/lib/note-id-lock.test.ts tests/ts/commands/delete-lineage.test.ts
+
   test-pty:
     name: PTY Tests
     runs-on: ubuntu-latest

diff --git a/.task-sweep/logs/claude-fable-5-plan-20260710-103418-issue-807.log b/.task-sweep/logs/claude-fable-5-plan-20260710-103418-issue-807.log
new file mode 100644
index 0000000..1121db4
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-20260710-103418-issue-807.log
@@ -0,0 +1,6 @@
+model_requested: anthropic/claude-fable-5
+model_returned: anthropic/claude-5-fable-20260609
+finish_reason: stop
+output: .task-sweep/logs/claude-fable-5-plan-output-20260710-103418-issue-807.md
+chars: 7822 words: 1124
+preview: # Implementation Plan — Issue #807\n\n## 1. Production changes for Windows semantics (keep minimal)\n\n**Principle: preserve fail-closed timeout behavior.** Windows sharing violations during recovery should be treated as "holder may be alive" and retried within the acquisition loop — never as license to steal.\n\nSmallest set of changes:\n\n- **Classify errors in `readLockSnapshot` instead of swallowing everything.** Distinguish: `ENOENT` (gone, retry acquire), `EBUSY`/`EPERM`/`EACCES` on Windows (likely open handle → treat as live holder, back off), parse errors (corrupt → existing quarantine path). Return a discriminated result (`{ kind: 'missing' | 'busy' | 'corrupt' | 'ok', ... }`) rather than `null`. This is the single most important seam.\n- **Recovery rename/unlink:** wrap the quarantine `re

diff --git a/.task-sweep/logs/claude-fable-5-plan-output-20260710-103418-issue-807.md b/.task-sweep/logs/claude-fable-5-plan-output-20260710-103418-issue-807.md
new file mode 100644
index 0000000..1a1e073
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-output-20260710-103418-issue-807.md
@@ -0,0 +1,65 @@
+# Implementation Plan — Issue #807
+
+## 1. Production changes for Windows semantics (keep minimal)
+
+**Principle: preserve fail-closed timeout behavior.** Windows sharing violations during recovery should be treated as "holder may be alive" and retried within the acquisition loop — never as license to steal.
+
+Smallest set of changes:
+
+- **Classify errors in `readLockSnapshot` instead of swallowing everything.** Distinguish: `ENOENT` (gone, retry acquire), `EBUSY`/`EPERM`/`EACCES` on Windows (likely open handle → treat as live holder, back off), parse errors (corrupt → existing quarantine path). Return a discriminated result (`{ kind: 'missing' | 'busy' | 'corrupt' | 'ok', ... }`) rather than `null`. This is the single most important seam.
+- **Recovery rename/unlink:** wrap the quarantine `rename` and `unlink` in a small retry that treats `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` as transient; after N attempts, fall through to the normal wait loop (fail-closed). On Windows a rename of an open file fails — that's evidence the holder is alive, which is the correct outcome.
+- **Identity check in token-safe release:** on Windows, `ino`/`dev` from `fs.stat` are frequently 0 or unstable across filesystems. Gate the inode/dev comparison behind `stat.ino !== 0 && stat.dev !== 0` (or a platform check), falling back to token + mtime + size. Do not weaken the token check itself.
+- **`process.kill(pid, 0)`** works on Windows Node for liveness (throws `ESRCH` for dead PIDs); no change needed, but add a test asserting the semantics you rely on. Note the known caveat: PID reuse — TTL + heartbeat already mitigates; document it in a comment, don't engineer around it.
+- **`handle.utimes` heartbeat:** verify on Windows CI; if it fails on open handles (unlikely), fall back to path-based `utimes` on the owned lock. Don't preemptively change.
+
+Do **not** add flock/LockFileEx native bindings or restructure the metadata format.
+
+## 2. Deterministic cross-process test harness
+
+Design a small child-process fixture, not in-process promises:
+
+- **Fixture script** (`tests/ts/fixtures/lock-holder.mjs` or `.ts` run via `tsx`/compiled): a child that acquires the lock on a given path, writes structured events (`acquired`, `heartbeat`, `entered-critical`, `exited-critical`, `released`) to stdout as NDJSON, and responds to stdin commands (`hold`, `release`, `crash` via `process.exit(1)` without cleanup, `kill` self via SIGKILL where supported / `process.abort()` on Windows).
+- **Injectable timing:** thread TTL/heartbeat/poll intervals through env vars (`BWRB_LOCK_TTL_MS` etc.) read by `lineage-lock.ts` (or an options object the fixture passes). Use ~50–200ms values in tests.
+- **Scenarios (all real `spawn`, deterministic via event handshakes, not sleeps):**
+  1. *Live-holder protection:* child A acquires + heartbeats; child B attempts with short timeout → B times out; assert lock file still owned by A's token.
+  2. *Dead-holder recovery + successor ownership:* A acquires then `crash`es; B acquires after TTL; assert B's token in lock file, no `.recovery`/`.quarantine-*` residue after B releases.
+  3. *No overlap:* N=4 children loop through the critical section appending `enter:<pid>`/`exit:<pid>` to a shared journal file (append-only writes); parent asserts strict alternation — every `enter` is followed by its own `exit` before any other `enter`. Bounded iterations (e.g., 20 each) keep it deterministic-enough and fast.
+  4. *Cleanup:* after all children exit, lock dir contains no lock/recovery/quarantine artifacts.
+- **Mutation-kill check:** verify the harness fails on a broken implementation by temporarily (in a review note, not committed) disabling the token check — scenario 3 should catch overlap. Mention this validation in the PR description; don't commit a mutation-testing framework.
+- Run these under the regular non-PTY suite; they must pass on both OSes. Guard flaky primitives (e.g., SIGKILL) with platform-appropriate crash modes.
+
+## 3. CI shape
+
+- Add a **separate matrix job or standalone `windows-tests` job** in `ci.yml`: `windows-latest`, Node 22, pnpm 10.11.0, running **only** build + typecheck + a focused test glob (`vitest run tests/ts/lib/lineage-lock* tests/ts/lib/note-id-lock* tests/ts/commands/delete-lineage*` plus the new cross-process file). Do not run PTY tests or the full suite on Windows.
+- Do **not** touch the existing required-check names (`Test`, `PTY Tests`, `Vercel`). The Windows job is additive; whether it becomes required is a repo-policy decision outside this PR — flag it in the PR description.
+- Cache pnpm store; use `vitest run` explicitly (no watch). Set generous but bounded timeouts (Windows FS is slower).
+
+## 4. Delete-disappearance contract
+
+- New typed error, e.g. `DeleteTargetDisappearedError` in the delete/lineage module, thrown by `assessCurrentDeleteLineage` (or the call site) **only** when the target was present at selection but missing under lock. Carry `{ paths: string[], retryable: true }`.
+- **Text:** `Target was deleted by another process while waiting for the lock: <relative-path>. Re-run to confirm.` Exit with the existing validation/retryable error class, not generic IO.
+- **JSON:** `{ success: false, error: "<same text>", code: "TARGET_DISAPPEARED", retryable: true, paths: ["..."] }`. Yes to `retryable` and paths; skip a separate `reason` field — the code is the reason. Confirm `TARGET_DISAPPEARED` fits the existing error-code enum conventions before inventing it; if codes are a closed set, extend it in one place.
+- **Do not change** initial-selection `ENOENT` behavior (`File not found or already deleted`, `IO_ERROR`).
+- Bulk path: if bulk delete flows through the same under-lock assessor, classify per-path — disappeared targets reported with the new code, others processed normally. If bulk uses a different assessor, cover only the shared path and note the gap.
+
+## 5. Verification, docs, failure modes
+
+**Focused checks:**
+- New `tests/ts/lib/lineage-lock-crossproc.test.ts` (scenarios above).
+- New delete test: acquire the lock from a helper child, delete the target file out-of-band, release; assert delete emits the new text/JSON code and leaves no lock artifacts.
+- Existing lineage-lock, note-id-lock, delete-lineage suites unchanged and green.
+- Real CLI: `bwrb delete <path>` and `--json` variant against the staged disappearance scenario.
+
+**Full parity in exact order:** build → verify:pack → typecheck → lint → knip → non-PTY tests.
+
+**Docs:** update `docs-site/src/content/docs/` delete command page with the new error text/JSON code; update `docs/skill/SKILL.md` since command behavior (error contract) changes. Changelog entry per repo convention.
+
+**Likely failure modes:** knip flagging the child fixture as unused (add to knip entry config); Windows CI pnpm/tsx path issues; test flakes from too-tight TTLs on slow Windows runners (use handshakes, not timing assertions); fixture zombie processes (always `kill` in `afterEach`); NDJSON stdout buffering (flush per line, read incrementally).
+
+## 6. Scope traps / #820 boundaries
+
+- **Do not** generalize the lock into an edit/identity-write primitive, add write-intent modes, or refactor `withOwnershipFileLock`'s public API for future consumers. The only shareable artifact is the injectable-timing option and error-classified `readLockSnapshot`, both of which #807 needs anyway.
+- Do not reopen or re-test the #817 old-holder/successor fix beyond the successor scenario already in the cross-process harness (which covers it as a side effect — fine, but don't duplicate `note-id-lock.test.ts` logic).
+- Do not touch fork/adopt logic; only the delete under-lock recheck classification.
+- Keep the Windows job additive; changing required checks or branch protection is out of scope.
+- Open a **draft PR** only; do not mark ready or merge.
\ No newline at end of file

diff --git a/.task-sweep/logs/claude-fable-5-plan-prompt-20260710-103418-issue-807.md b/.task-sweep/logs/claude-fable-5-plan-prompt-20260710-103418-issue-807.md
new file mode 100644
index 0000000..d4d4bcc
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-prompt-20260710-103418-issue-807.md
@@ -0,0 +1,88 @@
+# TaskSweep early planning packet — BWRB issue #807
+
+You are advising on a repository task before implementation. You have no tools. Do not claim to inspect anything outside this packet. Give concise advice to another implementation agent; do not mutate anything or broaden beyond the issue.
+
+## Normalized task
+
+- ID/source: GitHub issue #807, `https://github.com/3mdistal/bwrb/issues/807`
+- Title: Harden lineage lock portability and cross-process errors
+- Repo/base: `3mdistal/bwrb`, `origin/main` at `55dfc19887d9442fe0d3c94b28ac01b18c7012a0`
+- Branch/lane: `codex/807-lineage-lock-hardening` in an isolated worktree
+- Problem: PR #806 added path-keyed cross-process locks for `new --fork` and non-force delete. Current tests prove ownership, heartbeats, stale/dead recovery, token-safe release, contenders, and CLI races on the local platform, but the issue still asks for explicit Windows/open-handle coverage, a deterministic cross-process stress harness, and a stable error when a delete target disappears while the command waits for its authoritative lock.
+- Desired outcome:
+  1. The shared lineage/ownership lock preserves mutual exclusion and cleans its lock/recovery/quarantine artifacts on supported POSIX and Windows environments, with a focused Windows CI lane or equivalent harness.
+  2. A deterministic multi-process test—not merely in-process promises or probabilistic CLI races—proves live-holder protection, dead-holder recovery, successor ownership, no overlapping critical sections, and cleanup.
+  3. Non-force delete classifies a target that disappears between initial selection and the under-lock recheck with stable documented text and JSON behavior, rather than a generic raw or misleading `ENOENT`.
+  4. Existing fork, adopt, delete-lineage, note-ID-lock, and full repository suites remain green.
+- Manual successful story: As a vault owner running competing BWRB processes, a crashed lineage mutator cannot leave the vault permanently locked and live/successor holders cannot overlap or have their locks stolen. If another process deletes my target while my non-force delete waits, BWRB returns a clear retryable result and leaves no lock debris.
+- Merge is authorized only after the full TaskSweep and repository-policy gates. The implementer must open a draft PR and must not ready or merge it.
+
+## Repo facts and standards
+
+- TypeScript ESM Commander CLI; Node 22; pnpm 10.11.0.
+- Required checks: `Test`, `PTY Tests`, `Vercel`; strict up-to-date branch protection; zero required approvals.
+- Full local parity in exact order: build, verify:pack, typecheck, lint, knip, non-PTY test suite.
+- Canonical user docs live in `docs-site/src/content/docs/`; bundled agent guidance is `docs/skill/SKILL.md` when command behavior changes.
+- Current `.github/workflows/ci.yml` runs Linux/Ubuntu only. A Windows-focused job must avoid silently testing a different contract and must remain practical for PR CI.
+- Use `pnpm test`/Vitest run semantics; do not invoke watch mode.
+
+## Current implementation
+
+### Ownership-safe shared lock
+
+`src/lib/lineage-lock.ts` now exposes `withLineageMutationLocks` and `withOwnershipFileLock`. It:
+
+- derives deterministic SHA-256 lock paths from normalized vault-relative source paths;
+- writes JSON metadata `{ version, pid, token, createdAt, heartbeatAt, pathKey }` under exclusive `open(..., 'wx')`;
+- heartbeats the owned open handle with `handle.utimes`;
+- checks process liveness with `process.kill(pid, 0)` after TTL expiry;
+- uses a fixed `.recovery` ownership marker, rechecks stale state, renames stale locks to unique `.quarantine-*` paths, unlinks quarantine, and cleans stale quarantine files;
+- releases only when the token plus snapshot raw/dev/inode/mtime/size still match;
+- sorts multi-lock acquisition to avoid deadlock.
+
+PR #817 generalized this primitive for the fixed note-ID assignment and registry lock paths after an independent tester reproduced an old-holder/successor overlap bug. New `tests/ts/lib/note-id-lock.test.ts` covers heartbeat and successor ownership in process, but not a true child-process stress harness. This partially satisfies #807; do not duplicate it or reopen the fixed race.
+
+Potential portability seams to examine:
+
+- `readLockSnapshot` catches every read/stat error and returns null, erasing distinctions such as Windows sharing/permission errors.
+- stale recovery renames then unlinks a lock pathname; Windows open-handle rules differ from POSIX.
+- `cleanupQuarantines` unlinks matching paths concurrently and ignores errors.
+- `process.kill(pid, 0)`, inode/dev identity, and open-handle `utimes` need actual Windows evidence.
+- tests currently synthesize dead PIDs and contenders in one Vitest process.
+
+### Delete disappearance behavior
+
+Single non-force delete resolves a file, performs prompts/backlink work, then:
+
+```ts
+await withLineageMutationLocks(vaultDir, [fullPath], async () => {
+  const assessment = await assessCurrentDeleteLineage(schema, vaultDir, [file]);
+  if (assessment.length > 0) throw new LineageDeleteRefusalError(assessment);
+  await unlink(fullPath);
+  await unregisterIssuedNotePath(vaultDir, relativePath);
+});
+```
+
+`assessCurrentDeleteLineage` rebuilds a fresh snapshot. If the selected path is now missing it creates an `Error("File not found or no longer managed: ...")` and assigns `error.code = 'ENOENT'`. The outer delete command collapses all `ENOENT` errors to:
+
+- text: `File not found or already deleted`, exit validation error;
+- JSON: `{ success: false, error: "File not found or already deleted", code: IO_ERROR }`.
+
+The issue asks for stable classification of the specific between-selection-and-lock disappearance. Consider a narrow typed error with a retryable machine-readable payload/code and documented wording, without changing unrelated initial not-found behavior. Cover bulk and single paths if they share the same under-lock assessor.
+
+### Existing tests
+
+- `tests/ts/lib/lineage-lock.test.ts`: deterministic lock path, cleanup, ordered multi-lock acquisition, TTL recovery, live-holder protection, heartbeat, dead/corrupt recovery, token-safe replacement, 2/10 in-process contenders, recovery-marker ownership, timeout.
+- `tests/ts/lib/note-id-lock.test.ts`: both fixed note-ID lock paths, heartbeat/live holder, successor preservation and third-holder serialization.
+- `tests/ts/commands/delete-lineage.test.ts`: non-force guard behavior and a real CLI fork-versus-delete race, but no deterministic target-disappears-while-waiting scenario.
+
+## Planning questions
+
+Give a concise implementation plan covering:
+
+1. The smallest production-code changes needed for supported Windows semantics. Should recovery retry specific Windows sharing errors, avoid relying on inode identity when unavailable, or preserve current fail-closed timeout behavior?
+2. A deterministic cross-process Vitest/worker design that runs on POSIX and Windows, uses short injectable timing, proves no overlap and artifact cleanup, and would fail on a deliberately broken ownership implementation.
+3. The safest CI shape for Windows coverage without destabilizing unrelated PTY/full-suite jobs.
+4. A stable text/JSON contract and typed error for a delete target disappearing during the authoritative under-lock recheck, including whether the JSON payload should include `retryable`, `reason`, and target paths.
+5. Exact focused and real CLI checks, docs/changelog changes, and likely failure modes.
+6. Scope traps or conflicts with the later #820 edit/identity-write concurrency task. Keep #820 out of this PR unless a tiny reusable primitive is strictly necessary.

diff --git a/CHANGELOG.md b/CHANGELOG.md
index 333707c..d9529af 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -10,6 +10,7 @@ All notable changes to Bowerbird are documented in this file.
 
 ### Fixed
 
+- **Portable lineage mutation locking** — lineage and note-ID locks now fail closed on Windows sharing/permission errors, have deterministic real-process stress coverage plus a focused Windows CI lane, and return stable retryable text/JSON context when a non-force delete target disappears before its authoritative under-lock recheck (#807).
 - **Body-only content targeting** — `--body` now excludes YAML frontmatter in both note filtering and detailed match reports while preserving original file line numbers and body-only context (#812).
 
 ## [0.2.3] - 2026-07-09

diff --git a/docs-site/src/content/docs/changelog.md b/docs-site/src/content/docs/changelog.md
index 59fd1ea..38859b3 100644
--- a/docs-site/src/content/docs/changelog.md
+++ b/docs-site/src/content/docs/changelog.md
@@ -12,6 +12,7 @@ For the complete changelog with all details, see [CHANGELOG.md](https://github.c
 ### Unreleased
 
 - **Existing-note lineage adoption** — `bwrb lineage adopt <child> --from <parent>` adds a dry-run-first, lock-coordinated path for recording known derivation between existing same-type notes without rewriting their bodies or ordinary metadata
+- **Portable lineage mutation locking** — fork, adopt, delete, and note-ID coordination now have real cross-process stress coverage, a focused Windows CI lane, and stable retryable output when a non-force delete target disappears while waiting for its lock
 
 ### 0.2.3
 

diff --git a/docs-site/src/content/docs/reference/commands/delete.md b/docs-site/src/content/docs/reference/commands/delete.md
index 00d2da6..c4fc95a 100644
--- a/docs-site/src/content/docs/reference/commands/delete.md
+++ b/docs-site/src/content/docs/reference/commands/delete.md
@@ -101,6 +101,36 @@ not deleted or reparented, and their `forked-from` value stays intact. A later
 `bwrb audit` reports that retained provenance as `dangling-forked-from`, so the
 source can still be restored deliberately.
 
+### Concurrent target disappearance
+
+Without `--force`, bwrb selects the requested notes and then rechecks them while
+holding the same lineage locks used by fork and adoption. If another process
+deletes a selected target before that authoritative recheck, the command stops
+without deleting any of the remaining selected notes and returns exit code `2`:
+
+```text
+Error: Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Launch Brief.md
+```
+
+JSON output keeps the numeric exit-code contract and adds stable retry context:
+
+```json
+{
+  "success": false,
+  "error": "Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Launch Brief.md",
+  "data": {
+    "reason": "target-disappeared",
+    "retryable": true,
+    "paths": ["Ideas/Launch Brief.md"]
+  },
+  "code": 2
+}
+```
+
+Re-resolve the target set before retrying. This is distinct from an initial
+not-found result: the note existed during selection but vanished while the
+command was coordinating its write.
+
 ## Examples
 
 ### Single-file Mode

diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index 9479a35..eead77a 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -229,6 +229,12 @@ their `forked-from` value, which surfaces as `dangling-forked-from` in
 `bwrb audit`. Use `bwrb list --lineage <target> --output json` before forcing a
 parent deletion when an agent needs to enumerate the affected family.
 
+For non-force deletion, another process can remove a selected target while the
+command waits for its lineage lock. JSON reports numeric `code: 2` with
+`data.reason: "target-disappeared"`, `data.retryable: true`, and the selected
+`data.paths`. Re-resolve those paths before retrying; do not treat this as a
+successful or ordinary initial not-found result.
+
 ## Core Commands for Agents
 
 ### Querying Notes

diff --git a/knip.jsonc b/knip.jsonc
index b53571e..0b9f731 100644
--- a/knip.jsonc
+++ b/knip.jsonc
@@ -3,7 +3,11 @@
 
   // Vitest plugin doesn't auto-detect globalTeardown from config
   "vitest": {
-    "entry": ["tests/ts/teardown.ts"]
+    "entry": [
+      "tests/ts/teardown.ts",
+      // Spawned as a real child process by the cross-process lock suite.
+      "tests/ts/fixtures/lineage-lock-worker.ts"
+    ]
   },
 
   // Ignore intentional public API exports and separate projects

diff --git a/src/commands/delete.ts b/src/commands/delete.ts
index e37d6b2..6907707 100644
--- a/src/commands/delete.ts
+++ b/src/commands/delete.ts
@@ -270,6 +270,11 @@ Note: Deletion is permanent. The file is removed from the filesystem.
         return;
       }
 
+      if (err instanceof DeleteTargetDisappearedError) {
+        reportDeleteTargetDisappeared(err, jsonMode);
+        return;
+      }
+
       const message = err instanceof Error ? err.message : String(err);
 
       // Handle specific error types
@@ -677,7 +682,7 @@ async function handleBulkDelete(
   } else {
     try {
       await withLineageMutationLocks(vaultDir, files.map(file => file.path), async () => {
-        const assessment = await assessCurrentDeleteLineage(schema, vaultDir, files);
+        const assessment = await assessCurrentDeleteLineage(schema, vaultDir, files, true);
         if (assessment.length > 0) throw new LineageDeleteRefusalError(assessment);
         await deleteFiles();
       });
@@ -860,7 +865,7 @@ async function deleteResolvedFile({
   } else {
     try {
       await withLineageMutationLocks(vaultDir, [fullPath], async () => {
-        const assessment = await assessCurrentDeleteLineage(schema, vaultDir, [file]);
+        const assessment = await assessCurrentDeleteLineage(schema, vaultDir, [file], true);
         if (assessment.length > 0) throw new LineageDeleteRefusalError(assessment);
         await unlink(fullPath);
         await unregisterIssuedNotePath(vaultDir, relativePath);
@@ -899,18 +904,32 @@ class LineageDeleteRefusalError extends Error {
   }
 }
 
+class DeleteTargetDisappearedError extends Error {
+  constructor(readonly paths: string[]) {
+    super(paths.length === 1
+      ? `Delete target disappeared while waiting for the lineage lock; retry the command: ${paths[0]}`
+      : `Delete targets disappeared while waiting for lineage locks; retry the command: ${paths.join(', ')}`);
+    this.name = 'DeleteTargetDisappearedError';
+  }
+}
+
 async function assessCurrentDeleteLineage(
   schema: Awaited<ReturnType<typeof loadSchema>>,
   vaultDir: string,
-  files: ManagedFile[]
+  files: ManagedFile[],
+  classifyMissingAsDisappeared = false
 ): Promise<DeleteLineageBlock[]> {
   const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
   const assessment = assessDeleteLineage(snapshot, files.map(file => file.path));
   if (assessment.missing.length > 0) {
+    const missingPaths = assessment.missing.map(
+      path => files.find(file => file.path === path)?.relativePath ?? path
+    );
+    if (classifyMissingAsDisappeared) {
+      throw new DeleteTargetDisappearedError(missingPaths);
+    }
     const error = new Error(
-      `File not found or no longer managed: ${assessment.missing
-        .map(path => files.find(file => file.path === path)?.relativePath ?? path)
-        .join(', ')}`
+      `File not found or no longer managed: ${missingPaths.join(', ')}`
     ) as NodeJS.ErrnoException;
     error.code = 'ENOENT';
     throw error;
@@ -918,6 +937,25 @@ async function assessCurrentDeleteLineage(
   return assessment.blocked;
 }
 
+function reportDeleteTargetDisappeared(
+  error: DeleteTargetDisappearedError,
+  jsonMode: boolean
+): void {
+  if (jsonMode) {
+    printJson(jsonError(error.message, {
+      code: ExitCodes.IO_ERROR,
+      data: {
+        reason: 'target-disappeared',
+        retryable: true,
+        paths: error.paths,
+      },
+    }));
+  } else {
+    printError(error.message);
+  }
+  process.exitCode = ExitCodes.IO_ERROR;
+}
+
 function reportLineageRefusal(
   blocked: DeleteLineageBlock[],
   jsonMode: boolean,

diff --git a/src/lib/lineage-lock.ts b/src/lib/lineage-lock.ts
index 47bbc2e..46a7633 100644
--- a/src/lib/lineage-lock.ts
+++ b/src/lib/lineage-lock.ts
@@ -33,6 +33,11 @@ interface LockSnapshot {
   size: number;
 }
 
+type LockSnapshotRead =
+  | { kind: 'present'; snapshot: LockSnapshot }
+  | { kind: 'missing' }
+  | { kind: 'busy' };
+
 const DEFAULT_OPTIONS: OwnershipFileLockOptions = {
   retryMs: LOCK_RETRY_MS,
   attempts: LOCK_ATTEMPTS,
@@ -166,8 +171,11 @@ async function acquireLock(
       }
     } catch (error) {
       if (!isFileExistsError(error)) throw error;
-      const snapshot = await readLockSnapshot(lockPath);
-      if (snapshot && await isRecoverable(snapshot, options.staleMs)) {
+      const snapshotRead = await readLockSnapshot(lockPath);
+      if (
+        snapshotRead.kind === 'present' &&
+        await isRecoverable(snapshotRead.snapshot, options.staleMs)
+      ) {
         await recoverStaleLock(lockPath, recoveryPath, options);
         continue;
       }
@@ -208,8 +216,11 @@ async function heartbeatOwnedLock(
   handle: Awaited<ReturnType<typeof open>>,
   token: string
 ): Promise<void> {
-  const snapshot = await readLockSnapshot(lockPath);
-  if (snapshot?.metadata?.token !== token) return;
+  const snapshotRead = await readLockSnapshot(lockPath);
+  if (
+    snapshotRead.kind !== 'present' ||
+    snapshotRead.snapshot.metadata?.token !== token
+  ) return;
 
   // Touch the inode opened by this holder, not whatever might have appeared at
   // the path after the ownership check. The immutable JSON records when the
@@ -227,8 +238,11 @@ async function recoverStaleLock(
   if (!recovery) return;
 
   try {
-    const snapshot = await readLockSnapshot(lockPath);
-    if (!snapshot || !await isRecoverable(snapshot, options.staleMs)) return;
+    const snapshotRead = await readLockSnapshot(lockPath);
+    if (
+      snapshotRead.kind !== 'present' ||
+      !await isRecoverable(snapshotRead.snapshot, options.staleMs)
+    ) return;
 
     // The fixed recovery marker prevents acquisitions and competing reapers
     // while the stale inode is atomically moved out of the lock pathname.
@@ -237,7 +251,12 @@ async function recoverStaleLock(
       await rename(lockPath, quarantinePath);
       await unlink(quarantinePath).catch(() => undefined);
     } catch (error) {
-      if (!isFileMissingError(error)) throw error;
+      if (isFileMissingError(error)) return;
+      // Windows can reject a rename while another process still has the lock
+      // open. That is evidence against stealing, not permission to do so. Let
+      // the outer acquisition loop retry until its ordinary timeout instead.
+      if (isTransientLockFilesystemError(error)) return;
+      throw error;
     }
     await cleanupQuarantines(lockPath);
   } finally {
@@ -272,9 +291,12 @@ async function acquireRecoveryMarker(
     };
   } catch (error) {
     if (!isFileExistsError(error)) throw error;
-    const snapshot = await readLockSnapshot(recoveryPath);
-    if (snapshot && await isRecoverable(snapshot, options.staleMs)) {
-      await unlinkIfUnchanged(recoveryPath, snapshot);
+    const snapshotRead = await readLockSnapshot(recoveryPath);
+    if (
+      snapshotRead.kind === 'present' &&
+      await isRecoverable(snapshotRead.snapshot, options.staleMs)
+    ) {
+      await unlinkIfUnchanged(recoveryPath, snapshotRead.snapshot);
     }
     return null;
   }
@@ -284,10 +306,11 @@ async function recoveryIsInProgress(
   recoveryPath: string,
   options: OwnershipFileLockOptions
 ): Promise<boolean> {
-  const snapshot = await readLockSnapshot(recoveryPath);
-  if (!snapshot) return false;
-  if (await isRecoverable(snapshot, options.staleMs)) {
-    await unlinkIfUnchanged(recoveryPath, snapshot);
+  const snapshotRead = await readLockSnapshot(recoveryPath);
+  if (snapshotRead.kind === 'missing') return false;
+  if (snapshotRead.kind === 'busy') return true;
+  if (await isRecoverable(snapshotRead.snapshot, options.staleMs)) {
+    await unlinkIfUnchanged(recoveryPath, snapshotRead.snapshot);
     return pathExists(recoveryPath);
   }
   return true;
@@ -318,23 +341,30 @@ function isProcessAlive(pid: number): boolean {
   }
 }
 
-async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
+async function readLockSnapshot(lockPath: string): Promise<LockSnapshotRead> {
   try {
     const [raw, info] = await Promise.all([
       readFile(lockPath, 'utf-8'),
       stat(lockPath),
     ]);
     return {
-      raw,
-      metadata: parseLockMetadata(raw),
-      device: info.dev,
-      inode: info.ino,
-      modifiedAt: info.mtimeMs,
-      size: info.size,
+      kind: 'present',
+      snapshot: {
+        raw,
+        metadata: parseLockMetadata(raw),
+        device: info.dev,
+        inode: info.ino,
+        modifiedAt: info.mtimeMs,
+        size: info.size,
+      },
     };
   } catch (error) {
-    if (isFileMissingError(error)) return null;
-    return null;
+    if (isFileMissingError(error)) return { kind: 'missing' };
+    // Sharing/permission failures are common while Windows handles are open.
+    // Preserve that distinction so every caller fails closed rather than
+    // mistaking an unreadable lock or recovery marker for an absent one.
+    if (isTransientLockFilesystemError(error)) return { kind: 'busy' };
+    throw error;
   }
 }
 
@@ -357,14 +387,20 @@ function parseLockMetadata(raw: string): LockMetadata | null {
 }
 
 async function unlinkIfOwned(lockPath: string, token: string): Promise<boolean> {
-  const snapshot = await readLockSnapshot(lockPath);
-  if (snapshot?.metadata?.token !== token) return false;
-  return unlinkIfUnchanged(lockPath, snapshot);
+  const snapshotRead = await readLockSnapshot(lockPath);
+  if (
+    snapshotRead.kind !== 'present' ||
+    snapshotRead.snapshot.metadata?.token !== token
+  ) return false;
+  return unlinkIfUnchanged(lockPath, snapshotRead.snapshot);
 }
 
 async function unlinkIfUnchanged(lockPath: string, expected: LockSnapshot): Promise<boolean> {
-  const current = await readLockSnapshot(lockPath);
-  if (!current || !snapshotsMatch(current, expected)) return false;
+  const currentRead = await readLockSnapshot(lockPath);
+  if (
+    currentRead.kind !== 'present' ||
+    !snapshotsMatch(currentRead.snapshot, expected)
+  ) return false;
   try {
     await unlink(lockPath);
     return true;
@@ -394,8 +430,11 @@ async function pathExists(path: string): Promise<boolean> {
   try {
     await stat(path);
     return true;
-  } catch {
-    return false;
+  } catch (error) {
+    if (isFileMissingError(error)) return false;
+    // An unreadable recovery marker must serialize acquisitions just like a
+    // readable one. The lock would rather wait than become two locks in a coat.
+    return true;
   }
 }
 
@@ -409,6 +448,12 @@ function isFileMissingError(error: unknown): boolean {
     (error as NodeJS.ErrnoException).code === 'ENOENT';
 }
 
+function isTransientLockFilesystemError(error: unknown): boolean {
+  if (!(error instanceof Error) || !('code' in error)) return false;
+  const code = (error as NodeJS.ErrnoException).code;
+  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
+}
+
 function delay(ms: number): Promise<void> {
   return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
 }

diff --git a/tests/ts/fixtures/lineage-lock-worker.ts b/tests/ts/fixtures/lineage-lock-worker.ts
new file mode 100644
index 0000000..1ce5aba
--- /dev/null
+++ b/tests/ts/fixtures/lineage-lock-worker.ts
@@ -0,0 +1,99 @@
+import { appendFile, mkdir, open, unlink } from 'fs/promises';
+import { dirname } from 'path';
+import { createInterface } from 'readline';
+import {
+  withOwnershipFileLock,
+  type OwnershipFileLockOptions,
+} from '../../../src/lib/lineage-lock.js';
+
+type WorkerMode = 'hold' | 'stress';
+
+interface WorkerConfig {
+  mode: WorkerMode;
+  lockPath: string;
+  options: OwnershipFileLockOptions;
+  sentinelPath?: string;
+  journalPath?: string;
+  iterations?: number;
+}
+
+interface WorkerCommand {
+  command: 'start' | 'release' | 'crash';
+}
+
+const config = JSON.parse(process.argv[2] ?? '') as WorkerConfig;
+const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
+
+function send(event: string, data: Record<string, unknown> = {}): void {
+  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...data })}\n`);
+}
+
+async function nextCommand(expected: WorkerCommand['command'][]): Promise<WorkerCommand> {
+  const result = await commands.next();
+  if (result.done) throw new Error(`stdin closed while waiting for ${expected.join(' or ')}`);
+  const command = JSON.parse(result.value) as WorkerCommand;
+  if (!expected.includes(command.command)) {
+    throw new Error(`Expected ${expected.join(' or ')}, received ${command.command}`);
+  }
+  return command;
+}
+
+async function hold(): Promise<void> {
+  await withOwnershipFileLock(config.lockPath, async () => {
+    send('acquired');
+    const command = await nextCommand(['release', 'crash']);
+    if (command.command === 'crash') {
+      // Deliberately bypass finally/release to leave a real dead-owner lock.
+      process.exit(70);
+    }
+  }, config.options, 'worker lock timeout');
+  send('released');
+}
+
+async function stress(): Promise<void> {
+  if (!config.sentinelPath || !config.journalPath || !config.iterations) {
+    throw new Error('Stress mode requires sentinelPath, journalPath, and iterations');
+  }
+
+  await mkdir(dirname(config.journalPath), { recursive: true });
+  for (let iteration = 0; iteration < config.iterations; iteration++) {
+    await withOwnershipFileLock(config.lockPath, async () => {
+      let sentinel: Awaited<ReturnType<typeof open>> | undefined;
+      try {
+        sentinel = await open(config.sentinelPath!, 'wx');
+      } catch (error) {
+        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
+          send('overlap', { iteration });
+        }
+        throw error;
+      }
+
+      try {
+        await appendFile(config.journalPath!, `${JSON.stringify({ event: 'enter', pid: process.pid, iteration })}\n`);
+        // Widen the critical section across two event-loop turns. The sentinel
+        // makes overlap detection deterministic even if journal appends race.
+        await new Promise<void>(resolve => setImmediate(resolve));
+        await new Promise<void>(resolve => setImmediate(resolve));
+        await appendFile(config.journalPath!, `${JSON.stringify({ event: 'exit', pid: process.pid, iteration })}\n`);
+      } finally {
+        await sentinel.close();
+        await unlink(config.sentinelPath!).catch(() => undefined);
+      }
+    }, config.options, 'worker lock timeout');
+  }
+  send('done');
+}
+
+async function main(): Promise<void> {
+  send('ready');
+  await nextCommand(['start']);
+  if (config.mode === 'hold') await hold();
+  else await stress();
+  process.stdin.destroy();
+}
+
+main().catch(error => {
+  send('fatal', { message: error instanceof Error ? error.message : String(error) });
+  process.exitCode = 1;
+  process.stdin.destroy();
+});

diff --git a/tests/ts/lib/lineage-lock-cross-process.test.ts b/tests/ts/lib/lineage-lock-cross-process.test.ts
new file mode 100644
index 0000000..b732cff
--- /dev/null
+++ b/tests/ts/lib/lineage-lock-cross-process.test.ts
@@ -0,0 +1,392 @@
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
+import { existsSync } from 'fs';
+import { mkdtemp, readFile, readdir, rm, unlink } from 'fs/promises';
+import { tmpdir } from 'os';
+import { basename, join } from 'path';
+import {
+  getLineageMutationLockPath,
+  type OwnershipFileLockOptions,
+} from '../../../src/lib/lineage-lock.js';
+import { cleanupTestVault, createTestVault } from '../fixtures/setup.js';
+
+interface WorkerEvent {
+  event: string;
+  pid: number;
+  iteration?: number;
+  message?: string;
+}
+
+interface WorkerConfig {
+  mode: 'hold' | 'stress';
+  lockPath: string;
+  options: OwnershipFileLockOptions;
+  sentinelPath?: string;
+  journalPath?: string;
+  iterations?: number;
+}
+
+const PROJECT_ROOT = process.cwd();
+const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
+const WORKER = join(PROJECT_ROOT, 'tests', 'ts', 'fixtures', 'lineage-lock-worker.ts');
+const EVENT_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 8_000;
+
+class LockWorker {
+  readonly process: ChildProcessWithoutNullStreams;
+  readonly events: WorkerEvent[] = [];
+  readonly exit: Promise<number | null>;
+  private readonly waiters = new Set<() => void>();
+  private stdoutBuffer = '';
+  private stderr = '';
+
+  constructor(config: WorkerConfig) {
+    this.process = spawn(process.execPath, [TSX_CLI, WORKER, JSON.stringify(config)], {
+      cwd: PROJECT_ROOT,
+      env: { ...process.env, NO_COLOR: '1' },
+      stdio: ['pipe', 'pipe', 'pipe'],
+    });
+    this.process.stdout.setEncoding('utf8');
+    this.process.stderr.setEncoding('utf8');
+    this.process.stdout.on('data', chunk => this.consumeStdout(chunk));
+    this.process.stderr.on('data', chunk => { this.stderr += chunk; });
+    this.exit = new Promise((resolve, reject) => {
+      this.process.once('error', reject);
+      this.process.once('close', code => {
+        for (const wake of this.waiters) wake();
+        resolve(code);
+      });
+    });
+  }
+
+  send(command: 'start' | 'release' | 'crash'): void {
+    this.process.stdin.write(`${JSON.stringify({ command })}\n`);
+  }
+
+  async waitFor(event: string): Promise<WorkerEvent> {
+    const deadline = Date.now() + EVENT_TIMEOUT_MS;
+    while (true) {
+      const index = this.events.findIndex(candidate => candidate.event === event);
+      if (index >= 0) return this.events.splice(index, 1)[0]!;
+
+      const remaining = deadline - Date.now();
+      if (remaining <= 0 || this.process.exitCode !== null) {
+        throw new Error(
+          `Worker ${this.process.pid ?? 'unknown'} did not emit ${event}; ` +
+          `exit=${this.process.exitCode}, stderr=${this.stderr}, events=${JSON.stringify(this.events)}`
+        );
+      }
+      await new Promise<void>((resolve, reject) => {
+        const wake = (): void => {
+          clearTimeout(timer);
+          this.waiters.delete(wake);
+          resolve();
+        };
+        const timer = setTimeout(() => {
+          this.waiters.delete(wake);
+          reject(new Error(`Timed out waiting for worker event ${event}; stderr=${this.stderr}`));
+        }, remaining);
+        this.waiters.add(wake);
+      });
+    }
+  }
+
+  kill(): void {
+    if (this.process.exitCode === null && this.process.signalCode === null) {
+      this.process.kill('SIGKILL');
+    }
+  }
+
+  private consumeStdout(chunk: string): void {
+    this.stdoutBuffer += chunk;
+    while (true) {
+      const newline = this.stdoutBuffer.indexOf('\n');
+      if (newline < 0) break;
+      const line = this.stdoutBuffer.slice(0, newline);
+      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
+      if (line.trim()) this.events.push(JSON.parse(line) as WorkerEvent);
+      for (const wake of this.waiters) wake();
+    }
+  }
+}
+
+class BuiltCli {
+  readonly process: ChildProcessWithoutNullStreams;
+  readonly exit: Promise<number | null>;
+  stdout = '';
+  stderr = '';
+  private readonly waiters = new Set<() => void>();
+
+  constructor(vaultDir: string, args: string[]) {
+    this.process = spawn(process.execPath, [join(PROJECT_ROOT, 'dist', 'index.js'), '--vault', vaultDir, ...args], {
+      cwd: PROJECT_ROOT,
+      env: { ...process.env, NO_COLOR: '1' },
+      stdio: ['pipe', 'pipe', 'pipe'],
+    });
+    this.process.stdout.setEncoding('utf8');
+    this.process.stderr.setEncoding('utf8');
+    this.process.stdout.on('data', chunk => {
+      this.stdout += chunk;
+      for (const wake of this.waiters) wake();
+    });
+    this.process.stderr.on('data', chunk => {
+      this.stderr += chunk;
+      for (const wake of this.waiters) wake();
+    });
+    this.exit = new Promise((resolve, reject) => {
+      this.process.once('error', reject);
+      this.process.once('close', code => {
+        for (const wake of this.waiters) wake();
+        resolve(code);
+      });
+    });
+  }
+
+  async waitForOutput(text: string): Promise<void> {
+    const deadline = Date.now() + EVENT_TIMEOUT_MS;
+    while (!`${this.stdout}\n${this.stderr}`.includes(text)) {
+      const remaining = deadline - Date.now();
+      if (remaining <= 0 || this.process.exitCode !== null) {
+        throw new Error(
+          `CLI did not print ${JSON.stringify(text)}; exit=${this.process.exitCode}, ` +
+          `stdout=${this.stdout}, stderr=${this.stderr}`
+        );
+      }
+      await new Promise<void>((resolve, reject) => {
+        const wake = (): void => {
+          clearTimeout(timer);
+          this.waiters.delete(wake);
+          resolve();
+        };
+        const timer = setTimeout(() => {
+          this.waiters.delete(wake);
+          reject(new Error(`Timed out waiting for CLI output ${JSON.stringify(text)}`));
+        }, remaining);
+        this.waiters.add(wake);
+      });
+    }
+  }
+
+  async expectStillRunningFor(ms: number): Promise<void> {
+    const exited = await Promise.race([
+      this.exit.then(() => true),
+      new Promise<false>(resolve => setTimeout(() => resolve(false), ms)),
+    ]);
+    if (exited) {
+      throw new Error(`CLI exited before reaching the held lock; stdout=${this.stdout}, stderr=${this.stderr}`);
+    }
+  }
+
+  kill(): void {
+    if (this.process.exitCode === null && this.process.signalCode === null) {
+      this.process.kill('SIGKILL');
+    }
+  }
+}
+
+describe.sequential('cross-process ownership file lock', () => {
+  let tempDir: string;
+  let lockPath: string;
+  const workers: LockWorker[] = [];
+  const clis: BuiltCli[] = [];
+  const vaults: string[] = [];
+
+  beforeEach(async () => {
+    tempDir = await mkdtemp(join(tmpdir(), 'bwrb-lock-cross-process-'));
+    lockPath = join(tempDir, '.bwrb', 'locks', 'shared.lock');
+  });
+
+  afterEach(async () => {
+    for (const worker of workers) worker.kill();
+    for (const cli of clis) cli.kill();
+    await Promise.allSettled(workers.map(worker => worker.exit));
+    await Promise.allSettled(clis.map(cli => cli.exit));
+    workers.length = 0;
+    clis.length = 0;
+    await Promise.all(vaults.map(vault => cleanupTestVault(vault)));
+    vaults.length = 0;
+    await rm(tempDir, { recursive: true, force: true });
+  });
+
+  it('protects a live open-handle holder and closes before artifact cleanup', async () => {
+    const holder = startWorker({
+      mode: 'hold',
+      lockPath,
+      options: { retryMs: 5, attempts: 200, staleMs: 60, heartbeatMs: 10 },
+    });
+    await holder.waitFor('ready');
+    holder.send('start');
+    const acquired = await holder.waitFor('acquired');
+
+    const contender = startWorker({
+      mode: 'hold',
+      lockPath,
+      options: { retryMs: 5, attempts: 15, staleMs: 60, heartbeatMs: 10 },
+    });
+    await contender.waitFor('ready');
+    contender.send('start');
+    const fatal = await contender.waitFor('fatal');
+    expect(fatal.message).toBe('worker lock timeout');
+    expect(await contender.exit).toBe(1);
+
+    const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
+    expect(metadata.pid).toBe(acquired.pid);
+
+    holder.send('release');
+    await holder.waitFor('released');
+    expect(await holder.exit).toBe(0);
+    await expectNoArtifacts(lockPath);
+  });
+
+  it('recovers a dead holder, protects its successor, and cleans recovery artifacts', async () => {
+    const crashed = startWorker({
+      mode: 'hold',
+      lockPath,
+      options: { retryMs: 5, attempts: 200, staleMs: 60, heartbeatMs: 10 },
+    });
+    await crashed.waitFor('ready');
+    crashed.send('start');
+    await crashed.waitFor('acquired');
+    crashed.send('crash');
+    expect(await crashed.exit).toBe(70);
+
+    const successor = startWorker({
+      mode: 'hold',
+      lockPath,
+      options: { retryMs: 5, attempts: 400, staleMs: 60, heartbeatMs: 10 },
+    });
+    await successor.waitFor('ready');
+    successor.send('start');
+    const acquired = await successor.waitFor('acquired');
+    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }).pid).toBe(acquired.pid);
+
+    const contender = startWorker({
+      mode: 'hold',
+      lockPath,
+      options: { retryMs: 5, attempts: 15, staleMs: 60, heartbeatMs: 10 },
+    });
+    await contender.waitFor('ready');
+    contender.send('start');
+    expect((await contender.waitFor('fatal')).message).toBe('worker lock timeout');
+    expect(await contender.exit).toBe(1);
+    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }).pid).toBe(acquired.pid);
+
+    successor.send('release');
+    await successor.waitFor('released');
+    expect(await successor.exit).toBe(0);
+    await expectNoArtifacts(lockPath);
+  });
+
+  it('serializes a deterministic multi-process critical-section stress run', async () => {
+    const journalPath = join(tempDir, 'journal.ndjson');
+    const sentinelPath = join(tempDir, 'critical-section.active');
+    const options = { retryMs: 2, attempts: 2_000, staleMs: 1_000, heartbeatMs: 50 };
+    const contenders = Array.from({ length: 4 }, () => startWorker({
+      mode: 'stress',
+      lockPath,
+      options,
+      sentinelPath,
+      journalPath,
+      iterations: 12,
+    }));
+
+    await Promise.all(contenders.map(worker => worker.waitFor('ready')));
+    for (const worker of contenders) worker.send('start');
+    await Promise.all(contenders.map(worker => worker.waitFor('done')));
+    expect(await Promise.all(contenders.map(worker => worker.exit))).toEqual([0, 0, 0, 0]);
+    expect(contenders.flatMap(worker => worker.events).find(event => event.event === 'overlap')).toBeUndefined();
+
+    const journal = (await readFile(journalPath, 'utf8')).trim().split('\n')
+      .map(line => JSON.parse(line) as { event: 'enter' | 'exit'; pid: number; iteration: number });
+    expect(journal).toHaveLength(4 * 12 * 2);
+    for (let index = 0; index < journal.length; index += 2) {
+      const enter = journal[index]!;
+      const exit = journal[index + 1]!;
+      expect(enter.event).toBe('enter');
+      expect(exit).toEqual({ event: 'exit', pid: enter.pid, iteration: enter.iteration });
+    }
+    expect(existsSync(sentinelPath)).toBe(false);
+    await expectNoArtifacts(lockPath);
+  });
+
+  it('classifies under-lock delete disappearance in the actual built CLI text and JSON contracts', async () => {
+    const vaultDir = await createTestVault();
+    vaults.push(vaultDir);
+
+    const textTarget = join(vaultDir, 'Ideas', 'Sample Idea.md');
+    const textLock = startWorker({
+      mode: 'hold',
+      lockPath: getLineageMutationLockPath(vaultDir, textTarget),
+      options: { retryMs: 5, attempts: 400, staleMs: 1_000, heartbeatMs: 50 },
+    });
+    await textLock.waitFor('ready');
+    textLock.send('start');
+    await textLock.waitFor('acquired');
+
+    const textCli = startCli(vaultDir, ['delete', 'Sample Idea']);
+    textCli.process.stdin.end('y\n');
+    await textCli.waitForOutput('File to delete: Ideas/Sample Idea.md');
+    await unlink(textTarget);
+    textLock.send('release');
+    await textLock.waitFor('released');
+
+    expect(await textCli.exit).toBe(2);
+    expect(textCli.stderr).toContain(
+      'Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Sample Idea.md'
+    );
+    expect(textCli.stderr).not.toContain('File not found or already deleted');
+    await expectNoArtifacts(getLineageMutationLockPath(vaultDir, textTarget));
+
+    const jsonTarget = join(vaultDir, 'Ideas', 'Another Idea.md');
+    const jsonLock = startWorker({
+      mode: 'hold',
+      lockPath: getLineageMutationLockPath(vaultDir, jsonTarget),
+      options: { retryMs: 5, attempts: 400, staleMs: 1_000, heartbeatMs: 50 },
+    });
+    await jsonLock.waitFor('ready');
+    jsonLock.send('start');
+    await jsonLock.waitFor('acquired');
+
+    const jsonCli = startCli(vaultDir, [
+      'delete', '--path', 'Ideas/Another Idea.md', '--execute', '--output', 'json',
+    ]);
+    jsonCli.process.stdin.end();
+    // The held lock has no observer hook. A bounded alive check is the one
+    // timing allowance in this test: built dist startup/selection is complete
+    // well before this on both local and focused Windows CI, and an early exit
+    // fails with its captured output instead of being silently retried.
+    await jsonCli.expectStillRunningFor(process.platform === 'win32' ? 2_000 : 750);
+    await unlink(jsonTarget);
+    jsonLock.send('release');
+    await jsonLock.waitFor('released');
+
+    expect(await jsonCli.exit).toBe(2);
+    expect(JSON.parse(jsonCli.stdout)).toEqual({
+      success: false,
+      error: 'Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Another Idea.md',
+      data: {
+        reason: 'target-disappeared',
+        retryable: true,
+        paths: ['Ideas/Another Idea.md'],
+      },
+      code: 2,
+    });
+    await expectNoArtifacts(getLineageMutationLockPath(vaultDir, jsonTarget));
+  });
+
+  function startWorker(config: WorkerConfig): LockWorker {
+    const worker = new LockWorker(config);
+    workers.push(worker);
+    return worker;
+  }
+
+  function startCli(vaultDir: string, args: string[]): BuiltCli {
+    const cli = new BuiltCli(vaultDir, args);
+    clis.push(cli);
+    return cli;
+  }
+});
+
+async function expectNoArtifacts(lockPath: string): Promise<void> {
+  const entries = await readdir(join(lockPath, '..')).catch(() => []);
+  expect(entries.filter(entry => entry.startsWith(basename(lockPath)))).toEqual([]);
+}

diff --git a/tests/ts/lib/lineage-lock.test.ts b/tests/ts/lib/lineage-lock.test.ts
index ebec030..0ee322e 100644
--- a/tests/ts/lib/lineage-lock.test.ts
+++ b/tests/ts/lib/lineage-lock.test.ts
@@ -1,6 +1,6 @@
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import { existsSync } from 'fs';
-import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'fs/promises';
+import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'fs/promises';
 import { basename, join } from 'path';
 import { tmpdir } from 'os';
 import {
@@ -150,6 +150,26 @@ describe('lineage mutation lock', () => {
     expect(await readFile(lockPath, 'utf-8')).toBe('not-json\n');
   });
 
+  it.skipIf(process.platform === 'win32')('fails closed when an existing lock cannot be read', async () => {
+    const source = join(vaultDir, 'Source.md');
+    const lockPath = getLineageMutationLockPath(vaultDir, source);
+    await mkdir(join(vaultDir, '.bwrb', 'locks'), { recursive: true });
+    await writeFile(lockPath, lockMetadata(lockPath, deadPid(), 'unreadable-owner'));
+    await chmod(lockPath, 0o000);
+
+    try {
+      await expect(withLineageMutationLocks(
+        vaultDir,
+        [source],
+        async () => undefined,
+        { attempts: 8, retryMs: 2, staleMs: 1 }
+      )).rejects.toThrow('Timed out waiting for a fork-lineage mutation lock');
+      expect(existsSync(lockPath)).toBe(true);
+    } finally {
+      await chmod(lockPath, 0o600);
+    }
+  });
+
   it('does not let an old holder release a replacement lock with another token', async () => {
     const source = join(vaultDir, 'Source.md');
     const lockPath = getLineageMutationLockPath(vaultDir, source);

END DIFF

ADDITIONAL CONTEXT
The originating user explicitly requires both Fable passes to leave durable logs under `.task-sweep/logs/`. Those prompt, output, and metadata files are intentional task evidence, not accidental runtime artifacts. Do not classify their presence alone as unrequested scope. The metadata logs contain model/finish/output metadata and previews, not secrets.
END ADDITIONAL CONTEXT

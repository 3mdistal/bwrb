# TaskSweep early planning packet — BWRB issue #807

You are advising on a repository task before implementation. You have no tools. Do not claim to inspect anything outside this packet. Give concise advice to another implementation agent; do not mutate anything or broaden beyond the issue.

## Normalized task

- ID/source: GitHub issue #807, `https://github.com/3mdistal/bwrb/issues/807`
- Title: Harden lineage lock portability and cross-process errors
- Repo/base: `3mdistal/bwrb`, `origin/main` at `55dfc19887d9442fe0d3c94b28ac01b18c7012a0`
- Branch/lane: `codex/807-lineage-lock-hardening` in an isolated worktree
- Problem: PR #806 added path-keyed cross-process locks for `new --fork` and non-force delete. Current tests prove ownership, heartbeats, stale/dead recovery, token-safe release, contenders, and CLI races on the local platform, but the issue still asks for explicit Windows/open-handle coverage, a deterministic cross-process stress harness, and a stable error when a delete target disappears while the command waits for its authoritative lock.
- Desired outcome:
  1. The shared lineage/ownership lock preserves mutual exclusion and cleans its lock/recovery/quarantine artifacts on supported POSIX and Windows environments, with a focused Windows CI lane or equivalent harness.
  2. A deterministic multi-process test—not merely in-process promises or probabilistic CLI races—proves live-holder protection, dead-holder recovery, successor ownership, no overlapping critical sections, and cleanup.
  3. Non-force delete classifies a target that disappears between initial selection and the under-lock recheck with stable documented text and JSON behavior, rather than a generic raw or misleading `ENOENT`.
  4. Existing fork, adopt, delete-lineage, note-ID-lock, and full repository suites remain green.
- Manual successful story: As a vault owner running competing BWRB processes, a crashed lineage mutator cannot leave the vault permanently locked and live/successor holders cannot overlap or have their locks stolen. If another process deletes my target while my non-force delete waits, BWRB returns a clear retryable result and leaves no lock debris.
- Merge is authorized only after the full TaskSweep and repository-policy gates. The implementer must open a draft PR and must not ready or merge it.

## Repo facts and standards

- TypeScript ESM Commander CLI; Node 22; pnpm 10.11.0.
- Required checks: `Test`, `PTY Tests`, `Vercel`; strict up-to-date branch protection; zero required approvals.
- Full local parity in exact order: build, verify:pack, typecheck, lint, knip, non-PTY test suite.
- Canonical user docs live in `docs-site/src/content/docs/`; bundled agent guidance is `docs/skill/SKILL.md` when command behavior changes.
- Current `.github/workflows/ci.yml` runs Linux/Ubuntu only. A Windows-focused job must avoid silently testing a different contract and must remain practical for PR CI.
- Use `pnpm test`/Vitest run semantics; do not invoke watch mode.

## Current implementation

### Ownership-safe shared lock

`src/lib/lineage-lock.ts` now exposes `withLineageMutationLocks` and `withOwnershipFileLock`. It:

- derives deterministic SHA-256 lock paths from normalized vault-relative source paths;
- writes JSON metadata `{ version, pid, token, createdAt, heartbeatAt, pathKey }` under exclusive `open(..., 'wx')`;
- heartbeats the owned open handle with `handle.utimes`;
- checks process liveness with `process.kill(pid, 0)` after TTL expiry;
- uses a fixed `.recovery` ownership marker, rechecks stale state, renames stale locks to unique `.quarantine-*` paths, unlinks quarantine, and cleans stale quarantine files;
- releases only when the token plus snapshot raw/dev/inode/mtime/size still match;
- sorts multi-lock acquisition to avoid deadlock.

PR #817 generalized this primitive for the fixed note-ID assignment and registry lock paths after an independent tester reproduced an old-holder/successor overlap bug. New `tests/ts/lib/note-id-lock.test.ts` covers heartbeat and successor ownership in process, but not a true child-process stress harness. This partially satisfies #807; do not duplicate it or reopen the fixed race.

Potential portability seams to examine:

- `readLockSnapshot` catches every read/stat error and returns null, erasing distinctions such as Windows sharing/permission errors.
- stale recovery renames then unlinks a lock pathname; Windows open-handle rules differ from POSIX.
- `cleanupQuarantines` unlinks matching paths concurrently and ignores errors.
- `process.kill(pid, 0)`, inode/dev identity, and open-handle `utimes` need actual Windows evidence.
- tests currently synthesize dead PIDs and contenders in one Vitest process.

### Delete disappearance behavior

Single non-force delete resolves a file, performs prompts/backlink work, then:

```ts
await withLineageMutationLocks(vaultDir, [fullPath], async () => {
  const assessment = await assessCurrentDeleteLineage(schema, vaultDir, [file]);
  if (assessment.length > 0) throw new LineageDeleteRefusalError(assessment);
  await unlink(fullPath);
  await unregisterIssuedNotePath(vaultDir, relativePath);
});
```

`assessCurrentDeleteLineage` rebuilds a fresh snapshot. If the selected path is now missing it creates an `Error("File not found or no longer managed: ...")` and assigns `error.code = 'ENOENT'`. The outer delete command collapses all `ENOENT` errors to:

- text: `File not found or already deleted`, exit validation error;
- JSON: `{ success: false, error: "File not found or already deleted", code: IO_ERROR }`.

The issue asks for stable classification of the specific between-selection-and-lock disappearance. Consider a narrow typed error with a retryable machine-readable payload/code and documented wording, without changing unrelated initial not-found behavior. Cover bulk and single paths if they share the same under-lock assessor.

### Existing tests

- `tests/ts/lib/lineage-lock.test.ts`: deterministic lock path, cleanup, ordered multi-lock acquisition, TTL recovery, live-holder protection, heartbeat, dead/corrupt recovery, token-safe replacement, 2/10 in-process contenders, recovery-marker ownership, timeout.
- `tests/ts/lib/note-id-lock.test.ts`: both fixed note-ID lock paths, heartbeat/live holder, successor preservation and third-holder serialization.
- `tests/ts/commands/delete-lineage.test.ts`: non-force guard behavior and a real CLI fork-versus-delete race, but no deterministic target-disappears-while-waiting scenario.

## Planning questions

Give a concise implementation plan covering:

1. The smallest production-code changes needed for supported Windows semantics. Should recovery retry specific Windows sharing errors, avoid relying on inode identity when unavailable, or preserve current fail-closed timeout behavior?
2. A deterministic cross-process Vitest/worker design that runs on POSIX and Windows, uses short injectable timing, proves no overlap and artifact cleanup, and would fail on a deliberately broken ownership implementation.
3. The safest CI shape for Windows coverage without destabilizing unrelated PTY/full-suite jobs.
4. A stable text/JSON contract and typed error for a delete target disappearing during the authoritative under-lock recheck, including whether the JSON payload should include `retryable`, `reason`, and target paths.
5. Exact focused and real CLI checks, docs/changelog changes, and likely failure modes.
6. Scope traps or conflicts with the later #820 edit/identity-write concurrency task. Keep #820 out of this PR unless a tiny reusable primitive is strictly necessary.

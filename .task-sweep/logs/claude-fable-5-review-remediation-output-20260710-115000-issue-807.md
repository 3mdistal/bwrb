NO BLOCKERS

## SPEC FIDELITY

**Windows spawn fix (setup.ts):** Correct. `node_modules/.bin/tsx` is a POSIX shell shim (a `.cmd` on Windows, which `spawn` cannot exec without `shell: true`). Invoking `process.execPath` with `tsx/dist/cli.mjs` as the script is fully portable, pins the child to the same Node binary running the tests, and preserves the dist/source mode split exactly (`USE_DIST` → `dist/index.js`, else tsx + `src/index.ts`). Both call sites (`runCLI`, `runCLIWithOpenStdin`) were updated consistently.

**Windows timeout fix (lineage-lock test):** Correct in intent and preserves test integrity. The prior interactive flow (`stdin.end('y\n')` + `waitForOutput` on the prompt) was the Windows-flaky observer; the interactive prompt itself is not the property under test — the property is "file removed while blocked on lock → exit 2 with exact text." Switching to `--path ... --execute` removes the fragile observer while the downstream assertions (exit 2, exact text) remain outside this diff. Critically, the failure mode of the bounded `expectStillRunningFor` heuristic is fail-safe: if the CLI hasn't reached the lock wait before `unlink`, the test fails with a different error/output — it cannot falsely pass. Parity with the JSON sibling's evidence mechanism is a consistency improvement. 115/115 targeted and 3030-pass full parity corroborate.

## STANDARDS AND RISK

Non-blocking observations:

1. **Hardcoded internal tsx path.** `node_modules/tsx/dist/cli.mjs` reaches into the package's internal layout rather than its declared bin/exports. It works under pnpm's symlinked layout today, but would break silently on a tsx restructure. Consider `createRequire(import.meta.url).resolve('tsx/cli')` (tsx exports `./cli`) for a contract-backed resolution.

2. **Timing-based liveness is a heuristic, not a synchronization point.** `expectStillRunningFor(2000/750)` can flake under heavy CI load (child slow to reach the lock wait). As noted above the flake direction is a false failure, not a false pass, and the non-interactive path genuinely has no public contention observer — the inline comment documents this honestly. Acceptable; just expect occasional retries on loaded runners.

3. **Coverage shift, not loss.** The interactive-confirm ("y") path is no longer exercised under lock contention in this specific test. Fine as long as interactive delete confirmation is covered elsewhere in the suite (the 3030-test parity run suggests it is); worth a one-line confirmation in the PR description.

4. Platform-conditional wait (2s Windows vs 750ms) adds ~1–2s wall time per run on Windows only; bounded and proportionate.

**Verdict:** The delta resolves both cited Windows failures at their root causes (shell-shim spawn, interactive-output observer) without weakening product assertions. Ready to proceed.
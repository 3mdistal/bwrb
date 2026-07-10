You are performing a focused follow-up review after a CI fix loop. A prior full embedded review of BWRB PR #821 returned NO BLOCKERS using anthropic/claude-fable-5. The real Windows runner then failed because a shared test helper spawned the POSIX node_modules/.bin/tsx path, and because an interactive text-race observer timed out on Windows. Review only the remediation delta embedded below for correctness, regression risk, test validity, and whether it resolves those Windows failures without weakening product assertions.

Constraints:
- No tools or edits.
- This is a PR readiness gate.
- Start with exactly one of: BLOCKERS, NON-BLOCKING, NO BLOCKERS.
- Separate SPEC FIDELITY from STANDARDS AND RISK.
- Block only on concrete correctness, test-integrity, or repository-standard issues.
- Keep the response concise.

Context and evidence:
- BWRB is Node 22, TypeScript ESM, pnpm 10.11.0.
- Source-mode CLI tests must launch tsx portably; dist-mode tests must launch dist/index.js.
- After this delta, targeted tests passed 115/115.
- Exact full parity after this delta passed: build, verify:pack, typecheck, lint, knip, and 3030 passed/3 skipped across 114 files.
- The text disappearance test remains a real built dist CLI invocation, still asserts exit 2 and exact text, and now uses the same bounded lock-wait evidence already used by its JSON sibling.
- Durable .task-sweep logs committed alongside the delta are explicitly required by the originating user and are out of review scope here.

BEGIN REMEDIATION DIFF
diff --git a/tests/ts/fixtures/setup.ts b/tests/ts/fixtures/setup.ts
index fd36863..5d25aff 100644
--- a/tests/ts/fixtures/setup.ts
+++ b/tests/ts/fixtures/setup.ts
@@ -9,7 +9,7 @@ import { BASELINE_SCHEMA } from './schemas.js';
 export const PROJECT_ROOT = process.cwd();
 export const CLI_PATH = join(PROJECT_ROOT, 'dist/index.js');
 const CLI_SRC_PATH = join(PROJECT_ROOT, 'src/index.ts');
-const TSX_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
+const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
 
 const USE_DIST = process.env.BWRB_TEST_DIST === '1';
 const NODE_DEP0205_SUPPRESSION = '--disable-warning=DEP0205';
@@ -431,8 +431,10 @@ export async function runCLI(
     retries = RUN_CLI_RETRIES,
   } = options;
 
-  const cliCommand = USE_DIST ? 'node' : TSX_BIN;
-  const cliArgs = USE_DIST ? [CLI_PATH, ...fullArgs] : [CLI_SRC_PATH, ...fullArgs];
+  const cliCommand = process.execPath;
+  const cliArgs = USE_DIST
+    ? [CLI_PATH, ...fullArgs]
+    : [TSX_CLI, CLI_SRC_PATH, ...fullArgs];
 
   const childEnv: Record<string, string> = Object.fromEntries(
     Object.entries(process.env).filter(
@@ -485,8 +487,10 @@ export async function runCLIWithOpenStdin(
   }: Pick<RunCLIOptions, 'cwd' | 'env' | 'timeoutMs'> = {}
 ): Promise<CLIResult> {
   const fullArgs = vaultDir ? ['--vault', vaultDir, ...args] : args;
-  const cliCommand = USE_DIST ? 'node' : TSX_BIN;
-  const cliArgs = USE_DIST ? [CLI_PATH, ...fullArgs] : [CLI_SRC_PATH, ...fullArgs];
+  const cliCommand = process.execPath;
+  const cliArgs = USE_DIST
+    ? [CLI_PATH, ...fullArgs]
+    : [TSX_CLI, CLI_SRC_PATH, ...fullArgs];
   const mergedEnv = withTestCliNodeOptions({
     ...process.env,
     NO_COLOR: '1',
diff --git a/tests/ts/lib/lineage-lock-cross-process.test.ts b/tests/ts/lib/lineage-lock-cross-process.test.ts
index b732cff..60148c1 100644
--- a/tests/ts/lib/lineage-lock-cross-process.test.ts
+++ b/tests/ts/lib/lineage-lock-cross-process.test.ts
@@ -322,9 +322,14 @@ describe.sequential('cross-process ownership file lock', () => {
     textLock.send('start');
     await textLock.waitFor('acquired');
 
-    const textCli = startCli(vaultDir, ['delete', 'Sample Idea']);
-    textCli.process.stdin.end('y\n');
-    await textCli.waitForOutput('File to delete: Ideas/Sample Idea.md');
+    const textCli = startCli(vaultDir, [
+      'delete', '--path', 'Ideas/Sample Idea.md', '--execute',
+    ]);
+    textCli.process.stdin.end();
+    // This non-interactive invocation has no public observer for lock
+    // contention. A bounded alive check proves the process reached the held
+    // lock before the target is removed; an early exit reports captured output.
+    await textCli.expectStillRunningFor(process.platform === 'win32' ? 2_000 : 750);
     await unlink(textTarget);
     textLock.send('release');
     await textLock.waitFor('released');

END REMEDIATION DIFF


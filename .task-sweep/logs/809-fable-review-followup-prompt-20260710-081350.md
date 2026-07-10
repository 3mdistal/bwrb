You are performing the final follow-up review of a Bowerbird pull request after your first diff-only review returned one blocker.

The blocker was that date_format lacked a rejected-string/no-write contract. The revised diff now:
- requires YYYY, MM, and DD exactly once each at the config-command boundary;
- rejects type mismatches and incomplete pattern strings before writing;
- tests unchanged schema bytes for both invalid forms;
- documents the exact command contract;
- leaves ConfigSchema itself unchanged to avoid breaking hand-authored existing schemas.

Relevant unchanged context:
- ConfigSchema currently declares date_format as z.string().optional() and describes YYYY/MM/DD token patterns.
- formatDateWithPattern performs one replacement for each of YYYY, MM, and DD; duplicated or missing tokens therefore cannot represent a complete generated date.
- writeValidatedSchema still runs BwrbSchema.parse and resolveSchema before write for all config edits.

Verification after the fix: build, typecheck, lint, 38 focused source command tests, 38 focused dist command tests, 9 PTY tests, docs lint/doctor/check/build, and diff check all pass. The earlier full gate passed build, verify:pack, typecheck, lint, knip, and 2,979 non-PTY tests with 3 skipped.

Constraints:
- Review only the embedded diff and narrowly supplied context above.
- Do not use tools or mutate anything.
- Treat this as the final PR readiness gate.
- Start with exactly one verdict label: BLOCKERS, NON-BLOCKING, or NO BLOCKERS.
- Separate blockers from non-blocking notes.
- Keep the response short.
- The first line must be exactly one of: BLOCKERS, NON-BLOCKING, NO BLOCKERS.

BEGIN DIFF
diff --git a/docs-site/src/content/docs/product/roadmap.md b/docs-site/src/content/docs/product/roadmap.md
index a6b9672..3a36fce 100644
--- a/docs-site/src/content/docs/product/roadmap.md
+++ b/docs-site/src/content/docs/product/roadmap.md
@@ -31,8 +31,6 @@ exist:
 - Keep migrations and audit fixes conservative as schemas grow more expressive
 - Improve completion parity (including the current `init` omission, tracked in
   [#810](https://github.com/3mdistal/bwrb/issues/810))
-- Align the config command with valid schema settings (tracked in
-  [#809](https://github.com/3mdistal/bwrb/issues/809))
 
 ## Genuinely future
 
diff --git a/docs-site/src/content/docs/reference/commands/config.md b/docs-site/src/content/docs/reference/commands/config.md
index eda712c..1feea54 100644
--- a/docs-site/src/content/docs/reference/commands/config.md
+++ b/docs-site/src/content/docs/reference/commands/config.md
@@ -29,16 +29,23 @@ bwrb config <subcommand>
 | `obsidian_vault` | Obsidian vault name for URI scheme | String |
 | `default_dashboard` | Dashboard used when no name is passed | Dashboard name or empty string |
 | `excluded_directories` | Directory prefixes excluded from discovery and targeting | JSON string array |
+| `date_format` | Format used when writing dates | Pattern string using `YYYY`, `MM`, and `DD` tokens |
+| `date_granularity` | Default coarsest precision for date fields | `day`, `month`, `year` |
 | `mention_exclude_types` | Types excluded as mention targets | JSON string array |
 | `mention_exclude_paths` | Path globs excluded as mention targets | JSON string array |
 | `mention_link_once` | Limit auto-fixes to one link per note/target pair | Boolean |
 
-This is the command's complete editable subset. Other valid schema settings —
-including `date_format`, `date_granularity`, `calendars`,
-`mention_fuzzy_threshold`, and the `mention_corpus_*` keys — must currently be
-edited directly in `.bwrb/schema.json` and checked with
-`bwrb schema validate`. The difference is tracked in
-[#809](https://github.com/3mdistal/bwrb/issues/809).
+This is the command's complete editable subset. Nested `calendars` definitions
+remain a schema workflow while guided calendar authoring is tracked in
+[#790](https://github.com/3mdistal/bwrb/issues/790). Advanced
+`mention_fuzzy_threshold` and `mention_corpus_*` tuning also remains
+schema-only. Edit those settings directly in `.bwrb/schema.json` and check the
+result with `bwrb schema validate`.
+
+When unset, `date_format` is `YYYY-MM-DD` and `date_granularity` is `day`.
+Through `config edit`, `date_format` requires each of `YYYY`, `MM`, and `DD`
+exactly once. Supported patterns include `YYYY-MM-DD`, `MM/DD/YYYY`,
+`DD/MM/YYYY`, and `DD-MM-YYYY`.
 
 ## Configuration Location
 
@@ -77,6 +84,7 @@ bwrb config list
 # Show specific option
 bwrb config list open_with
 bwrb config list link_format
+bwrb config list date_format
 
 # JSON output
 bwrb config list --output json
@@ -118,6 +126,7 @@ bwrb config edit
 # Edit specific option
 bwrb config edit open_with
 bwrb config edit link_format
+bwrb config edit date_granularity
 ```
 
 #### Non-interactive (JSON) Mode
@@ -129,6 +138,10 @@ bwrb config edit open_with --json '"editor"'
 # Set complex value
 bwrb config edit obsidian_vault --json '"My Vault"'
 
+# Set date writing and partial-date defaults
+bwrb config edit date_format --json '"DD/MM/YYYY"'
+bwrb config edit date_granularity --json '"month"'
+
 # Set arrays and booleans
 bwrb config edit excluded_directories --json '["Archive","Templates"]'
 bwrb config edit mention_exclude_paths --json '["Imports/**"]'
diff --git a/docs-site/src/content/docs/reference/schema.md b/docs-site/src/content/docs/reference/schema.md
index 72f6ab2..fb17ef1 100644
--- a/docs-site/src/content/docs/reference/schema.md
+++ b/docs-site/src/content/docs/reference/schema.md
@@ -813,12 +813,13 @@ Vault-wide settings:
 | `mention_exclude_types` | array | `[]` | Type names excluded as mention targets; matching notes are still scanned as source documents |
 | `mention_exclude_paths` | array | `[]` | Vault-relative globs excluded as mention targets; matching notes are still scanned as source documents |
 
-`bwrb config list/edit` currently exposes only a subset of these keys. Date
-formats, date granularity, calendar definitions, and corpus/fuzzy tuning are
-currently schema-only settings; edit `.bwrb/schema.json` and validate it with
-`bwrb schema validate`. See [bwrb config](/reference/commands/config/) for the
-editable subset and [#809](https://github.com/3mdistal/bwrb/issues/809) for the
-tracked command/schema mismatch.
+`bwrb config list/edit` exposes the common scalar settings above, including
+`date_format` and `date_granularity`. Calendar definitions and advanced
+corpus/fuzzy tuning remain schema-only settings; edit `.bwrb/schema.json` and
+validate it with `bwrb schema validate`. See
+[bwrb config](/reference/commands/config/) for the exact editable subset and
+[#790](https://github.com/3mdistal/bwrb/issues/790) for guided calendar
+authoring.
 
 ---
 
diff --git a/docs/product/roadmap.md b/docs/product/roadmap.md
index 2663a02..0e795b7 100644
--- a/docs/product/roadmap.md
+++ b/docs/product/roadmap.md
@@ -38,8 +38,7 @@ mutation surface.
    non-interactive guarantees, and conservative destructive-operation gates.
 3. **Schema evolution reliability** — Continue strengthening migration/audit
    behavior as field and calendar expressiveness grows.
-4. **Known parity gaps** — Resolve schema/config command coverage
-   ([#809](https://github.com/3mdistal/bwrb/issues/809)) and completion tables
+4. **Known parity gaps** — Resolve completion tables
    ([#810](https://github.com/3mdistal/bwrb/issues/810)).
 
 ## Future boundary
diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index dc56114..6447026 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -160,18 +160,24 @@ bwrb config list
 # Edit a command-supported config option
 bwrb config edit open_with --json '"editor"'
 
+# Set date writing and partial-date defaults
+bwrb config edit date_format --json '"DD/MM/YYYY"'
+bwrb config edit date_granularity --json '"month"'
+
 # Exclude directories globally
 bwrb config edit excluded_directories --json '["Archive","Templates"]'
 ```
 
-`config list/edit` currently supports only `link_format`, `editor`, `visual`,
-`open_with`, `obsidian_vault`, `default_dashboard`, `excluded_directories`,
-`mention_exclude_types`, `mention_exclude_paths`, and `mention_link_once`.
-`date_format`, `date_granularity`, `calendars`, `mention_fuzzy_threshold`, and
-the `mention_corpus_*` keys are valid schema settings but are **schema-only**:
-edit `.bwrb/schema.json` and run `bwrb schema validate`. Do not send them to
-`bwrb config edit` (tracked in
-[#809](https://github.com/3mdistal/bwrb/issues/809)).
+`config list/edit` supports `link_format`, `editor`, `visual`, `open_with`,
+`obsidian_vault`, `default_dashboard`, `excluded_directories`, `date_format`,
+`date_granularity`, `mention_exclude_types`, `mention_exclude_paths`, and
+`mention_link_once`. `calendars`, `mention_fuzzy_threshold`, and the
+`mention_corpus_*` keys remain **schema-only**: edit `.bwrb/schema.json` and run
+`bwrb schema validate`. Guided calendar authoring is tracked in
+[#790](https://github.com/3mdistal/bwrb/issues/790).
+
+For command edits, `date_format` must contain each of `YYYY`, `MM`, and `DD`
+exactly once. `date_granularity` accepts `day`, `month`, or `year`.
 
 ## Built-in Frontmatter Fields
 
diff --git a/src/commands/config.ts b/src/commands/config.ts
index bfbedd3..02d0f8b 100644
--- a/src/commands/config.ts
+++ b/src/commands/config.ts
@@ -77,6 +77,19 @@ const CONFIG_OPTIONS: ConfigOptionMeta[] = [
     description: 'Directory prefixes to exclude from discovery/targeting (applies to all commands)',
     default: [],
   },
+  {
+    key: 'date_format',
+    label: 'Date Format',
+    description: 'Format for date fields using YYYY, MM, and DD tokens',
+    default: 'YYYY-MM-DD',
+  },
+  {
+    key: 'date_granularity',
+    label: 'Date Granularity',
+    description: 'Default coarsest precision allowed for date fields',
+    options: ['day', 'month', 'year'],
+    default: 'day',
+  },
   {
     key: 'mention_exclude_types',
     label: 'Mention Exclude Types',
@@ -97,6 +110,13 @@ const CONFIG_OPTIONS: ConfigOptionMeta[] = [
   },
 ];
 
+/**
+ * Config keys intentionally exposed by the command. This remains an explicit
+ * allowlist: nested calendars and advanced mention tuning require dedicated
+ * UX or direct schema editing rather than becoming writable by accident.
+ */
+export const CONFIG_OPTION_KEYS = CONFIG_OPTIONS.map((option) => option.key);
+
 export const configCommand = new Command('config')
   .description('Manage vault-wide configuration');
 
@@ -357,6 +377,10 @@ function getConfigValue(config: Partial<Config>, key: keyof Config, vaultDir: st
     case 'mention_exclude_types':
     case 'mention_exclude_paths':
       return [];
+    case 'date_format':
+      return 'YYYY-MM-DD';
+    case 'date_granularity':
+      return 'day';
     case 'mention_link_once':
       return false;
     default:
@@ -420,6 +444,17 @@ function validateConfigValue(meta: ConfigOptionMeta, value: unknown): void {
     return;
   }
 
+  if (meta.key === 'date_format') {
+    const requiredTokens = ['YYYY', 'MM', 'DD'];
+    const hasEachTokenExactlyOnce =
+      typeof value === 'string' &&
+      requiredTokens.every(token => value.split(token).length === 2);
+
+    if (!hasEachTokenExactlyOnce) {
+      throw new Error('date_format must contain YYYY, MM, and DD exactly once each');
+    }
+  }
+
   if (
     meta.key === 'excluded_directories' ||
     meta.key === 'mention_exclude_types' ||
diff --git a/tests/ts/commands/config.pty.test.ts b/tests/ts/commands/config.pty.test.ts
index 565dab1..32e3243 100644
--- a/tests/ts/commands/config.pty.test.ts
+++ b/tests/ts/commands/config.pty.test.ts
@@ -109,6 +109,26 @@ describePty('config command PTY tests', () => {
       );
     }, 20000);
 
+    it('should edit date_granularity interactively', async () => {
+      await withTempVault(
+        ['config', 'edit', 'date_granularity'],
+        async (proc, vaultPath) => {
+          await proc.waitFor('Date Granularity', 10000);
+          proc.write(Keys.DOWN); // month
+          await proc.waitFor('month', 2000);
+          proc.write(Keys.ENTER);
+
+          await proc.waitFor('Set date_granularity', 5000);
+          await proc.waitForExit(5000);
+
+          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
+          const schema = JSON.parse(schemaContent);
+          expect(schema.config.date_granularity).toBe('month');
+        },
+        { schema: CONFIG_TEST_SCHEMA }
+      );
+    }, 20000);
+
     it('should cancel on Ctrl+C during option selection', async () => {
       await withTempVault(
         ['config', 'edit', 'link_format'],
@@ -185,6 +205,30 @@ describePty('config command PTY tests', () => {
         { schema: schemaWithEditor }
       );
     }, 20000);
+
+    it('should edit date_format interactively', async () => {
+      await withTempVault(
+        ['config', 'edit', 'date_format'],
+        async (proc, vaultPath) => {
+          await proc.waitFor('Date Format', 10000);
+          await proc.waitFor('enter new value', 2000);
+          proc.write(Keys.DOWN); // clear
+          proc.write(Keys.DOWN); // enter new value
+          proc.write(Keys.ENTER);
+          await proc.waitFor('Enter date_format', 5000);
+          proc.write('DD/MM/YYYY');
+          proc.write(Keys.ENTER);
+
+          await proc.waitFor('Set date_format', 5000);
+          await proc.waitForExit(5000);
+
+          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
+          const schema = JSON.parse(schemaContent);
+          expect(schema.config.date_format).toBe('DD/MM/YYYY');
+        },
+        { schema: CONFIG_TEST_SCHEMA }
+      );
+    }, 20000);
   });
 
   describe('config edit (full flow from picker)', () => {
diff --git a/tests/ts/commands/config.test.ts b/tests/ts/commands/config.test.ts
index b0cad01..4686982 100644
--- a/tests/ts/commands/config.test.ts
+++ b/tests/ts/commands/config.test.ts
@@ -4,6 +4,18 @@ import { join } from 'path';
 import { mkdtemp } from 'fs/promises';
 import { tmpdir } from 'os';
 import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
+import { CONFIG_OPTION_KEYS } from '../../../src/commands/config.js';
+import { ConfigSchema, type Config } from '../../../src/types/schema.js';
+
+const INTENTIONALLY_UNEXPOSED_CONFIG_KEYS = [
+  // Calendar objects need guided authoring rather than a flat config editor (#790).
+  'calendars',
+  // Advanced mention tuning remains schema-only; dedicated command UX has not been designed.
+  'mention_fuzzy_threshold',
+  'mention_corpus_calibration',
+  'mention_corpus_min_notes',
+  'mention_corpus_noncanonical_ratio',
+] as const satisfies readonly (keyof Config)[];
 
 describe('config command', () => {
   let vaultDir: string;
@@ -32,6 +44,8 @@ describe('config command', () => {
       expect(result.stdout).toContain('open_with');
       expect(result.stdout).toContain('obsidian_vault');
       expect(result.stdout).toContain('excluded_directories');
+      expect(result.stdout).toContain('date_format');
+      expect(result.stdout).toContain('date_granularity');
     });
 
     it('should show default values when config is not set', async () => {
@@ -53,6 +67,8 @@ describe('config command', () => {
       expect(json.data).toBeDefined();
       expect(json.data.link_format).toBe('wikilink');
       expect(json.data.excluded_directories).toEqual([]);
+      expect(json.data.date_format).toBe('YYYY-MM-DD');
+      expect(json.data.date_granularity).toBe('day');
       // open_with should be one of the valid options
       expect(['system', 'editor', 'visual', 'obsidian']).toContain(json.data.open_with);
     });
@@ -70,6 +86,8 @@ describe('config command', () => {
             link_format: 'markdown',
             open_with: 'obsidian',
             editor: 'nvim',
+            date_format: 'DD/MM/YYYY',
+            date_granularity: 'month',
           },
         })
       );
@@ -82,6 +100,8 @@ describe('config command', () => {
         expect(json.data.link_format).toBe('markdown');
         expect(json.data.open_with).toBe('obsidian');
         expect(json.data.editor).toBe('nvim');
+        expect(json.data.date_format).toBe('DD/MM/YYYY');
+        expect(json.data.date_granularity).toBe('month');
       } finally {
         await rm(tempVaultDir, { recursive: true, force: true });
       }
@@ -89,6 +109,32 @@ describe('config command', () => {
   });
 
   describe('config list <option> (specific option)', () => {
+    it('should list date settings with their effective defaults', async () => {
+      const textResult = await runCLI(['config', 'list', 'date_granularity'], vaultDir);
+      const formatResult = await runCLI(['config', 'list', 'date_format', '--output', 'json'], vaultDir);
+      const granularityResult = await runCLI(
+        ['config', 'list', 'date_granularity', '--output', 'json'],
+        vaultDir
+      );
+
+      expect(textResult.exitCode).toBe(0);
+      expect(textResult.stdout).toContain('Date Granularity (date_granularity)');
+      expect(textResult.stdout).toContain('Value: day');
+      expect(textResult.stdout).toContain('Options: day, month, year');
+      expect(formatResult.exitCode).toBe(0);
+      expect(JSON.parse(formatResult.stdout).data).toMatchObject({
+        key: 'date_format',
+        value: 'YYYY-MM-DD',
+        default: 'YYYY-MM-DD',
+      });
+      expect(granularityResult.exitCode).toBe(0);
+      expect(JSON.parse(granularityResult.stdout).data).toMatchObject({
+        key: 'date_granularity',
+        value: 'day',
+        default: 'day',
+      });
+    });
+
     it('should show details for a specific option', async () => {
       const result = await runCLI(['config', 'list', 'link_format'], vaultDir);
 
@@ -203,6 +249,77 @@ describe('config command', () => {
       expect(json.data.value).toEqual(['Archive', 'Templates']);
     });
 
+    it('should set date_format and date_granularity values', async () => {
+      const formatResult = await runCLI(
+        ['config', 'edit', 'date_format', '--json', '"DD/MM/YYYY"', '--output', 'json'],
+        tempVaultDir
+      );
+      const granularityResult = await runCLI(
+        ['config', 'edit', 'date_granularity', '--json', '"month"', '--output', 'json'],
+        tempVaultDir
+      );
+
+      expect(formatResult.exitCode).toBe(0);
+      expect(JSON.parse(formatResult.stdout)).toEqual({
+        success: true,
+        data: { key: 'date_format', value: 'DD/MM/YYYY' },
+      });
+      expect(granularityResult.exitCode).toBe(0);
+      expect(JSON.parse(granularityResult.stdout)).toEqual({
+        success: true,
+        data: { key: 'date_granularity', value: 'month' },
+      });
+
+      const schema = JSON.parse(
+        await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8')
+      );
+      expect(schema.config.date_format).toBe('DD/MM/YYYY');
+      expect(schema.config.date_granularity).toBe('month');
+    });
+
+    it('should reject invalid date settings without writing', async () => {
+      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
+      const before = await readFile(schemaPath, 'utf-8');
+
+      const invalidFormat = await runCLI(
+        ['config', 'edit', 'date_format', '--json', '42', '--output', 'json'],
+        tempVaultDir
+      );
+      expect(invalidFormat.exitCode).toBe(1);
+      expect(JSON.parse(invalidFormat.stdout).success).toBe(false);
+      expect(await readFile(schemaPath, 'utf-8')).toBe(before);
+
+      const incompleteFormat = await runCLI(
+        ['config', 'edit', 'date_format', '--json', '"YYYY-MM"', '--output', 'json'],
+        tempVaultDir
+      );
+      expect(incompleteFormat.exitCode).toBe(1);
+      expect(JSON.parse(incompleteFormat.stdout).error).toContain(
+        'date_format must contain YYYY, MM, and DD exactly once each'
+      );
+      expect(await readFile(schemaPath, 'utf-8')).toBe(before);
+
+      const invalidGranularity = await runCLI(
+        ['config', 'edit', 'date_granularity', '--json', '"week"', '--output', 'json'],
+        tempVaultDir
+      );
+      expect(invalidGranularity.exitCode).toBe(1);
+      expect(JSON.parse(invalidGranularity.stdout).error).toContain(
+        'Valid options: day, month, year'
+      );
+      expect(await readFile(schemaPath, 'utf-8')).toBe(before);
+    });
+
+    it('should leave calendar objects to the dedicated schema workflow', async () => {
+      const result = await runCLI(
+        ['config', 'edit', 'calendars', '--json', '{}', '--output', 'json'],
+        tempVaultDir
+      );
+
+      expect(result.exitCode).toBe(1);
+      expect(JSON.parse(result.stdout).error).toContain('Unknown config option: calendars');
+    });
+
     it('should reject unknown mention_exclude_types without writing', async () => {
       const before = await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8');
       const result = await runCLI(
@@ -284,6 +401,20 @@ describe('config command', () => {
     });
   });
 
+  describe('config option contract', () => {
+    it('classifies every schema config key as exposed or intentionally unexposed', () => {
+      const schemaKeys = Object.keys(ConfigSchema.shape).sort();
+      const classifiedKeys = [
+        ...CONFIG_OPTION_KEYS,
+        ...INTENTIONALLY_UNEXPOSED_CONFIG_KEYS,
+      ].sort();
+
+      expect(new Set(CONFIG_OPTION_KEYS).size).toBe(CONFIG_OPTION_KEYS.length);
+      expect(new Set(classifiedKeys).size).toBe(classifiedKeys.length);
+      expect(classifiedKeys).toEqual(schemaKeys);
+    });
+  });
+
   // ============================================================================
   // Config persistence
   // ============================================================================

END DIFF


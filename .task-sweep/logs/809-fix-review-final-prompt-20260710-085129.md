Review this final Bowerbird PR #816 fix diff after prior blockers were resolved.

Confirm only whether any correctness blocker remains in configured date parsing, strict format precedence, canonical ISO normalization, deterministic config->$TODAY->new->audit coverage, year 0001-0099 handling, or docs. No tools or mutations.

First line exactly BLOCKERS, NON-BLOCKING, or NO BLOCKERS. Entire response under 120 words.

BEGIN DIFF
diff --git a/docs-site/public/schema.json b/docs-site/public/schema.json
index 128d099..e307e3f 100644
--- a/docs-site/public/schema.json
+++ b/docs-site/public/schema.json
@@ -90,7 +90,7 @@
         },
         "date_format": {
           "type": "string",
-          "description": "Date format for date fields (YYYY, MM, DD tokens), e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY"
+          "description": "Generated full-date and parsing pattern (YYYY, MM, DD tokens); Gregorian date fields are stored canonically as ISO, e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY"
         },
         "date_granularity": {
           "type": "string",
diff --git a/docs-site/src/content/docs/reference/commands/config.md b/docs-site/src/content/docs/reference/commands/config.md
index 1feea54..9de2f59 100644
--- a/docs-site/src/content/docs/reference/commands/config.md
+++ b/docs-site/src/content/docs/reference/commands/config.md
@@ -29,7 +29,7 @@ bwrb config <subcommand>
 | `obsidian_vault` | Obsidian vault name for URI scheme | String |
 | `default_dashboard` | Dashboard used when no name is passed | Dashboard name or empty string |
 | `excluded_directories` | Directory prefixes excluded from discovery and targeting | JSON string array |
-| `date_format` | Format used when writing dates | Pattern string using `YYYY`, `MM`, and `DD` tokens |
+| `date_format` | Pattern for generated full dates and unambiguous parsing | String using `YYYY`, `MM`, and `DD` tokens |
 | `date_granularity` | Default coarsest precision for date fields | `day`, `month`, `year` |
 | `mention_exclude_types` | Types excluded as mention targets | JSON string array |
 | `mention_exclude_paths` | Path globs excluded as mention targets | JSON string array |
@@ -47,6 +47,15 @@ Through `config edit`, `date_format` requires each of `YYYY`, `MM`, and `DD`
 exactly once. Supported patterns include `YYYY-MM-DD`, `MM/DD/YYYY`,
 `DD/MM/YYYY`, and `DD-MM-YYYY`.
 
+Gregorian date fields are canonicalized to `YYYY-MM-DD` when written, while
+partial dates remain ISO (`YYYY-MM` or `YYYY`). The configured pattern lets
+Bowerbird parse matching generated or user-supplied full dates without guessing
+their month/day order. It also applies to generated date placeholders outside
+date frontmatter fields. Once `date_format` is explicitly set, non-ISO full-date
+input must match that pattern; canonical `YYYY-MM-DD` and permitted ISO partials
+remain accepted. Without an explicit setting, legacy unambiguous slash/dash
+input remains accepted.
+
 ## Configuration Location
 
 Configuration is stored in `.bwrb/schema.json` under the `config` key.
diff --git a/docs-site/src/content/docs/reference/schema.md b/docs-site/src/content/docs/reference/schema.md
index fb17ef1..e56d80e 100644
--- a/docs-site/src/content/docs/reference/schema.md
+++ b/docs-site/src/content/docs/reference/schema.md
@@ -802,7 +802,7 @@ Vault-wide settings:
 | `obsidian_vault` | string | auto | Obsidian vault name for URI scheme |
 | `default_dashboard` | string | — | Dashboard to run when `bwrb dashboard` has no name |
 | `excluded_directories` | array | `[]` | Vault-relative directory prefixes excluded from discovery and targeting |
-| `date_format` | string | `"YYYY-MM-DD"` | Display/parse format for date fields (`YYYY`, `MM`, `DD` tokens) |
+| `date_format` | string | `"YYYY-MM-DD"` | Generated full-date and parsing pattern (`YYYY`, `MM`, `DD` tokens); Gregorian date fields are stored canonically as ISO |
 | `date_granularity` | string | `"day"` | Default coarsest date precision for all date fields: `day`, `month`, or `year`. Per-field [`granularity`](#partial-dates-and-granularity) overrides it |
 | `calendars` | object | `{}` | Named custom-calendar definitions available to type `calendar_default` and field `calendar`; see [Custom Calendars](/concepts/custom-calendars/) |
 | `mention_fuzzy_threshold` | integer | `2` | Maximum fuzzy edit distance for `unlinked-mention` suggestions (`0` disables fuzzy matching; range `0`–`5`) |
diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index 6447026..31e94b9 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -96,7 +96,7 @@ bwrb supports vault-wide configuration in `.bwrb/schema.json` under the `config`
 | Option | Values | Default | Description |
 |--------|--------|---------|-------------|
 | `link_format` | `wikilink`, `markdown` | `wikilink` | Format for relation field links |
-| `date_format` | Pattern string | `YYYY-MM-DD` | Format for date fields |
+| `date_format` | Pattern string | `YYYY-MM-DD` | Pattern for generated full dates and unambiguous parsing |
 | `date_granularity` | `day`, `month`, `year` | `day` | Vault default for allowed partial-date precision |
 | `calendars` | Object | `{}` | Custom calendar registry for non-Gregorian date fields |
 | `open_with` | `system`, `editor`, `visual`, `obsidian` | `system` | Default --open behavior |
@@ -115,15 +115,21 @@ bwrb supports vault-wide configuration in `.bwrb/schema.json` under the `config`
 
 ### Date Format
 
-The `date_format` option controls how dates are written to frontmatter:
+The `date_format` option controls generated full-date values and disambiguates
+matching input:
 
 - `YYYY-MM-DD` - ISO 8601 (default, recommended)
 - `MM/DD/YYYY` - US format
 - `DD/MM/YYYY` - EU format
 - `DD-MM-YYYY` - EU format with dashes
 
-**Validation is format-agnostic**: bwrb accepts any unambiguous date format during audit/validation.
-Ambiguous dates like `01/02/2026` (where both parts are ≤12) are rejected.
+Gregorian date fields are canonicalized to `YYYY-MM-DD` when written; partial
+dates remain ISO (`YYYY-MM` or `YYYY`). A value that exactly matches the
+configured format can be parsed without guessing, so `01/02/2026` is January 2
+under `MM/DD/YYYY` and February 1 under `DD/MM/YYYY`. Without an explicit
+`date_format`, legacy unambiguous slash/dash input remains accepted. Once a
+format is explicitly configured, non-ISO full dates must match it; canonical
+`YYYY-MM-DD` and permitted ISO partials remain accepted.
 
 ### Custom Calendars
 
diff --git a/schema.schema.json b/schema.schema.json
index 3417e16..92b7726 100644
--- a/schema.schema.json
+++ b/schema.schema.json
@@ -90,7 +90,7 @@
         },
         "date_format": {
           "type": "string",
-          "description": "Date format for date fields (YYYY, MM, DD tokens), e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY"
+          "description": "Generated full-date and parsing pattern (YYYY, MM, DD tokens); Gregorian date fields are stored canonically as ISO, e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY"
         },
         "date_granularity": {
           "type": "string",
diff --git a/src/lib/local-date.ts b/src/lib/local-date.ts
index e516542..e74d936 100644
--- a/src/lib/local-date.ts
+++ b/src/lib/local-date.ts
@@ -152,6 +152,72 @@ export interface ParsedDate {
   error?: string;
 }
 
+/** Escape a literal fragment for use inside a regular expression. */
+function escapeRegExp(value: string): string {
+  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
+}
+
+/**
+ * Parse a full date using an explicit YYYY/MM/DD token pattern.
+ *
+ * Unlike {@link parseDate}, an explicit pattern can safely disambiguate values
+ * such as `10/07/2026`: `DD/MM/YYYY` means 10 July, while `MM/DD/YYYY` means
+ * October 7. Each token must occur exactly once. Literal separators and text
+ * are matched exactly, and component ranges are calendar-validated.
+ */
+export function parseDateWithPattern(value: string, format: string): ParsedDate {
+  const tokens = ['YYYY', 'MM', 'DD'] as const;
+  const hasValidTokens =
+    typeof format === 'string' &&
+    tokens.every((token) => format.split(token).length === 2);
+
+  if (!hasValidTokens) {
+    return {
+      valid: false,
+      error: 'Date format must contain YYYY, MM, and DD exactly once each',
+    };
+  }
+
+  const captureOrder: Array<(typeof tokens)[number]> = [];
+  let source = '^';
+  let cursor = 0;
+
+  for (const match of format.matchAll(/YYYY|MM|DD/g)) {
+    const token = match[0] as (typeof tokens)[number];
+    const index = match.index ?? cursor;
+    source += escapeRegExp(format.slice(cursor, index));
+    source += token === 'YYYY' ? '(\\d{4})' : '(\\d{2})';
+    captureOrder.push(token);
+    cursor = index + token.length;
+  }
+
+  source += `${escapeRegExp(format.slice(cursor))}$`;
+  const match = value.trim().match(new RegExp(source));
+  if (!match) {
+    return { valid: false, error: `Date does not match configured format ${format}` };
+  }
+
+  const parts: Partial<Record<(typeof tokens)[number], number>> = {};
+  captureOrder.forEach((token, index) => {
+    parts[token] = Number(match[index + 1]);
+  });
+
+  const year = parts.YYYY!;
+  const month = parts.MM!;
+  const day = parts.DD!;
+  const validationError = validateDateComponents(year, month, day);
+  if (validationError) {
+    return { valid: false, error: validationError };
+  }
+
+  const date = new Date(year, month - 1, day);
+  // JavaScript's multi-argument Date constructor remaps years 0-99 to
+  // 1900-1999. Restore the parsed year so the accepted 0001-0099 range does not
+  // silently change during canonicalization.
+  date.setFullYear(year);
+  return { valid: true, date };
+}
+
 /**
  * Parse a date string in a format-agnostic way.
  *
diff --git a/src/lib/validation.ts b/src/lib/validation.ts
index ecd31bd..de64846 100644
--- a/src/lib/validation.ts
+++ b/src/lib/validation.ts
@@ -14,6 +14,7 @@ import {
 import {
   expandStaticValue,
   parseDate,
+  parseDateWithPattern,
   parsePartialIsoDate,
   isPrecisionAllowed,
   type DatePrecision,
@@ -43,11 +44,14 @@ function describeGranularityRequirement(granularity: DatePrecision): string {
  * Full dates accept ISO, ISO datetime, and unambiguous US/EU formats and are
  * stored as YYYY-MM-DD. Partial dates (YYYY, YYYY-MM) are accepted only when the
  * field's `granularity` permits them, and are stored verbatim (ISO partials sort
- * lexically). `granularity` defaults to 'day' (full date required).
+ * lexically). An explicitly configured date pattern disambiguates matching full
+ * dates before canonicalization and takes precedence over format guessing.
+ * `granularity` defaults to 'day' (full date required).
  */
 function normalizeToIsoDate(
   value: string,
-  granularity: DatePrecision = 'day'
+  granularity: DatePrecision = 'day',
+  dateFormat?: string
 ): NormalizedDateResult {
   const trimmed = value.trim();
 
@@ -84,6 +88,21 @@ function normalizeToIsoDate(
       : { valid: false, error: parsed.error ?? 'Invalid date' };
   }
 
+  // The configured format disambiguates generated/user-entered values such as
+  // 10/07/2026 before the format-agnostic parser deliberately rejects them.
+  // Storage remains canonical ISO after parsing.
+  if (dateFormat !== undefined) {
+    const configured = parseDateWithPattern(trimmed, dateFormat);
+    if (!configured.valid) {
+      return { valid: false, error: configured.error ?? `Date does not match ${dateFormat}` };
+    }
+
+    const year = configured.date!.getFullYear();
+    const month = String(configured.date!.getMonth() + 1).padStart(2, '0');
+    const day = String(configured.date!.getDate()).padStart(2, '0');
+    return { valid: true, value: `${year}-${month}-${day}` };
+  }
+
   // Format-agnostic date validation
   // Accepts ISO (YYYY-MM-DD), US (MM/DD/YYYY), EU (DD/MM/YYYY) formats
   // Rejects ambiguous dates where month and day are both <= 12 for non-ISO formats
@@ -116,6 +135,7 @@ function formatUtcDate(date: Date): string {
  * For each field whose schema `prompt` is `date`, the value is normalized via
  * {@link normalizeToIsoDate} using the field's resolved granularity:
  * - Unambiguous slash-format dates (e.g. `12/25/2026`) become `2026-12-25`.
+ * - Dates matching `config.date_format` are parsed without month/day guessing.
  * - ISO datetimes are truncated to their date part.
  * - Valid partial dates (`2026`, `2026-05`) are preserved verbatim when the
  *   field's granularity permits them.
@@ -161,12 +181,16 @@ export function normalizeDateFields(
     // in `validateFieldType` (#707).
     if (field.multiple && Array.isArray(value)) {
       normalized[fieldName] = value.map((element) =>
-        normalizeDateValue(element, granularity)
+        normalizeDateValue(element, granularity, schema.raw.config?.date_format)
       );
       continue;
     }
 
-    normalized[fieldName] = normalizeDateValue(value, granularity);
+    normalized[fieldName] = normalizeDateValue(
+      value,
+      granularity,
+      schema.raw.config?.date_format
+    );
   }
 
   return normalized;
@@ -181,7 +205,11 @@ export function normalizeDateFields(
  * (formatted from UTC), a non-coercible non-string, or fails normalization — in
  * the last case the validation layer surfaces a clear error.
  */
-function normalizeDateValue(value: unknown, granularity: DatePrecision): unknown {
+function normalizeDateValue(
+  value: unknown,
+  granularity: DatePrecision,
+  dateFormat?: string
+): unknown {
   // A blank value (null/undefined/empty/whitespace-only) is "unset"; leave it
   // untouched so it isn't normalized into a bogus date (#707).
   if (isBlankScalar(value)) return value;
@@ -197,7 +225,7 @@ function normalizeDateValue(value: unknown, granularity: DatePrecision): unknown
   const dateValue = typeof value === 'number' ? String(value) : value;
   if (typeof dateValue !== 'string') return value;
 
-  const result = normalizeToIsoDate(dateValue, granularity);
+  const result = normalizeToIsoDate(dateValue, granularity, dateFormat);
   return result.valid ? result.value : value;
 }
 
@@ -374,7 +402,10 @@ export function validateFrontmatter(
         value,
         field,
         granularity,
-        calendarId ? { id: calendarId, calendar: schema.config.calendars[calendarId]! } : undefined
+        calendarId
+          ? { id: calendarId, calendar: schema.config.calendars[calendarId]! }
+          : undefined,
+        schema.raw.config?.date_format
       );
       if (typeError) {
         errors.push(typeError);
@@ -476,7 +507,8 @@ function validateDateValue(
   value: unknown,
   granularity: DatePrecision,
   calendarContext?: { id: string; calendar: Calendar },
-  listIndex?: number
+  listIndex?: number,
+  dateFormat?: string
 ): ValidationError | null {
   // Accept Date objects surfaced by YAML parsing for Gregorian dates, normalize elsewhere.
   if (value instanceof Date && !calendarContext) {
@@ -513,7 +545,7 @@ function validateDateValue(
     return null;
   }
 
-  const normalized = normalizeToIsoDate(dateValue, granularity);
+  const normalized = normalizeToIsoDate(dateValue, granularity, dateFormat);
   if (!normalized.valid) {
     return {
       type: 'invalid_date',
@@ -532,7 +564,8 @@ function validateFieldType(
   value: unknown,
   field: Field,
   granularity: DatePrecision = 'day',
-  calendarContext?: { id: string; calendar: Calendar }
+  calendarContext?: { id: string; calendar: Calendar },
+  dateFormat?: string
 ): ValidationError | null {
   // Alias-role fields: enforce Obsidian `aliases` format regardless of prompt
   // type — an array of non-empty, unique strings.
@@ -566,13 +599,20 @@ function validateFieldType(
         // reported separately. Shared `isBlankScalar` rule keeps this in step
         // with the scalar paths (#707).
         if (isBlankScalar(element)) continue;
-        const elementError = validateDateValue(fieldName, element, granularity, calendarContext, index);
+        const elementError = validateDateValue(
+          fieldName,
+          element,
+          granularity,
+          calendarContext,
+          index,
+          dateFormat
+        );
         if (elementError) return elementError;
       }
       return null;
     }
 
-    return validateDateValue(fieldName, value, granularity, calendarContext);
+    return validateDateValue(fieldName, value, granularity, calendarContext, undefined, dateFormat);
   }
 
   if (field.prompt === 'relative-date') {
diff --git a/src/types/schema.ts b/src/types/schema.ts
index a6c21a6..52a9fea 100644
--- a/src/types/schema.ts
+++ b/src/types/schema.ts
@@ -496,7 +496,7 @@ export const ConfigSchema = z.object({
     .string()
     .optional()
     .describe(
-      'Date format for date fields (YYYY, MM, DD tokens), e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY'
+      'Generated full-date and parsing pattern (YYYY, MM, DD tokens); Gregorian date fields are stored canonically as ISO, e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY'
     ),
   // Default coarsest date precision allowed for all `date` fields.
   // - day (default): full YYYY-MM-DD only
diff --git a/tests/ts/commands/config.test.ts b/tests/ts/commands/config.test.ts
index 4686982..65ff700 100644
--- a/tests/ts/commands/config.test.ts
+++ b/tests/ts/commands/config.test.ts
@@ -277,6 +277,79 @@ describe('config command', () => {
       expect(schema.config.date_granularity).toBe('month');
     });
 
+    it('should round-trip configured $TODAY defaults through new and audit', async () => {
+      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
+      await writeFile(
+        schemaPath,
+        JSON.stringify({
+          version: 2,
+          types: {
+            release: {
+              output_dir: 'Releases',
+              fields: {
+                type: { value: 'release' },
+                today: { value: '$TODAY', prompt: 'date' },
+                shipped: { prompt: 'date' },
+              },
+              field_order: ['type', 'today', 'shipped'],
+            },
+          },
+        })
+      );
+
+      expect(
+        (
+          await runCLI(
+            // Dots make this deterministic on every day of the month: the
+            // format-agnostic parser does not accept DD.MM.YYYY, so only the
+            // configured-pattern path can make the generated value round-trip.
+            ['config', 'edit', 'date_format', '--json', '"DD.MM.YYYY"'],
+            tempVaultDir
+          )
+        ).exitCode
+      ).toBe(0);
+      expect(
+        (
+          await runCLI(
+            ['config', 'edit', 'date_granularity', '--json', '"month"'],
+            tempVaultDir
+          )
+        ).exitCode
+      ).toBe(0);
+
+      const beforeCreate = new Date();
+      const create = await runCLI(
+        [
+          'new',
+          'release',
+          '--json',
+          '{"name":"Configured dates","shipped":"2026-05"}',
+          '--no-template',
+        ],
+        tempVaultDir
+      );
+      const afterCreate = new Date();
+      expect(create.exitCode).toBe(0);
+      const created = JSON.parse(create.stdout);
+      const content = await readFile(join(tempVaultDir, created.path), 'utf-8');
+      const storedToday = content.match(/^today: (\d{4}-\d{2}-\d{2})$/m)?.[1];
+      const expectedToday = (date: Date) =>
+        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
+          date.getDate()
+        ).padStart(2, '0')}`;
+      expect(new Set([expectedToday(beforeCreate), expectedToday(afterCreate)])).toContain(
+        storedToday
+      );
+      expect(content).toContain('shipped: 2026-05');
+
+      const audit = await runCLI(
+        ['audit', '--path', created.path, '--output', 'json'],
+        tempVaultDir
+      );
+      expect(audit.exitCode).toBe(0);
+      expect(JSON.parse(audit.stdout).summary.totalErrors).toBe(0);
+    });
+
     it('should reject invalid date settings without writing', async () => {
       const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
       const before = await readFile(schemaPath, 'utf-8');
diff --git a/tests/ts/lib/local-date.test.ts b/tests/ts/lib/local-date.test.ts
index 9b48fde..27d5dc3 100644
--- a/tests/ts/lib/local-date.test.ts
+++ b/tests/ts/lib/local-date.test.ts
@@ -5,6 +5,7 @@ import {
   expandStaticValue,
   formatDateWithPattern,
   parseDate,
+  parseDateWithPattern,
   isValidDate,
   parsePartialIsoDate,
   isPrecisionAllowed,
@@ -318,6 +319,44 @@ describe('local-date', () => {
     });
   });
 
+  describe('parseDateWithPattern', () => {
+    it('uses an explicit token order to resolve ambiguous dates', () => {
+      const eu = parseDateWithPattern('10/07/2026', 'DD/MM/YYYY');
+      const us = parseDateWithPattern('10/07/2026', 'MM/DD/YYYY');
+
+      expect(eu.valid).toBe(true);
+      expect(eu.date).toEqual(new Date(2026, 6, 10));
+      expect(us.valid).toBe(true);
+      expect(us.date).toEqual(new Date(2026, 9, 7));
+    });
+
+    it('supports escaped literal separators and text', () => {
+      const result = parseDateWithPattern('2026.(07)+10', 'YYYY.(MM)+DD');
+
+      expect(result.valid).toBe(true);
+      expect(result.date).toEqual(new Date(2026, 6, 10));
+    });
+
+    it('calendar-validates components', () => {
+      expect(parseDateWithPattern('29/02/2024', 'DD/MM/YYYY').valid).toBe(true);
+      expect(parseDateWithPattern('29/02/2025', 'DD/MM/YYYY').valid).toBe(false);
+      expect(parseDateWithPattern('31/13/2026', 'DD/MM/YYYY').valid).toBe(false);
+    });
+
+    it('preserves years below 100 instead of applying the Date constructor offset', () => {
+      const result = parseDateWithPattern('10/07/0099', 'DD/MM/YYYY');
+
+      expect(result.valid).toBe(true);
+      expect(result.date?.getFullYear()).toBe(99);
+    });
+
+    it('rejects mismatches and malformed token patterns', () => {
+      expect(parseDateWithPattern('2026-07-10', 'DD/MM/YYYY').valid).toBe(false);
+      expect(parseDateWithPattern('10/07/2026', 'YYYY-MM').valid).toBe(false);
+      expect(parseDateWithPattern('10/07/2026', 'DD/MM/YYYY/YYYY').valid).toBe(false);
+    });
+  });
+
   describe('DEFAULT_DATE_FORMAT', () => {
     it('should be ISO format', () => {
       expect(DEFAULT_DATE_FORMAT).toBe('YYYY-MM-DD');
diff --git a/tests/ts/lib/validation.test.ts b/tests/ts/lib/validation.test.ts
index 2871cea..af806b2 100644
--- a/tests/ts/lib/validation.test.ts
+++ b/tests/ts/lib/validation.test.ts
@@ -7,6 +7,7 @@ import {
   validateContextFields,
   applyDefaults,
   validateSelectOptionValue,
+  normalizeDateFields,
   suggestOptionValue,
   suggestFieldName,
   formatValidationErrors,
@@ -393,11 +394,15 @@ describe('validation', () => {
     function buildSchema(opts: {
       fieldGranularity?: 'day' | 'month' | 'year';
       configGranularity?: 'day' | 'month' | 'year';
+      dateFormat?: string;
     }) {
       return resolveSchema({
         version: 1,
-        ...(opts.configGranularity && {
-          config: { date_granularity: opts.configGranularity },
+        ...((opts.configGranularity || opts.dateFormat) && {
+          config: {
+            ...(opts.configGranularity && { date_granularity: opts.configGranularity }),
+            ...(opts.dateFormat && { date_format: opts.dateFormat }),
+          },
         }),
         types: {
           note: {
@@ -432,6 +437,39 @@ describe('validation', () => {
       expect(validateFrontmatter(s, 'note', { type: 'note', when: '2026' }).valid).toBe(false);
     });
 
+    it('uses the configured format to validate and canonicalize ambiguous full dates', () => {
+      const s = buildSchema({ dateFormat: 'DD/MM/YYYY' });
+      const frontmatter = { type: 'note', when: '10/07/2026' };
+
+      expect(validateFrontmatter(s, 'note', frontmatter).valid).toBe(true);
+      expect(normalizeDateFields(s, 'note', frontmatter).when).toBe('2026-07-10');
+    });
+
+    it('does not let a configured format mask invalid calendar components', () => {
+      const s = buildSchema({ dateFormat: 'DD/MM/YYYY' });
+
+      expect(validateFrontmatter(s, 'note', { type: 'note', when: '29/02/2025' }).valid).toBe(
+        false
+      );
+    });
+
+    it('gives an explicit format precedence while retaining canonical ISO and partials', () => {
+      const s = buildSchema({ dateFormat: 'MM/DD/YYYY', configGranularity: 'month' });
+
+      expect(validateFrontmatter(s, 'note', { type: 'note', when: '12/25/2026' }).valid).toBe(
+        true
+      );
+      expect(validateFrontmatter(s, 'note', { type: 'note', when: '25/12/2026' }).valid).toBe(
+        false
+      );
+      expect(validateFrontmatter(s, 'note', { type: 'note', when: '2026-12-25' }).valid).toBe(
+        true
+      );
+      expect(validateFrontmatter(s, 'note', { type: 'note', when: '2026-12' }).valid).toBe(
+        true
+      );
+    });
+
     it('per-field granularity overrides the global default', () => {
       // Global says month, but the field tightens to day.
       const s = buildSchema({ fieldGranularity: 'day', configGranularity: 'month' });

END DIFF


# Final documentation parity review

You are the final independent reviewer for a documentation-only Bowerbird pull request.

Review the supplied diff against this objective: maintained user-facing and agent-facing documentation must accurately describe the shipped CLI from v0.2.0 through current main (v0.2.3 at the reviewed base), while changelogs remain historically accurate and unmerged behavior remains excluded.

Pay special attention to:
- runnable command spelling, flags, output shapes, and examples;
- current flat schema syntax and inheritance semantics;
- list/search/open consolidation;
- relative dates and custom calendars;
- native forks, lineage inspection, and fork-safe deletion;
- system frontmatter, audit, completion, and config contracts;
- release/PR attribution and counts;
- contradictions among README, docs-site, docs/**, docs/skill/SKILL.md, generated schema descriptions, help, and completion;
- accidental product changes outside documentation/generated-contract prose.

Known product gaps are intentionally documented, not fixed here: issues #809 through #813 cover config date-setting exposure, completion drift, output_dir creation parity, --body whole-file matching, and interactive-vs-JSON name persistence.

The full local gate set and a fresh disposable-vault tester matrix pass. Review what remains in the diff, not the ambition of the task.

Your first line MUST be exactly one of:
NO BLOCKERS
BLOCKERS
NON-BLOCKING

If there are blockers, give each a file/location, concrete contradiction, and required correction. Separate genuinely blocking accuracy problems from optional editorial suggestions. Do not treat the intentionally disclosed product gaps as documentation blockers unless the diff misstates them.

## Diff

diff --git a/CHANGELOG.md b/CHANGELOG.md
index f00ef0d..058c59c 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -6,12 +6,15 @@ All notable changes to Bowerbird are documented in this file.

 ## [0.2.3] - 2026-07-09

-Patch release for document forking, lineage inspection, and fork-safe deletion.
+Patch release for relative dates and custom calendars, canonical list/search/open
+consolidation, JSON-mode exit reliability, and the complete native document
+forking/lineage/fork-safe-deletion stack.

 ### Added

 - **Relative-date fields** — schema-defined `relative-date` values position notes before, after, or equal to other notes, with query-time resolution and audit warnings for invalid chains (#789).
 - **Custom calendars** — vault schemas can define fictional or alternative calendars for native date validation, sorting, comparisons, JSON output, audit, and relative-date anchors (#792).
+- **Lineage foundation** — reserved immutable `forked-from` provenance, per-field `reset_on_fork`, and audit contracts for malformed IDs, dangling provenance, duplicate identities, and lineage cycles establish the shared safety model used by native forks (#802).
 - **Document forks** — `bwrb new --fork <target>` creates a sibling document with a fresh stable ID and immutable `forked-from` provenance while preserving the source body and prior work.
 - **Fork lineage inspection** — `bwrb list --lineage <target>` renders the complete connected fork component—including sibling and cousin branches—in tree, paths, link, content, or JSON form, resolving targets by exact path, name, alias, or case-insensitive UUID.
 - **Fork-safe deletion** — `bwrb delete` refuses notes with direct fork children or duplicate identities unless `--force` is supplied; forced deletion leaves child `forked-from` provenance intact for audit.
@@ -61,7 +64,7 @@ Patch release for the post-0.2.0 bugfix sweep.

 ## [0.2.0] - 2026-06-26

-Changes since `v0.1.9` — a large release (78 PRs). Headlines: schema **traits**, **hierarchical scope** (contexts as notes + `under()`), **fuzzy search**, the new **`recent`** command, **partial dates**, and a deep audit / migration / ownership hardening wave.
+Changes since `v0.1.9` — a large release (80 non-release PRs). Headlines: schema **traits**, **hierarchical scope** (contexts as notes + `under()`), **fuzzy search**, the new **`recent`** command, **partial dates**, and a deep audit / migration / ownership hardening wave.

 ### Added

@@ -88,6 +91,8 @@ Changes since `v0.1.9` — a large release (78 PRs). Headlines: schema **traits*
 - **`schema.schema.json` reconciled** with the Zod / loader contract (#626, #665).
 - **Sharper unknown-type help** — "did you mean a type?" suggestions extended to template commands and case-only mismatches (#669, #721).
 - **Multi-select template defaults** — multi-select fields now receive multi-value defaults (#668, #714).
+- **Multi-relation template defaults** — `template new` captures valid
+  multi-value relation defaults when generating a template (#745).

 ### Fixed

@@ -98,6 +103,11 @@ Changes since `v0.1.9` — a large release (78 PRs). Headlines: schema **traits*
 - **Edit** — nested body sections recurse so `add-sections` agrees with audit (#653, #697, #716).
 - **Open** — positional app mode so `open <name> print` works (#662, #710).
 - **Bulk** — affected files de-duplicated by filesystem identity (#720, #736).
+- **Optional scalar whitespace parity** — whitespace-only values in optional
+  scalar fields are handled consistently by write validation and audit (#741).
+- **Positional app-mode parity** — trailing `[mode]` works consistently on
+  `list`, `recent`, `search`, and `edit`, matching the existing `open` pattern
+  (#744).

 ### Performance

@@ -860,7 +870,11 @@ Changes since `v0.1.4`.

 - **Stop exporting unused note-id helpers (Knip)** (#359)

-## [0.2.0] - 2025-12-29
+## [0.2.0 legacy untagged/pre-publish] - 2025-12-29
+
+Legacy pre-publish milestone that used the `0.2.0` label before the tagged 2026
+release series. It is retained for historical context and is not the
+`v0.2.0` tag documented above.

 Complete rewrite from shell scripts to TypeScript with significant new features.

diff --git a/README.md b/README.md
index 0dd48b4..d0029ae 100644
--- a/README.md
+++ b/README.md
@@ -14,14 +14,19 @@ Schema-driven note management for markdown vaults.

 ## Overview

-`bwrb` is a CLI tool that creates and edits markdown files based on a hierarchical type schema. It supports:
-
-- Interactive type selection with subtype navigation
-- Dynamic frontmatter prompts (select options, text input, vault queries)
-- Configurable body sections with various content types
-- Edit mode for updating existing files
-- List and filter notes by type and frontmatter fields
-- Works with any vault via the `--vault` flag
+`bwrb` creates, queries, migrates, and audits markdown notes against a version 2
+type schema. It supports:
+
+- Flat types with inheritance, reusable traits, ownership, and templates
+- Dynamic frontmatter prompts, body sections, and instance scaffolding
+- Canonical `list` discovery by filters, exact name, fuzzy name, body matches,
+  stable ID, or document lineage
+- Schema migrations plus conservative audit and repair workflows
+- Partial and relative dates, including schema-defined custom calendars
+- Native document forks with immutable provenance, lineage inspection, and
+  fork-safe deletion
+- Command-specific JSON automation and explicit non-interactive safety
+- Any markdown vault selected through discovery or the global `--vault` flag

 ## Prerequisites

@@ -46,7 +51,17 @@ pnpm dev -- new idea  # Run without building

 ## Setup

-Create a `.bwrb/schema.json` in each vault you want to use with bwrb.
+Initialize each vault you want to use with bwrb:
+
+```sh
+mkdir my-vault
+cd my-vault
+bwrb init --yes
+```
+
+This creates a version 2 `.bwrb/schema.json`. See the
+[Quick Start](https://bwrb.dev/getting-started/quick-start/) for a runnable first
+schema.

 ## Usage

@@ -66,7 +81,7 @@ bwrb --vault=/path/to/vault new

 # Direct creation - specify type
 bwrb new objective    # Then select subtype (task/milestone/project/goal)
-bwrb new idea         # Creates idea directly (no subtypes)
+bwrb new idea         # Creates idea directly (no child-type selection)

 # Templates
 bwrb new task --template bug-report  # Use specific template
@@ -92,10 +107,14 @@ bwrb list --output paths --fields=status objective  # Combine paths + fields
 bwrb list --name "My Note"                   # Resolve by name, path, or alias
 bwrb list --name "My Note" --output link     # Output: [[My Note]]
 bwrb list --fuzzy "My Nte" --output json      # Ranked matches with scores
-bwrb list --body "TODO" --matches             # Detailed body matches
+bwrb list --body "TODO" --matches             # Detailed file matches (frontmatter included today)
 bwrb list --name "My Note" --open --app editor
 bwrb list --id "<uuid>" --open --app print

+# Preserve a revision as a native document fork, then inspect its family
+bwrb new --fork "Briefs/Launch Brief" --label concise --output json
+bwrb list --lineage "Briefs/Launch Brief" --output tree
+
 # Help
 bwrb --help
 bwrb list --help
@@ -107,20 +126,36 @@ The schema file is expected at `<vault>/.bwrb/schema.json`. It defines:

 ### Types

-Hierarchical type definitions. Types can have subtypes for nested categorization:
+Version 2 schemas keep all types in one flat map. A child names its parent with
+`extends`:

 ```json
 {
+  "version": 2,
   "types": {
     "objective": {
-      "subtypes": {
-        "task": { /* type definition */ },
-        "milestone": { /* type definition */ }
+      "output_dir": "Objectives",
+      "fields": {
+        "type": { "value": "objective" },
+        "status": {
+          "prompt": "select",
+          "options": ["planned", "active", "done"],
+          "default": "planned"
+        }
       }
     },
-    "idea": {
-      "output_dir": "Objectives/Ideas",
-      "frontmatter": { /* ... */ }
+    "task": {
+      "extends": "objective",
+      "output_dir": "Objectives/Tasks",
+      "fields": {
+        "type": { "value": "task" },
+        "priority": {
+          "prompt": "select",
+          "options": ["low", "medium", "high"],
+          "default": "medium"
+        }
+      },
+      "field_order": ["type", "status", "priority"]
     }
   }
 }
@@ -128,13 +163,14 @@ Hierarchical type definitions. Types can have subtypes for nested categorization

 ### Type Definition

-Each leaf type requires:
+Type properties include:

 | Field | Required | Description |
 |-------|----------|-------------|
-| `output_dir` | Yes | Directory relative to vault root |
-| `frontmatter` | Yes | Field definitions |
-| `frontmatter_order` | No | Array specifying field order |
+| `extends` | No | Parent type name; defaults to the implicit `meta` root |
+| `output_dir` | Yes for `new` | Directory relative to vault root. Schema inspection can report a computed fallback, but current note creation still requires an explicit value ([#811](https://github.com/3mdistal/bwrb/issues/811)) |
+| `fields` | No | Field definitions, merged with inherited fields |
+| `field_order` | No | Array specifying effective field order |
 | `body_sections` | No | Array of section definitions |

 ### Frontmatter Fields
@@ -181,16 +217,16 @@ Query notes of a specific type to populate field options:
 {
   "milestone": {
     "prompt": "relation",
-    "source": "objective/milestone",
-    "filter": "status != 'settled' && status != 'ghosted'",
-    "format": "quoted-wikilink"
+    "source": "milestone",
+    "filter": { "status": { "not_in": ["settled", "ghosted"] } },
+    "required": false
   }
 }
 ```

-- `source` - Type path to query (e.g., `"objective/milestone"`)
-- `filter` - Optional expression to filter results
-- `format` - Output format: `plain`, `wikilink` (`[[value]]`), `quoted-wikilink` (`"[[value]]"`)
+- `source` - Type name to query (e.g., `"milestone"`)
+- `filter` - Optional per-field condition object for filtering candidates
+- Relation link formatting is vault-wide through `config.link_format`

 ### Body Sections

@@ -487,7 +523,7 @@ selected result.
 bwrb list --name "My Note"                             # Case-insensitive resolution
 bwrb list --name "Ideas/My Note.md" --output link      # [[My Note]]
 bwrb list --fuzzy "My Nte" --output json               # Ranked candidates
-bwrb list --body "TODO" --matches --context 0          # Detailed matches
+bwrb list --body "TODO" --matches --context 0          # Detailed file matches
 bwrb list --name "My Note" --open --app editor         # Open in editor
 bwrb list --id "<uuid>" --open --app print             # Stable-id path lookup
 ```
@@ -566,7 +602,10 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish

 ### What Gets Completed

-- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `open`, etc.
+- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `recent`, `audit`,
+  `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, and `config`.
+  `init` appears in `bwrb --help` but is currently missing from generated root
+  completion candidates ([#810](https://github.com/3mdistal/bwrb/issues/810)).
 - **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
 - **Types**: `bwrb list --type <TAB>` shows types from your schema (task, idea, etc.)
 - **Paths**: `bwrb list --path <TAB>` shows vault directories (Ideas/, Objectives/, etc.)
diff --git a/docs-site/astro.config.mjs b/docs-site/astro.config.mjs
index af4be10..8c8b540 100644
--- a/docs-site/astro.config.mjs
+++ b/docs-site/astro.config.mjs
@@ -66,7 +66,7 @@ export default defineConfig({
							label: 'Commands',
							collapsed: true,
							// Keep in sync with runtime `bwrb --help` command ordering.
-							// `init` and `help` are intentionally omitted until docs pages exist.
+							// Commander-provided `help` has no dedicated reference page.
							items: [
								{ slug: 'reference/commands/new' },
								{ slug: 'reference/commands/edit' },
@@ -78,6 +78,7 @@ export default defineConfig({
								{ slug: 'reference/commands/bulk' },
								{ slug: 'reference/commands/template' },
								{ slug: 'reference/commands/dashboard' },
+								{ slug: 'reference/commands/init' },
								{ slug: 'reference/commands/config' },
								{ slug: 'reference/commands/completion' },
							],
diff --git a/docs-site/public/schema.json b/docs-site/public/schema.json
index 56ed914..128d099 100644
--- a/docs-site/public/schema.json
+++ b/docs-site/public/schema.json
@@ -417,7 +417,7 @@
               }
             }
           ],
-          "description": "Type name(s) for relation and relative-date prompts. When a relation's value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the search command docs for the shortest-unambiguous-form rule."
+          "description": "Type name(s) for relation and relative-date prompts. When a relation's value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the canonical list resolution docs for the shortest-unambiguous-form rule."
         },
         "filter": {
           "type": "object",
diff --git a/docs-site/src/content/docs/automation/ai-integration.md b/docs-site/src/content/docs/automation/ai-integration.md
index ae0eba8..1ea9033 100644
--- a/docs-site/src/content/docs/automation/ai-integration.md
+++ b/docs-site/src/content/docs/automation/ai-integration.md
@@ -7,7 +7,9 @@ Bowerbird is designed to work seamlessly with AI coding assistants.

 ## JSON Mode

-Every command supports `--output json` and `--json` input, making Bowerbird fully scriptable by AI:
+Machine-readable support is command-specific: use `--output json` and `--json`
+only where that command's help lists them. The canonical discovery workflow and
+the main note mutation workflows are scriptable:

 ```bash
 # AI reads vault state
diff --git a/docs-site/src/content/docs/automation/json-mode.md b/docs-site/src/content/docs/automation/json-mode.md
index 3c84d9c..b80bb6c 100644
--- a/docs-site/src/content/docs/automation/json-mode.md
+++ b/docs-site/src/content/docs/automation/json-mode.md
@@ -1,80 +1,95 @@
 ---
 title: JSON Mode
-description: Scripting and automation with JSON input/output
+description: Scripting and automation with command-specific JSON input and output
 ---

-Every Bowerbird command supports JSON mode for scripting and AI integration.
+Bowerbird's machine-readable options are command-specific. Use `--output json`
+only where that command's `--help` lists it, and use `--json` input only on
+commands that explicitly accept a JSON payload. They are not universal global
+flags.

-For commands that normally prompt or open pickers, pair JSON mode with the global `--non-interactive` flag when you want a hard guarantee that the CLI will never drop into interactive UI:
+For commands that can prompt or open a picker, add the global
+`--non-interactive` flag when you need a hard no-prompt guarantee:

 ```bash
 bwrb --non-interactive new task --json '{"name":"Fix login","priority":"high"}'
 bwrb --non-interactive edit "My Task" --json '{"status":"settled"}'
 ```

-## JSON Output
+## JSON output shapes

-Add `--output json` to any command:
+Check the command reference before choosing a parser. Bowerbird emits one
+complete JSON value, but success shapes differ by workflow:

-```bash
-bwrb list task --output json
-bwrb audit --output json
-bwrb list --name "My Note" --output json --picker none
-```
-
-## JSON Input
+| Workflow | Success shape |
+| --- | --- |
+| `list [filters] --output json` | Raw array of note objects with `_path`, `_name`, and frontmatter |
+| `list --count --output json` | Raw `{ "count": number }` object |
+| `list --name ... --output json` | `{ "success": true, "data": [...] }` |
+| `list --fuzzy ... --output json` | `{ "success": true, "data": [...] }`, including scores and match metadata |
+| `list --body ... --matches --output json` | Match report with `success`, `data`, `totalMatches`, and `truncated` |
+| `list --lineage ... --output json` | Raw `{ "target", "nodes", "warnings" }` object |
+| `new --fork ... --output json` | `{ "success": true, "path", "id", "forked_from", "warnings" }` |

-Provide field values without interactive prompts:
+Normal list output is intentionally a raw array:

 ```bash
-bwrb new task --json '{"name": "Fix login", "priority": "high"}'
-bwrb edit "My Task" --json '{"status": "settled"}'
-bwrb bulk --type task --set status=archived
+bwrb list task --output json | jq -r '.[] | ._path'
 ```

-`bwrb new --json` reports filename safety metadata when relevant: `nameTransformed` appears when the requested name is normalized for the filesystem, and `pathLengthWarning` appears for relative paths longer than 200 characters. Paths longer than 260 characters are rejected.
-
-## Scripting Examples
-
-### Create Note from Script
+Name and fuzzy resolution use a success envelope:

 ```bash
-#!/bin/bash
-bwrb new task --json "{
-  \"name\": \"$TASK_NAME\",
-  \"priority\": \"$PRIORITY\"
-}"
+bwrb list --name "My Note" --output json --picker none | jq -r '.data[0].path'
+bwrb list --fuzzy "My Nte" --output json | jq '.data[] | {path, score}'
 ```

-### Process Audit Results
+Lineage output is a raw graph object, not a `data` envelope:

 ```bash
-bwrb audit --output json | jq '.files[] | .path'
+bwrb list --lineage "Briefs/Launch Brief" --output json | jq '.nodes[]'
 ```

-Audit JSON is report-only. It never performs fixes or deletes. For delete-eligible findings, the issue payload can include recommendation metadata under `meta.recommendation` (for example `{"action":"delete-note","interactiveOnly":true}`).
+## JSON input

-### Batch Operations
+`new` and `edit` accept frontmatter payloads directly:

 ```bash
-bwrb list task --output json | \
-  jq -r '.[] | select(.status == "settled") | ._path' | \
-  xargs -I {} bwrb delete {} --force
+bwrb new task --json '{"name":"Fix login","priority":"high"}'
+bwrb edit "My Task" --json '{"status":"settled"}'
 ```

-## AI Integration
+Other management commands accept JSON only where their help documents it, such
+as `config edit <key> --json <value>` and selected template/dashboard workflows.
+Run `bwrb <command> --help`; do not infer `--json` support from another command.

-JSON mode makes Bowerbird scriptable by AI assistants:
+`bwrb new --json` reports filename safety metadata when relevant:
+`nameTransformed` appears when a requested name is normalized, and
+`pathLengthWarning` appears for relative paths longer than 200 characters.
+Paths longer than 260 characters are rejected.

-```bash
-# AI can read vault state
-bwrb list --output json
+## Errors and exits
+
+Machine-readable failures normally use a structured error object such as:

-# AI can create notes
-bwrb new idea --json '{"name": "AI suggestion", "status": "raw"}'
+```json
+{
+  "success": false,
+  "error": "No matches for query",
+  "code": 1
+}
 ```

+The process exit code remains authoritative. Consumers should tolerate added
+fields and should not assume that every successful command uses the same
+envelope merely because errors share a common shape.
+
+Audit JSON is report-only: it never applies fixes or deletes. For
+delete-eligible findings, issue metadata may include a recommendation under
+`meta.recommendation`.
+
 ## See Also

-- [Shell completion](/automation/shell-completion/)
 - [AI integration](/automation/ai-integration/)
+- [bwrb list](/reference/commands/list/)
+- [Targeting Model](/reference/targeting/)
diff --git a/docs-site/src/content/docs/automation/shell-completion.md b/docs-site/src/content/docs/automation/shell-completion.md
index a51a6b5..f4672be 100644
--- a/docs-site/src/content/docs/automation/shell-completion.md
+++ b/docs-site/src/content/docs/automation/shell-completion.md
@@ -35,7 +35,7 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish

 | Context | Completion |
 |---------|------------|
-| `bwrb <TAB>` | Commands: `new`, `edit`, `delete`, `list`, `open`, `search`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `config`, `completion` |
+| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, `config` |
 | `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`... |
 | `bwrb new <TAB>` | Types from schema: `task`, `idea`... |
 | `bwrb list --path <TAB>` | Directories: `Ideas/`, `Projects/`... |
@@ -48,6 +48,11 @@ Completions are context-aware:
 - Paths come from your vault's directory structure
 - No hard-coded values

+`bwrb --help` also shows `init`, but generated root completion currently omits
+it ([#810](https://github.com/3mdistal/bwrb/issues/810)). The hidden
+compatibility commands `open` and `search` remain callable but are intentionally
+not taught as canonical root candidates.
+
 ## See Also

 - [bwrb completion command](/reference/commands/completion/)
diff --git a/docs-site/src/content/docs/changelog.md b/docs-site/src/content/docs/changelog.md
index b2b8234..585cdd5 100644
--- a/docs-site/src/content/docs/changelog.md
+++ b/docs-site/src/content/docs/changelog.md
@@ -13,6 +13,7 @@ For the complete changelog with all details, see [CHANGELOG.md](https://github.c

 - **Relative-date fields** — position notes before, after, or equal to other notes, with query-time resolution and audit warnings for invalid chains
 - **Custom calendars** — define fictional or alternative calendars for date validation, sorting, comparisons, JSON output, audit, and relative-date anchors
+- **Lineage foundation** — reserved `forked-from`, per-field `reset_on_fork`, and audit checks for malformed IDs, dangling provenance, duplicate identities, and cycles establish the shared document-history contract (#802)
 - **Document forks** — `bwrb new --fork <target>` creates an ordinary sibling note with a fresh ID and immutable immediate-source provenance
 - **Fork lineage inspection** — `bwrb list --lineage <target>` renders the complete connected fork component, including sibling and cousin branches, as a tree, paths, links, content, or structured JSON
 - **Fork-safe deletion** — `bwrb delete` refuses notes with direct fork children or duplicate identities unless forced, preserving child provenance for audit when the parent is deliberately removed
diff --git a/docs-site/src/content/docs/concepts/custom-calendars.md b/docs-site/src/content/docs/concepts/custom-calendars.md
index bec77aa..b6d447e 100644
--- a/docs-site/src/content/docs/concepts/custom-calendars.md
+++ b/docs-site/src/content/docs/concepts/custom-calendars.md
@@ -44,18 +44,21 @@ Opt a date field into a calendar:
 {
   "types": {
     "event": {
+      "output_dir": "Events",
       "calendar_default": "tmi",
       "fields": {
         "name": { "prompt": "text", "required": true },
-        "when": { "prompt": "date" },
-        "gregorian": { "prompt": "date", "calendar": "earth" }
+        "when": { "prompt": "date" }
       }
     }
   }
 }
 ```

-`calendar_default` applies to date fields on the type that do not declare their own `calendar`. A `calendar` key is valid only on `prompt: "date"` fields. Unknown calendar ids are schema errors.
+`calendar_default` applies to date fields on the type that do not declare their
+own `calendar`. Instead of a type default, an individual date field can opt in
+with `"calendar": "tmi"`. A `calendar` key is valid only on `prompt: "date"`
+fields, and every referenced calendar id must exist in `config.calendars`.

 ## Date Format

@@ -68,7 +71,7 @@ The canonical format is:
 Examples:

 ```yaml
-when: "AR 3019-09-02 266:50"
+when: "AR 3019-02-02 266:50"
 origin: "BH 12-01-01"
 ```

@@ -81,9 +84,9 @@ Text table output displays the canonical string. JSON output expands calendar da
 ```json
 {
   "when": {
-    "value": "AR 3019-09-02 266:50",
+    "value": "AR 3019-02-02 266:50",
     "calendar": "tmi",
-    "linear": 24324338.833333332
+    "linear": 4057466.8333333335
   }
 }
 ```
diff --git a/docs-site/src/content/docs/concepts/hierarchical-scope.md b/docs-site/src/content/docs/concepts/hierarchical-scope.md
index f66117a..a272570 100644
--- a/docs-site/src/content/docs/concepts/hierarchical-scope.md
+++ b/docs-site/src/content/docs/concepts/hierarchical-scope.md
@@ -61,7 +61,7 @@ A `context` type is an ordinary entity with a **self-referential `parent` relati
       "recursive": true,
       "fields": {
         "type": { "value": "context" },
-        "parent": { "prompt": "relation", "source": "context", "format": "quoted-wikilink" },
+        "parent": { "prompt": "relation", "source": "context" },
         "aliases": { "prompt": "list", "alias": true, "list_format": "yaml-array", "default": [] }
       },
       "field_order": ["type", "parent", "aliases"]
@@ -71,7 +71,7 @@ A `context` type is an ordinary entity with a **self-referential `parent` relati
       "fields": {
         "type": { "value": "task" },
         "status": { "prompt": "select", "options": ["backlog", "active", "done"], "default": "backlog", "required": true },
-        "context": { "prompt": "relation", "source": "context", "format": "quoted-wikilink" }
+        "context": { "prompt": "relation", "source": "context" }
       },
       "field_order": ["type", "status", "context"]
     }
@@ -79,6 +79,9 @@ A `context` type is an ordinary entity with a **self-referential `parent` relati
 }
 ```

+Relation storage uses the vault-wide `config.link_format` (`wikilink` by
+default); field-level `format` is not part of the version 2 field schema.
+
 ## Querying at any altitude

 The leaf is exact; the domain is a subtree walk. Use the `under` operator (see [Targeting Model](/reference/targeting/#underfield-node-vs-isdescendantofnode)), which dereferences the `context` relation and walks **the target's** ancestor chain.
diff --git a/docs-site/src/content/docs/concepts/migrations.md b/docs-site/src/content/docs/concepts/migrations.md
index b780aa2..aacfbfe 100644
--- a/docs-site/src/content/docs/concepts/migrations.md
+++ b/docs-site/src/content/docs/concepts/migrations.md
@@ -180,19 +180,16 @@ inherits the field via `extends` — e.g. removing a `phase` option on `objectiv
 (or removing the `phase` field entirely) also cleans `task` notes when
 `task extends objective`.

-A same-named field on the descendant does **not** automatically shield it. The
-schema resolver applies a *restricted merge* to an inherited field: a child may
-override only metadata (`default` / `value` / `description` / `granularity`) — its
-raw structural keys (`options` / `multiple` / `required` / `source`) are **ignored**
-and the parent's structure wins. So a descendant whose raw entry merely re-declares
-an inherited field (a metadata-only override) is still governed by the parent and is
-cleaned/widened alongside it. A descendant is shielded **only** when the field is its
-own genuine, non-inherited definition — i.e. it does not inherit that field from the
-parent at all.
-
-Conversely, editing only such an ignored raw override (while the parent is unchanged)
-leaves the effective schema identical and produces **no** migration op, so valid note
-values are never deleted. Also, an absent `multiple` is treated as `false`, so adding
+A same-named child field explicitly key-merges onto the inherited definition.
+Every declared key wins, including structural keys such as `options`, `multiple`,
+`required`, and `source`; omitted keys stay inherited. Migrations compare each
+concrete type's old and new **effective** field, so a parent change fans out only
+where it changes that descendant's effective schema. A child structural override
+can shield it from the corresponding parent structural change, while inherited
+keys the child omitted still follow the parent. Editing the child override itself
+is a real child-scoped migration whenever its effective field changes.
+
+An absent `multiple` is treated as `false`, so adding
 or removing an explicit `multiple: false` is a no-op (no review, no version bump).
 :::

diff --git a/docs-site/src/content/docs/concepts/relative-dates.md b/docs-site/src/content/docs/concepts/relative-dates.md
index 66d7fad..c9620ef 100644
--- a/docs-site/src/content/docs/concepts/relative-dates.md
+++ b/docs-site/src/content/docs/concepts/relative-dates.md
@@ -47,9 +47,11 @@ position:
 | `field` | Optional anchor field. If omitted, Bowerbird uses the anchor's date field, then its relative-date field |
 | `offset` | Optional signed duration using `min`, `h`, `d`, or `w` |

-Offsets are parsed internally as `{ amount, unit, mode }` so future calendar-aware resolvers can preserve the unit instead of inheriting a millisecond-only value.
+Offsets preserve `{ amount, unit, mode }`, allowing custom-calendar chains to
+interpret `d` using that calendar's `hoursInDay` instead of flattening every
+offset to Gregorian milliseconds.

-For fictional or alternative timekeeping, define a [custom calendar](/concepts/custom-calendars/) and anchor relative-date chains on calendar date fields.
+For fictional or alternative timekeeping, define [Custom Calendars](/concepts/custom-calendars/) and anchor relative-date chains on calendar date fields.

 ## Resolution

diff --git a/docs-site/src/content/docs/concepts/types-and-inheritance.md b/docs-site/src/content/docs/concepts/types-and-inheritance.md
index 6f3ebc4..db37616 100644
--- a/docs-site/src/content/docs/concepts/types-and-inheritance.md
+++ b/docs-site/src/content/docs/concepts/types-and-inheritance.md
@@ -60,7 +60,10 @@ A `task` note gets:
 1. **Single inheritance** — Each type has exactly one parent
 2. **Unique names** — Type names must be unique across the entire schema
 3. **No cycles** — A type cannot extend its own descendant
-4. **Override defaults by convention** — Child types commonly override `default` values. Broader inherited field overrides are currently accepted by validation, so use structural changes deliberately.
+4. **Explicit-key field overrides** — When a child re-declares an inherited
+   field, every key it declares wins, including structural keys such as
+   `prompt`, `options`, `multiple`, `required`, and `source`. Keys it omits stay
+   inherited.

 ## Traits — composition alongside inheritance

@@ -97,7 +100,11 @@ own type fields  >  traits  >  inherited (parent chain)

 The override is **full** at the trait boundary: a trait field fully replaces an inherited field of the same name (every key, not just `default`), a **later trait in the array fully replaces an earlier one**, and an **own field fully replaces a trait field** — own's `prompt`, `options`, and `label` all win, with no trait values leaking through.

-The one place the override is *partial* is **own-vs-parent inheritance** (no trait involved): there an own field only merges `default`, `value`, `description`, and `granularity` onto the inherited definition, leaving structural keys as inherited. This is the long-standing inheritance behavior and is unchanged by traits.
+At the **own-vs-parent inheritance** boundary (no trait involved), the override
+is an explicit-key merge. The child keeps every inherited key it omits and
+replaces every key it declares. This applies equally to metadata and structure:
+`default`, `description`, `prompt`, `options`, `multiple`, `required`, `source`,
+and other declared properties all win locally.

 A type composing an unknown trait is a deterministic error.

diff --git a/docs-site/src/content/docs/concepts/validation-and-audit.md b/docs-site/src/content/docs/concepts/validation-and-audit.md
index fced35d..b0be8ba 100644
--- a/docs-site/src/content/docs/concepts/validation-and-audit.md
+++ b/docs-site/src/content/docs/concepts/validation-and-audit.md
@@ -29,11 +29,15 @@ bwrb audit --type task
 Audit catches:

 - Missing required fields
-- Invalid field values (not in enum options)
+- Invalid field values (not in a select field's inline options)
 - Type mismatches
 - Malformed frontmatter

-System-managed fields written by bwrb (`id`, `name`) are always allowed and never reported as `unknown-field`.
+Built-in fields recognized by bwrb (`id`, `name`, and `forked-from`) are always
+allowed and never reported as `unknown-field`. Ordinary creation writes `id`;
+JSON creation also persists its input `name`, while interactive creation
+currently derives the effective name from the filename without writing a `name`
+key ([#813](https://github.com/3mdistal/bwrb/issues/813)).

 ## Fixing Issues

diff --git a/docs-site/src/content/docs/getting-started/installation.md b/docs-site/src/content/docs/getting-started/installation.md
index a2ebc0b..5230142 100644
--- a/docs-site/src/content/docs/getting-started/installation.md
+++ b/docs-site/src/content/docs/getting-started/installation.md
@@ -84,7 +84,10 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish

 ### What Gets Completed

-- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `delete`, `list`, `open`, `search`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `config`, `completion`.
+- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `recent`, `audit`,
+  `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, and
+  `config`. `init` is visible in help but currently missing from completion
+  candidates ([#810](https://github.com/3mdistal/bwrb/issues/810)).
 - **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
 - **Types**: `bwrb list --type <TAB>` shows types from your schema
 - **Paths**: `bwrb list --path <TAB>` shows vault directories
diff --git a/docs-site/src/content/docs/getting-started/introduction.md b/docs-site/src/content/docs/getting-started/introduction.md
index 77960a1..61a0956 100644
--- a/docs-site/src/content/docs/getting-started/introduction.md
+++ b/docs-site/src/content/docs/getting-started/introduction.md
@@ -83,7 +83,8 @@ bwrb list idea --fields=status,priority

 ### JSON Mode for Automation

-Every command supports `--output json` for scripting and AI integration:
+Commands advertise their machine-readable modes explicitly. Use `--output json`
+or `--json` only where that command's help lists it:

 ```bash
 bwrb list task --output json | jq '.[] | select(.status == "active")'
diff --git a/docs-site/src/content/docs/getting-started/quick-start.md b/docs-site/src/content/docs/getting-started/quick-start.md
index f222f79..32fdbc2 100644
--- a/docs-site/src/content/docs/getting-started/quick-start.md
+++ b/docs-site/src/content/docs/getting-started/quick-start.md
@@ -7,12 +7,13 @@ This guide walks you through creating a vault with a schema and your first note.

 ## 1. Create a Vault

-A vault is any directory with a `.bwrb/schema.json` file:
+A vault is any directory with a `.bwrb/schema.json` file. Initialize one with
+the shipped non-interactive defaults:

 ```bash
 mkdir my-vault
 cd my-vault
-mkdir -p .bwrb
+bwrb init --yes
 ```

 ## 2. Define a Schema
@@ -21,10 +22,11 @@ Create `.bwrb/schema.json`. Here's a minimal schema with two types:

 ```json
 {
+  "version": 2,
   "types": {
     "idea": {
       "output_dir": "Ideas",
-      "frontmatter": {
+      "fields": {
         "type": { "value": "idea" },
         "created": { "value": "$NOW" },
         "status": {
@@ -32,11 +34,12 @@ Create `.bwrb/schema.json`. Here's a minimal schema with two types:
           "options": ["raw", "developing", "mature"],
           "default": "raw"
         }
-      }
+      },
+      "field_order": ["type", "created", "status"]
     },
     "task": {
       "output_dir": "Tasks",
-      "frontmatter": {
+      "fields": {
         "type": { "value": "task" },
         "created": { "value": "$NOW" },
         "status": {
@@ -49,7 +52,8 @@ Create `.bwrb/schema.json`. Here's a minimal schema with two types:
           "options": ["low", "medium", "high"],
           "default": "medium"
         }
-      }
+      },
+      "field_order": ["type", "created", "status", "priority"]
     }
   }
 }
@@ -78,12 +82,18 @@ The result is a properly-structured markdown file:
 ```markdown
 ---
 type: idea
+id: 550e8400-e29b-41d4-a716-446655440000
 created: 2025-01-07 14:30
 status: raw
 ---

 ```

+Interactive creation derives the effective note name from the filename and does
+not currently persist a `name` key. JSON creation persists `name` from its input;
+the creation-mode mismatch is tracked in
+[#813](https://github.com/3mdistal/bwrb/issues/813).
+
 ## 4. List Your Notes

 ```bash
@@ -180,25 +190,40 @@ Special values:

 ### Hierarchical Types

-Types can have subtypes for nested categorization:
+Types form a flat map. A child type points to its parent with `extends`:

 ```json
 {
   "types": {
     "objective": {
-      "subtypes": {
-        "task": { "output_dir": "Objectives/Tasks", ... },
-        "milestone": { "output_dir": "Objectives/Milestones", ... }
+      "output_dir": "Objectives",
+      "fields": {
+        "type": { "value": "objective" }
+      }
+    },
+    "task": {
+      "extends": "objective",
+      "output_dir": "Objectives/Tasks",
+      "fields": {
+        "type": { "value": "task" }
+      }
+    },
+    "milestone": {
+      "extends": "objective",
+      "output_dir": "Objectives/Milestones",
+      "fields": {
+        "type": { "value": "milestone" }
       }
     }
   }
 }
 ```

-Access subtypes with slash notation:
+Use the child name directly, or slash notation where a command accepts a type
+path:

 ```bash
-bwrb new objective/task
+bwrb new task
 bwrb list objective          # Lists all objectives (tasks + milestones)
 bwrb list objective/task     # Lists only tasks
 ```
@@ -237,6 +262,7 @@ export BWRB_VAULT=~/notes
 | `bwrb bulk --type <type> --set key=value` | Apply frontmatter changes in bulk |
 | `bwrb template list [type]` | List templates for a type |
 | `bwrb dashboard [name]` | Run a saved query |
+| `bwrb init [path] --yes` | Initialize a vault with version 2 defaults |
 | `bwrb config list` | Show vault config values |
 | `bwrb completion <shell>` | Generate shell completion script |

diff --git a/docs-site/src/content/docs/product/roadmap.md b/docs-site/src/content/docs/product/roadmap.md
index 780031d..a6b9672 100644
--- a/docs-site/src/content/docs/product/roadmap.md
+++ b/docs-site/src/content/docs/product/roadmap.md
@@ -1,46 +1,47 @@
 ---
 title: Roadmap
-description: Bowerbird development priorities
+description: Bowerbird shipped foundation and current development priorities
 ---

-## V1.0 (Current Focus)
+## Shipped foundation

-### Core Features
+Bowerbird remains pre-1.0, but the major product layers described in the older
+roadmap are implemented:

-- **Schema enforcement** — Hard on CLI, soft audit on drift
-- **Inheritance model** — Full, consistent type inheritance
-- **Core commands** — new, edit, list, search, audit, bulk, schema, template
-- **JSON mode** — Every command scriptable
-- **Migration tooling** — Rename fields, change select options, refactor types
+- Version 2 flat schemas with inheritance, traits, ownership, recursive types,
+  schema management, effective-schema migrations, and audit enforcement
+- Dashboards, `list --save-as`, aliases, hierarchical scope with `under()`,
+  partial and relative dates, and custom calendars
+- Canonical `list` discovery with name, fuzzy, body-match, content, open, and
+  lineage modes; hidden `search` and `open` remain compatibility commands
+- Deterministic agent safety nets: unlinked mentions, frequent unlinked terms,
+  daily-note coverage queries, `schema discover`, and event-driven recurrence
+- Native document forks, immutable lineage metadata, lineage inspection, and
+  fork-safe deletion
+- A live documentation site and generated public schema

-### Exit Criteria
+## Current pre-1.0 focus

-- [ ] Schema enforcement complete
-- [ ] Type inheritance implemented
-- [ ] All core commands stable
-- [ ] Migration system working
-- [ ] Documentation website live (you're reading it!)
+The remaining work is hardening rather than waiting for those foundations to
+exist:

-## Post-V1.0
+- Keep command help, completion, schemas, agent guidance, and docs generated or
+  checked from the same contracts
+- Stabilize machine-readable command-specific output shapes and exit behavior
+- Keep migrations and audit fixes conservative as schemas grow more expressive
+- Improve completion parity (including the current `init` omission, tracked in
+  [#810](https://github.com/3mdistal/bwrb/issues/810))
+- Align the config command with valid schema settings (tracked in
+  [#809](https://github.com/3mdistal/bwrb/issues/809))

-### Near Term — Schema Expressiveness
+## Genuinely future

-A richer schema so the AI agent uses it correctly:
-
-- Aliases — first-class alias field role
-- Traits — composition alongside inheritance
-- Hierarchical scope — contexts as real notes + `under` join
-
-### Future — AI Safety Net
-
-bwrb is the deterministic safety net *under* the AI agent, never an LLM caller:
-
-- `list --fuzzy` — scored candidate lookup before writing
-- `audit: unlinked-mention` — flag known entities mentioned but not linked
-- Daily-note sweep — coverage bookkeeping
-- `schema discover` — deterministic field-usage facts over a folder
-- Task recurrence — event-driven spawn + offset templating
+Future work should deepen reliability and ergonomics without turning bwrb into
+an LLM client, sync service, database, or writing application. Planned work is
+tracked in GitHub issues and feature plans; an item belongs in evergreen docs
+only after it ships.

 ---

-*For the detailed roadmap, see [docs/product/roadmap.md](https://github.com/3mdistal/bwrb/blob/main/docs/product/roadmap.md) in the repository.*
+*For rationale and issue links, see
+[docs/product/roadmap.md](https://github.com/3mdistal/bwrb/blob/main/docs/product/roadmap.md).*
diff --git a/docs-site/src/content/docs/product/vision.md b/docs-site/src/content/docs/product/vision.md
index 23fc809..6d5cdc5 100644
--- a/docs-site/src/content/docs/product/vision.md
+++ b/docs-site/src/content/docs/product/vision.md
@@ -41,7 +41,8 @@ Start minimal. Add types as patterns emerge. Migrate when ready.

 ### Consistency Above All

-Small command surface. Consistent flags. JSON mode everywhere.
+Small command surface. Consistent flags. Machine-readable modes where each
+command explicitly documents them.

 ## What Bowerbird Is NOT

diff --git a/docs-site/src/content/docs/reference/commands/audit.md b/docs-site/src/content/docs/reference/commands/audit.md
index 2128d21..9a0e70a 100644
--- a/docs-site/src/content/docs/reference/commands/audit.md
+++ b/docs-site/src/content/docs/reference/commands/audit.md
@@ -22,7 +22,7 @@ The target argument is auto-detected as type, path (contains `/`), or where expr
 | `-t, --type <type>` | Filter by type path |
 | `-p, --path <glob>` | Filter by file path pattern |
 | `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
-| `-b, --body <query>` | Filter by body content |
+| `-b, --body <query>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |
 | `-a, --all` | Target all files (explicit vault-wide selector) |

 ### Issue Filtering
@@ -100,7 +100,7 @@ Delete semantics in repair mode:
 | `broken-body-wikilink` | A well-formed `[[wikilink]]` in the note **body** whose target resolves to **no note** via the alias-aware, case-insensitive note index (warning; **flag-only** — offers a "did you mean?" hint but never auto-links — see below) |
 | `malformed-body-wikilink` | Wikilink bracket syntax in the body that is broken — an empty target (`[[]]`/`[[ ]]`) or an unclosed `[[` (warning; **flag-only**) |
 | `broken-body-file-link` | A relative markdown file/image link in the body — `[text](path.md)` / `![alt](img.png)` — whose target does not exist on disk (warning; **flag-only**) |
-| `relative-date-cycle` | A [`relative-date`](/concepts/relative-dates/) equal chain loops back on itself (warning; flag-only) |
+| `relative-date-cycle` | A [Relative Dates](/concepts/relative-dates/) equal chain loops back on itself (warning; flag-only) |
 | `relative-date-contradiction` | Multiple `equal` constraints on a relative-date field resolve to different positions (warning; flag-only) |
 | `relative-date-bound-violation` | A resolved relative date violates an `after` or `before` bound (warning; flag-only) |
 | `relative-date-invalid-ref` | A relative-date anchor reference is missing or ambiguous (warning; flag-only) |
diff --git a/docs-site/src/content/docs/reference/commands/bulk.md b/docs-site/src/content/docs/reference/commands/bulk.md
index 293a393..b0f1316 100644
--- a/docs-site/src/content/docs/reference/commands/bulk.md
+++ b/docs-site/src/content/docs/reference/commands/bulk.md
@@ -22,7 +22,7 @@ The target argument is auto-detected as type, path (contains `/`), or where expr
 | `-t, --type <type>` | Filter by type |
 | `-p, --path <glob>` | Filter by file path (supports globs) |
 | `-w, --where <expr>` | Filter by frontmatter expression (repeatable, ANDed) |
-| `-b, --body <query>` | Filter by body content |
+| `-b, --body <query>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |
 | `-a, --all` | Target all files (requires explicit intent) |

 ### Operations
diff --git a/docs-site/src/content/docs/reference/commands/completion.md b/docs-site/src/content/docs/reference/commands/completion.md
index 0e623e0..aed6b99 100644
--- a/docs-site/src/content/docs/reference/commands/completion.md
+++ b/docs-site/src/content/docs/reference/commands/completion.md
@@ -47,7 +47,7 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish

 | Context | Completions |
 |---------|-------------|
-| `bwrb <TAB>` | Commands: `new`, `edit`, `delete`, `list`, `open`, `search`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `config`, `completion` |
+| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, `config` |
 | `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`, etc. |
 | `bwrb new <TAB>` | Types from your schema |
 | `bwrb list --type <TAB>` | Types from your schema |
@@ -57,6 +57,10 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish

 - Completions are generated dynamically from your vault's schema
 - Ensure `BWRB_VAULT` is set or run from within a vault directory
+- `init` is visible in `bwrb --help` but is currently missing from root command
+  completion candidates ([#810](https://github.com/3mdistal/bwrb/issues/810))
+- The hidden compatibility commands `open` and `search` remain callable but are
+  not root completion candidates; use `list` for new workflows
 - Restart your shell after adding the completion script

 ## See Also
diff --git a/docs-site/src/content/docs/reference/commands/config.md b/docs-site/src/content/docs/reference/commands/config.md
index f06ba11..eda712c 100644
--- a/docs-site/src/content/docs/reference/commands/config.md
+++ b/docs-site/src/content/docs/reference/commands/config.md
@@ -27,6 +27,18 @@ bwrb config <subcommand>
 | `visual` | GUI editor command | Path or command |
 | `open_with` | Default app for opening notes | `system`, `editor`, `visual`, `obsidian` |
 | `obsidian_vault` | Obsidian vault name for URI scheme | String |
+| `default_dashboard` | Dashboard used when no name is passed | Dashboard name or empty string |
+| `excluded_directories` | Directory prefixes excluded from discovery and targeting | JSON string array |
+| `mention_exclude_types` | Types excluded as mention targets | JSON string array |
+| `mention_exclude_paths` | Path globs excluded as mention targets | JSON string array |
+| `mention_link_once` | Limit auto-fixes to one link per note/target pair | Boolean |
+
+This is the command's complete editable subset. Other valid schema settings —
+including `date_format`, `date_granularity`, `calendars`,
+`mention_fuzzy_threshold`, and the `mention_corpus_*` keys — must currently be
+edited directly in `.bwrb/schema.json` and checked with
+`bwrb schema validate`. The difference is tracked in
+[#809](https://github.com/3mdistal/bwrb/issues/809).

 ## Configuration Location

@@ -116,6 +128,11 @@ bwrb config edit open_with --json '"editor"'

 # Set complex value
 bwrb config edit obsidian_vault --json '"My Vault"'
+
+# Set arrays and booleans
+bwrb config edit excluded_directories --json '["Archive","Templates"]'
+bwrb config edit mention_exclude_paths --json '["Imports/**"]'
+bwrb config edit mention_link_once --json 'true'
 ```

 ---
diff --git a/docs-site/src/content/docs/reference/commands/delete.md b/docs-site/src/content/docs/reference/commands/delete.md
index 899f9ed..6739ae8 100644
--- a/docs-site/src/content/docs/reference/commands/delete.md
+++ b/docs-site/src/content/docs/reference/commands/delete.md
@@ -28,7 +28,7 @@ Delete operates in three modes:
 | `-t, --type <type>` | Filter by type |
 | `-p, --path <glob>` | Filter by path glob |
 | `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
-| `-b, --body <query>` | Filter by body content search |
+| `-b, --body <query>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |
 | `--id <uuid>` | Filter by stable note id |
 | `-a, --all` | Select all notes (required for bulk delete without other targeting) |

diff --git a/docs-site/src/content/docs/reference/commands/edit.md b/docs-site/src/content/docs/reference/commands/edit.md
index 995b816..e902f5b 100644
--- a/docs-site/src/content/docs/reference/commands/edit.md
+++ b/docs-site/src/content/docs/reference/commands/edit.md
@@ -26,7 +26,7 @@ third excess positional is rejected.
 | `-t, --type <type>` | Filter by note type |
 | `-p, --path <glob>` | Filter by path pattern |
 | `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
-| `-b, --body <pattern>` | Filter by body content |
+| `-b, --body <pattern>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |
 | `--json <patch>` | Non-interactive patch/merge mode |
 | `-o, --open` | Open the note after editing |
 | `--app <mode>` | App mode for `--open`: `system`, `editor`, `visual`, `obsidian`, `print` |
diff --git a/docs-site/src/content/docs/reference/commands/list.md b/docs-site/src/content/docs/reference/commands/list.md
index 2787924..ecfc846 100644
--- a/docs-site/src/content/docs/reference/commands/list.md
+++ b/docs-site/src/content/docs/reference/commands/list.md
@@ -35,7 +35,7 @@ rejected.
 | `-t, --type <type>` | Filter by type path (e.g., `idea`, `objective/task`) |
 | `-p, --path <glob>` | Filter by file path glob (e.g., `Projects/**`, `Ideas/`) |
 | `-w, --where <expr>` | Filter with expression (repeatable, ANDed together) |
-| `-b, --body <query>` | Filter by body content search |
+| `-b, --body <query>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |
 | `--name <query>` | Resolve by note name, path, or declared alias |
 | `--fuzzy <query>` | Rank approximate name and alias matches |
 | `--matches` | Show detailed body matches instead of filtering note rows |
@@ -102,10 +102,10 @@ bwrb list --name "Ideas/My Note.md" --output link --picker none
 # Ranked approximate matches, including aliases
 bwrb list --fuzzy "Stephen Yeg" --threshold 0.7 --output json

-# Filter note rows by a literal, case-insensitive body query
+# Filter note rows by a literal, case-insensitive file-content query
 bwrb list --body "TODO" --path "Projects/**"

-# Inspect exact body matches with grep-style context and regex controls
+# Inspect exact file matches with grep-style context and regex controls
 bwrb list --body "TODO|FIXME" --matches --regex --context 0
 ```

@@ -239,7 +239,7 @@ bwrb list --type task --where "priority < 3 && !isEmpty(deadline)"
 # By date
 bwrb list --type task --where "deadline < today() + '7d'"

-# By body content
+# By file content (including frontmatter today)
 bwrb list --body "TODO" --where "status == 'draft'"

 # By path
diff --git a/docs-site/src/content/docs/reference/commands/new.md b/docs-site/src/content/docs/reference/commands/new.md
index 0d8e15f..a1665f9 100644
--- a/docs-site/src/content/docs/reference/commands/new.md
+++ b/docs-site/src/content/docs/reference/commands/new.md
@@ -202,7 +202,13 @@ only be forked when its owner's field permits multiple children.
 2. **Template loading**: Loads matching template if available (unless `--no-template`)
 3. **Field prompts**: Prompts for each field defined in schema/template
 4. **File creation**: Creates file in the type's `output_dir`
-5. **System fields**: Writes `id` and `name` as bwrb-managed frontmatter fields. The reserved `forked-from` provenance field cannot be supplied through `--json`, templates, or schema fields/defaults; `new --fork` is the lineage-aware workflow that injects it
+5. **Built-in fields**: Writes system-managed `id`. JSON creation also persists
+   its input `name`; interactive creation currently derives the effective name
+   from the filename without writing that key
+   ([#813](https://github.com/3mdistal/bwrb/issues/813)). The reserved
+   `forked-from` provenance field cannot be supplied through `--json`, templates,
+   or schema fields/defaults; `new --fork` is the lineage-aware workflow that
+   injects it
 6. **Output**: Returns path to created file

 ## Template Discovery
diff --git a/docs-site/src/content/docs/reference/commands/recent.md b/docs-site/src/content/docs/reference/commands/recent.md
index f5b4742..25e4b52 100644
--- a/docs-site/src/content/docs/reference/commands/recent.md
+++ b/docs-site/src/content/docs/reference/commands/recent.md
@@ -46,7 +46,7 @@ is always available.
 | `-t, --type <type>` | Filter by type path (e.g., `idea`, `objective/task`) |
 | `-p, --path <glob>` | Filter by file path glob (e.g., `Projects/**`, `Ideas/`) |
 | `-w, --where <expr>` | Filter with expression (repeatable, ANDed together) |
-| `-b, --body <query>` | Filter by body content search |
+| `-b, --body <query>` | Filter by file content; current matching includes YAML frontmatter ([#812](https://github.com/3mdistal/bwrb/issues/812)) |

 ### Output

diff --git a/docs-site/src/content/docs/reference/commands/schema.md b/docs-site/src/content/docs/reference/commands/schema.md
index 86b0e21..9cf90d0 100644
--- a/docs-site/src/content/docs/reference/commands/schema.md
+++ b/docs-site/src/content/docs/reference/commands/schema.md
@@ -219,7 +219,7 @@ Validates the schema.json file against the expected structure:

 - Required fields are present
 - Field types are valid
-- Enum values are properly defined
+- Select options are properly defined inline on their fields
 - Type hierarchies are consistent
 - Types missing `output_dir` emit a warning (computed directory included)

@@ -389,7 +389,7 @@ Compares the current schema.json against the last migration snapshot to show:
 - Fields added to types
 - Fields removed from types
 - Field definitions changed
-- Enum values changed
+- Select options changed

 ### Examples

@@ -437,7 +437,7 @@ Migrations update existing notes when the schema changes:
 - Add new required fields with default values
 - Remove deleted fields
 - Rename fields
-- Update enum values
+- Update select options
 - Move files to new output directories

 ### Safety
diff --git a/docs-site/src/content/docs/reference/commands/template.md b/docs-site/src/content/docs/reference/commands/template.md
index ad21546..18f186a 100644
--- a/docs-site/src/content/docs/reference/commands/template.md
+++ b/docs-site/src/content/docs/reference/commands/template.md
@@ -269,7 +269,7 @@ Checks templates for:

 - Valid `template-for` type reference
 - Default field values match schema types
-- Default enum values are valid
+- Default select values appear in the field's inline options
 - Prompt-fields reference existing fields
 - No references to removed schema fields

diff --git a/docs-site/src/content/docs/reference/schema.md b/docs-site/src/content/docs/reference/schema.md
index ebcac07..72f6ab2 100644
--- a/docs-site/src/content/docs/reference/schema.md
+++ b/docs-site/src/content/docs/reference/schema.md
@@ -71,11 +71,12 @@ Types define categories of notes. Each type has a name (the object key) and a de
 | `extends` | string | `"meta"` | Parent type name (single-inheritance) |
 | `traits` | array | — | Trait names composed into this type (see [Traits](#traits)) |
 | `description` | string | — | What this type is for and when to use it. Surfaced by `bwrb schema list` |
-| `output_dir` | string | auto | Vault-relative folder where this type's notes live (e.g., `"Objectives/Tasks"`). See [Output directories](#output-directories) |
+| `output_dir` | string | required for `new` | Vault-relative folder where this type's notes live (e.g., `"Objectives/Tasks"`). Schema inspection reports a computed fallback when omitted, but current creation still requires an explicit value; see [Output directories](#output-directories) |
 | `fields` | object | `{}` | Field definitions |
 | `field_order` | array | — | Order of fields in frontmatter |
 | `body_sections` | array | — | Body structure after frontmatter |
 | `recursive` | boolean | `false` | Whether type can contain instances of itself |
+| `calendar_default` | string | — | Default id from `config.calendars` for this type's `date` fields that do not declare `calendar` |
 | `plural` | string | auto | Custom plural for folder naming (e.g., `"research"` instead of `"researchs"`) |

 ### Output directories
@@ -107,6 +108,11 @@ A nested note whose declared `type` does not match the folder it sits in is stil
 discoverable, but `bwrb audit` reports it as `wrong-directory` — discovery and the
 audit's directory check use the same subtree rule.

+`schema validate` currently permits an omitted `output_dir` and reports its
+computed hierarchy-based fallback as a warning. Ordinary `bwrb new` does not yet
+use that fallback and refuses creation until the type declares `output_dir`
+explicitly ([#811](https://github.com/3mdistal/bwrb/issues/811)).
+
 ### Inheritance

 All types inherit from `meta` (implicitly created if not defined). Types form a single-inheritance tree:
@@ -145,7 +151,9 @@ A `task` inherits:
 **Inheritance rules:**
 - Type names must be unique across the entire schema
 - No cycles allowed (a type cannot extend its own descendant)
-- Child types commonly override inherited `default` values. `bwrb schema validate` currently also accepts broader inherited field overrides, so use structural overrides deliberately.
+- A child re-declaration explicitly key-merges onto the inherited field. Every
+  declared key wins, including `prompt`, `options`, `multiple`, `required`, and
+  `source`; omitted keys keep their inherited values.

 ### Recursive Types

@@ -248,13 +256,16 @@ own type fields  >  traits  >  inherited (parent chain)
 - **Traits** are composed next, in the order the type lists them. A trait field **fully replaces** an inherited field of the same name (all keys — `prompt`, `options`, `label`, everything), and a **later trait in the array fully replaces an earlier one** (last-wins).
 - **Own fields** are applied last, and how they override depends on where the colliding field came from:
   - **vs a trait field** → own **fully replaces** it (all keys). This is the "own wins over traits" guarantee: own's `prompt`, `options`, and `label` all win, and validation uses own's options. Because a trait already fully replaced any inherited field of that name, a field that arrived through a trait is always full-overridden here — no trait values leak through.
-  - **vs an inherited field** (parent chain, no trait involved) → only the `default`, `value`, `description`, and `granularity` properties merge onto the inherited definition; structural keys (`prompt`, `options`, `label`, …) stay as inherited. This is the long-standing inheritance override behavior and is unchanged.
+  - **vs an inherited field** (parent chain, no trait involved) → the own field
+    explicitly key-merges onto the inherited definition. Declared metadata and
+    structural keys (`prompt`, `options`, `multiple`, `required`, `source`,
+    `label`, and so on) win; omitted keys remain inherited.

 Worked example — `status` defined in three places:

 | Setup | Resolved `status` |
 |-------|-------------------|
-| `base.status` + `task` own `status` (no trait) | inherited definition with only `default`/`value`/`description`/`granularity` merged from own |
+| `base.status` + `task` own `status` (no trait) | inherited definition with every explicitly declared own key merged over it |
 | `actionable.status` (trait) + `task` own `status` | own definition, in full (trait's `options`/`label` dropped) |
 | `base.status` + `actionable.status` (trait), no own | trait definition, in full (inherited dropped) |
 | `base.status` + `actionable.status` (trait) + `task` own `status` | own definition, in full (the trait first fully replaced `base`, then own fully replaced the trait — no inherited or trait leak) |
@@ -674,6 +685,7 @@ Complete list of field properties:
 | `required` | boolean | prompted | Whether field must have a value (default: `false`) |
 | `default` | string | prompted | Default value if user skips prompt |
 | `granularity` | string | `date` | Coarsest precision allowed: `day` (default), `month`, or `year`. Overrides `date_granularity` |
+| `calendar` | string | `date` | Calendar id from `config.calendars`. Overrides the type's `calendar_default`; invalid on non-date fields |
 | `options` | array | `select` | Allowed values: bare strings or `{ value, description }` objects |
 | `multiple` | boolean | `select`, `relation` | Allow multiple values (default: `false`) |
 | `source` | string | `relation`, `relative-date` | Type name to filter anchor/picker candidates, or `"any"` |
@@ -773,7 +785,10 @@ Vault-wide settings:
     "open_with": "obsidian",
     "editor": "nvim",
     "visual": "code",
-    "obsidian_vault": "My Vault"
+    "obsidian_vault": "My Vault",
+    "default_dashboard": "inbox",
+    "excluded_directories": ["Archive", "Templates"],
+    "mention_link_once": true
   }
 }
 ```
@@ -785,8 +800,25 @@ Vault-wide settings:
 | `editor` | string | `$EDITOR` | Terminal editor command |
 | `visual` | string | `$VISUAL` | GUI editor command |
 | `obsidian_vault` | string | auto | Obsidian vault name for URI scheme |
+| `default_dashboard` | string | — | Dashboard to run when `bwrb dashboard` has no name |
+| `excluded_directories` | array | `[]` | Vault-relative directory prefixes excluded from discovery and targeting |
 | `date_format` | string | `"YYYY-MM-DD"` | Display/parse format for date fields (`YYYY`, `MM`, `DD` tokens) |
 | `date_granularity` | string | `"day"` | Default coarsest date precision for all date fields: `day`, `month`, or `year`. Per-field [`granularity`](#partial-dates-and-granularity) overrides it |
+| `calendars` | object | `{}` | Named custom-calendar definitions available to type `calendar_default` and field `calendar`; see [Custom Calendars](/concepts/custom-calendars/) |
+| `mention_fuzzy_threshold` | integer | `2` | Maximum fuzzy edit distance for `unlinked-mention` suggestions (`0` disables fuzzy matching; range `0`–`5`) |
+| `mention_corpus_calibration` | boolean | `true` | Damp vault-common single-word mention targets using corpus casing statistics |
+| `mention_corpus_min_notes` | integer | `3` | Minimum distinct non-self notes required before corpus damping can apply |
+| `mention_corpus_noncanonical_ratio` | number | `0.5` | Strict non-canonical-case share threshold for corpus damping (`0`–`1`) |
+| `mention_link_once` | boolean | `false` | During `audit --fix --auto`, write at most one new link per note/target pair; CLI flags can override per run |
+| `mention_exclude_types` | array | `[]` | Type names excluded as mention targets; matching notes are still scanned as source documents |
+| `mention_exclude_paths` | array | `[]` | Vault-relative globs excluded as mention targets; matching notes are still scanned as source documents |
+
+`bwrb config list/edit` currently exposes only a subset of these keys. Date
+formats, date granularity, calendar definitions, and corpus/fuzzy tuning are
+currently schema-only settings; edit `.bwrb/schema.json` and validate it with
+`bwrb schema validate`. See [bwrb config](/reference/commands/config/) for the
+editable subset and [#809](https://github.com/3mdistal/bwrb/issues/809) for the
+tracked command/schema mismatch.

 ---

diff --git a/docs-site/src/content/docs/reference/targeting.md b/docs-site/src/content/docs/reference/targeting.md
index d1f32bc..4379419 100644
--- a/docs-site/src/content/docs/reference/targeting.md
+++ b/docs-site/src/content/docs/reference/targeting.md
@@ -65,7 +65,7 @@ bwrb audit --where "isEmpty(tags)"
 - System fields are always available: `name` (falls back to filename) and `id`.

 **Type-checking behavior:**
-- With `--type`: strict validation (error on unknown fields and invalid enum/select values)
+- With `--type`: strict validation (error on unknown fields and invalid select values)
 - Without `--type`: unknown fields are permissive (no unknown-field validation)
 - In all modes: invalid expression syntax and runtime expression errors are hard errors

@@ -196,7 +196,8 @@ context notes and collapsing a redundant `scope` field into it — see

 ### Body (`-b, --body <query>`)

-Filter by body content (full-text search via ripgrep).
+Filter by literal file content (full-text search via ripgrep). The option keeps
+its historical `--body` name, but current matching includes YAML frontmatter.

 ```bash
 bwrb list --body "TODO"
@@ -205,7 +206,8 @@ bwrb list --body "meeting notes" --matches --type task
 ```

 **Behavior:**
-- Searches note body content (not frontmatter)
+- Searches the serialized Markdown file, including YAML frontmatter; body-only
+  masking is tracked in [#812](https://github.com/3mdistal/bwrb/issues/812)
 - Uses ripgrep under the hood for performance
 - Case-insensitive by default

@@ -302,7 +304,9 @@ See also: [CLI Safety and Flags](/concepts/cli-safety-and-flags/)

 ## Output Formats

-Use `--output <format>` (or `-o`) to control how results are displayed:
+Use the long `--output <format>` option to control how results are displayed.
+On commands that support it, `-o` means `--open`; it is never shorthand for
+`--output`.

 | Format | Description |
 |--------|-------------|
@@ -311,7 +315,7 @@ Use `--output <format>` (or `-o`) to control how results are displayed:
 | `paths` | File paths only |
 | `link` | Wikilinks (`[[Note Name]]`) |
 | `tree` | Hierarchical tree view (list only) |
-| `content` | Full file contents (search only) |
+| `content` | Full file contents (`list` and compatibility `search`) |

 ```bash
 bwrb list --type task --output json
diff --git a/docs-site/src/content/docs/templates/creating-templates.md b/docs-site/src/content/docs/templates/creating-templates.md
index f4dc72d..20885c5 100644
--- a/docs-site/src/content/docs/templates/creating-templates.md
+++ b/docs-site/src/content/docs/templates/creating-templates.md
@@ -284,7 +284,7 @@ bwrb template validate

 This catches:
 - References to removed fields
-- Invalid enum values
+- Invalid select values
 - Mismatched type paths

 ## Instance Scaffolding
diff --git a/docs/product/architecture/bwrb-new-command-flow.md b/docs/product/architecture/bwrb-new-command-flow.md
index 8f74d74..a19befc 100644
--- a/docs/product/architecture/bwrb-new-command-flow.md
+++ b/docs/product/architecture/bwrb-new-command-flow.md
@@ -8,11 +8,19 @@

 ## Overview

-`bwrb new` has four creation flows (interactive/JSON × owned/pooled). The command handler in `src/commands/new.ts` selects the path, delegates to the interactive or JSON module, resolves ownership, and finally writes the note + optional instances via `writeNotePlan`.
+`bwrb new` has an early native-document-fork path plus four ordinary creation
+flows (interactive/JSON × owned/pooled). The command handler in
+`src/commands/new.ts` selects the path, delegates ordinary creation to the
+interactive or JSON module, resolves ownership, and finally writes the note +
+optional instances via `writeNotePlan`.

 Key decisions:

 - `--json` switches to non-interactive JSON mode.
+- `--fork <target>` enters native fork mode before ordinary type/template/
+  ownership flow. It resolves an exact source note, copies it beside the source,
+  assigns a fresh `id`, writes `forked-from`, and honors field
+  `reset_on_fork`.
 - Template selection is controlled by `--template`, `--no-template`, or interactive selection when multiple templates exist.
 - Ownership is controlled by `--owner`, `--standalone`, or interactive ownership prompts.
 - Instance scaffolding is controlled by `--no-instances`.
@@ -23,7 +31,11 @@ Key decisions:

 ```mermaid
 flowchart TD
-  Start([bwrb new]) --> JsonMode{--json provided?}
+  Start([bwrb new]) --> ForkMode{--fork provided?}
+  ForkMode -->|yes| ResolveFork[Resolve exact path, name, alias, or UUID]
+  ResolveFork --> CopyFork[Copy document beside source; fresh id + forked-from]
+  CopyFork --> ForkDone[Return fork path and lineage metadata]
+  ForkMode -->|no| JsonMode{--json provided?}
   JsonMode -->|yes| RequireType[Type path required]
   JsonMode -->|no| ResolveType[Resolve type path
 (positional/--type or prompt)]
@@ -58,6 +70,22 @@ flowchart TD

 ## Flow details

+### Native document fork
+
+Use `--fork <target>` to create a lineage-aware copy of an existing document.
+Fork mode is separate from ordinary typed note creation: type, template,
+ownership, instance, and frontmatter-JSON flags are rejected. `--name` or
+`--label` supplies the new name; non-interactive/JSON output requires one.
+
+The fork remains beside its source, receives a fresh system `id`, and stores the
+source UUID in reserved `forked-from`. Fields marked `reset_on_fork: true` are
+omitted so schema defaults can repopulate them. Implementation lives in
+`src/commands/new/fork.ts`.
+
+```bash
+bwrb new --fork "Briefs/Launch Brief" --label concise --output json
+```
+
 ### Interactive + owned

 Use when `--json` is not provided and ownership resolves to owned.
diff --git a/docs/product/cli-output-contract.md b/docs/product/cli-output-contract.md
index c390f26..2854ec5 100644
--- a/docs/product/cli-output-contract.md
+++ b/docs/product/cli-output-contract.md
@@ -1,58 +1,53 @@
 # CLI JSON Output + Exit Contract

-> The product-level contract for machine-readable CLI output.
+> Product-level contract for machine-readable CLI output.

-**Canonical docs:** This document is product rationale + implementation contract. User-facing JSON behavior is canonical on docs-site (see https://bwrb.dev/automation/json-mode/ and command reference pages). Source-of-truth policy: `docs/product/canonical-docs-policy.md`.
+**Canonical docs:** User-facing JSON behavior lives in the docs-site
+[JSON Mode](../../docs-site/src/content/docs/automation/json-mode.md) and
+command-reference pages. This note records implementation constraints and the
+intentional command-specific shapes.

----
+## Scope

-## Why this exists
+JSON is not a universal global mode. A command supports `--output json` or
+`--json` input only when its registered help says so. Adding either option is a
+command-boundary API decision and needs command-specific tests and docs.

-Bowerbird is designed to be scriptable and composable. In `--output json` mode, the CLI is an API.
+When a command selects JSON output, it must write exactly one complete,
+newline-terminated JSON value to stdout. Prompts and human diagnostics must not
+pollute stdout; warnings belong on stderr or should be suppressed. Success exits
+`0`; failure exits non-zero. The CLI-wide codes are `0` success, `1` validation,
+`2` I/O, and `3` schema.

-This contract ensures:
-- Automation and CI can parse output reliably.
-- The Neovim plugin (and any wrappers) can depend on stable JSON.
-- We avoid intermittent truncated JSON caused by exiting too early.
+## Success shapes are command-specific

----
+The helpers in `src/lib/output.ts` define a useful `JsonSuccess`/`JsonError`
+envelope, but not every successful workflow uses that envelope. Existing shapes
+are part of the compatibility contract:

-## Contract (authoritative)
+| Workflow | Success JSON |
+| --- | --- |
+| Normal `list --output json` | Raw array of note objects |
+| `list --count --output json` | Raw `{ count }` object |
+| Canonical name/fuzzy modes | `{ success: true, data: [...] }` |
+| Detailed body matches | `{ success: true, data: [...], totalMatches, truncated }` |
+| `list --lineage --output json` | Raw `{ target, nodes, warnings }` object |
+| `new --fork --output json` | `{ success: true, path, id, forked_from, warnings, ... }` |
+| Other mutation/management commands | Usually a `JsonSuccess` envelope; document and test the exact command shape |

-When `--output json` is selected, commands MUST follow these rules:
+Do not wrap a legacy raw success shape merely to make the prose look uniform.
+That would be a product/API change, not a documentation correction.

-### Stdout
+## Error contract

-- MUST write **exactly one** complete JSON value to **stdout**.
-- MAY pretty-print the JSON (whitespace and internal newlines are allowed).
-- MUST newline-terminate the output.
-- MUST NOT write any non-JSON text to stdout (no tables, prompts, progress, warnings, etc.).
-- Consumers MUST parse stdout as JSON (not line-delimited/NDJSON).
-
-### Stderr
-
-- Human-oriented logs, progress, warnings, and diagnostics MUST go to **stderr**, or be suppressed in JSON mode.
-- In JSON mode, commands SHOULD avoid interactive prompts; if required input is missing, return `JsonError` and a non-zero exit code instead.
-
-### JSON envelope
-
-- Stdout MUST be a single `JsonResult` value.
-- Command-specific payload belongs under `data`.
-
-The canonical envelope is defined in `src/lib/output.ts`:
+Machine-readable command failures should emit a structured error object on
+stdout and set a non-zero process exit code:

 ```ts
-export interface JsonSuccess<T = unknown> {
-  success: true;
-  data?: T;
-  path?: string;
-  updated?: string[];
-  message?: string;
-}
-
 export interface JsonError {
   success: false;
   error: string;
+  data?: unknown;
   errors?: Array<{
     field: string;
     value?: unknown;
@@ -62,98 +57,23 @@ export interface JsonError {
   }>;
   code?: number;
 }
-
-export type JsonResult<T = unknown> = JsonSuccess<T> | JsonError;
 ```

-**Structured error details:** Use `errors[]` for machine-readable details (e.g., resolution candidates):
-
-```json
-{
-  "success": false,
-  "error": "No matches for query",
-  "errors": [
-    { "field": "candidate", "value": "Work/Task A.md", "message": "Matching file" }
-  ]
-}
-```
-
----
-
-## Stability & compatibility
-
-- The `JsonResult` envelope is intended to be forward-compatible: consumers MUST ignore unknown fields.
-- We MAY add new optional fields over time without breaking consumers.
-- We SHOULD NOT rename/remove existing fields without a major version bump.
-- The process exit code is authoritative; `JsonError.code` is best-effort metadata.
-
----
-
-## Exit behavior
-
-### Exit codes
-
-- Success MUST exit with code `0`.
-- Failure MUST exit with a non-zero code.
-
-Exception: `bwrb audit --fix --auto` exits `0` after applying unambiguous fixes even if issues remain. Remaining issues are reported in the output summary and should be treated as follow-up work rather than a hard failure.
+The process exit code is authoritative; `code` is best-effort metadata. Clients
+must ignore unknown fields so compatible metadata can be added later.

-The CLI-wide exit codes are defined in `src/lib/output.ts`:
-
-- `0` `SUCCESS`
-- `1` `VALIDATION_ERROR`
-- `2` `IO_ERROR`
-- `3` `SCHEMA_ERROR`
-
-### Errors in JSON mode
-
-- In `--output json`, failures MUST still emit a JSON error object (`JsonError`) on stdout.
-- When available, `JsonError.code` SHOULD match the process exit code.
-
----
-
-## Termination (`process.exit`) guidance
-
-Avoid `process.exit()` from inside deep helpers.
-
-- Prefer returning a result or throwing an error and letting the command handler decide:
-  - what to print
-  - what exit code to use
-- If `process.exit()` is used, it MUST be done only at the command boundary and only after stdout has been written.
-
-This reduces the risk of truncated JSON output.
-
----
-
-## Examples
-
-### Success
-
-```json
-{
-  "success": true,
-  "data": {
-    "count": 3
-  }
-}
-```
-
-### Failure
-
-```json
-{
-  "success": false,
-  "error": "Invalid schema",
-  "code": 3
-}
-```
+## Termination guidance

----
+Avoid `process.exit()` in deep helpers. Return or throw to the command boundary,
+which decides the output shape and exit code. If a command must exit directly,
+write the full JSON value first. This prevents truncated output when stdin stays
+open or the command is embedded in automation.

-## Author checklist (for command implementations)
+## Author checklist

-In `--output json`:
-- Emit one `JsonResult` to stdout (newline-terminated).
-- Send logs/warnings/progress to stderr (or suppress).
-- Do not call `process.exit()` from helper functions.
-- On failure, emit `JsonError` and set a non-zero exit code.
+- Register and document JSON flags per command; never claim blanket support.
+- Emit one parseable JSON value with no human text on stdout.
+- Preserve the command's established success shape.
+- Emit structured errors and a non-zero failure exit.
+- Test prompt-mode/stdin-open termination for mutation commands.
+- Document raw arrays/objects and envelopes exactly as consumers receive them.
diff --git a/docs/product/cli-targeting.md b/docs/product/cli-targeting.md
index 368302f..77333f7 100644
--- a/docs/product/cli-targeting.md
+++ b/docs/product/cli-targeting.md
@@ -113,7 +113,8 @@ bwrb list --type task --where "under(context, '[[career]]')"

 ### 4. Body (`--body <query>`)

-Filter by body content (full-text search via ripgrep).
+Filter by literal file content (full-text search via ripgrep). The option keeps
+its historical `--body` name, but current matching includes YAML frontmatter.

 ```bash
 bwrb list --body "TODO"
@@ -122,7 +123,8 @@ bwrb list --body "meeting notes" --matches --type task
 ```

 **Behavior:**
-- Searches note body content (not frontmatter)
+- Searches the serialized Markdown file, including YAML frontmatter; body-only
+  masking is tracked in [#812](https://github.com/3mdistal/bwrb/issues/812)
 - Uses ripgrep under the hood for performance
 - Case-insensitive by default

@@ -205,8 +207,9 @@ Commands that operate on note sets support the core selectors. Some commands als
 **Notes:**
 - `list` is the canonical query/search/open surface; `open` and `search` are
   compatibility commands.
-- `edit` is an alias for `search --edit`
-- Both aliases gain full targeting support automatically
+- `edit` is the canonical mutation command. The hidden compatibility form
+  `search --edit` delegates to the edit workflow and retains its established
+  behavior for existing scripts.

 ---

@@ -302,7 +305,7 @@ Bowerbird recognizes multiple exclusion mechanisms:

 ### When Exclusion Rules Apply

-Excluded directories apply to **all bwrb operations** consistently. If a file is excluded, it does not enter the candidate set for `list`, `search`/`open`/`edit`, or `audit`.
+Excluded directories apply to **all bwrb operations** consistently. If a file is excluded, it does not enter the candidate set for canonical `list`/`edit`, compatibility `search`/`open`, or `audit`.

 ### Example

diff --git a/docs/product/migrations.md b/docs/product/migrations.md
index 7a0b1ab..b6f0191 100644
--- a/docs/product/migrations.md
+++ b/docs/product/migrations.md
@@ -32,7 +32,7 @@ Shows pending changes between the current schema and the last-applied snapshot.

 ```bash
 bwrb schema diff
-bwrb schema diff --json
+bwrb schema diff --output json
 ```

 Output categorizes changes as:
@@ -121,7 +121,7 @@ Shows migration history.

 ```bash
 bwrb schema history
-bwrb schema history --json
+bwrb schema history --output json
 ```

 ## Migration Types
@@ -163,17 +163,14 @@ inherited `legacy` field from `task` notes too, when `task` extends `objective`)
 descendant that defines its **own** same-named field still resolves to that field
 after the parent's removal, so it is correctly left untouched.

-This includes descendants that re-declare the inherited field. The schema
-resolver applies a *restricted merge* to an inherited field: a child may override
-only metadata (`default`/`value`/`description`/`granularity`) — its raw structural
-keys (`options`/`multiple`/`required`/`source`) are **ignored**, and the parent's
-structure wins. Because a child therefore cannot structurally fork an inherited
-field, every inheriting descendant — even one whose raw entry re-declares
-`options` — is governed by the parent's structure and is cleaned/widened under its
-own concrete type when the parent changes. Conversely, editing only such an
-ignored raw override (while the parent is unchanged) leaves the effective schema
-identical and produces **no** migration op, so valid note values are never
-deleted.
+This includes descendants that re-declare the inherited field, but only to the
+extent that their **effective** field changes. The resolver explicit-key-merges
+a child's raw declaration onto the inherited field: every declared key wins,
+including structural keys (`options`, `multiple`, `required`, `source`), while
+omitted keys stay inherited. A child structural override can therefore shield
+that child from the corresponding parent structural change. Parent keys the
+child omitted still flow through, and editing the child's override produces a
+child-scoped migration when it changes the child's effective field.

 Note: only the *effective* value of `multiple` matters — an absent `multiple` is
 treated as `false`. Adding or removing an explicit `multiple: false` is therefore
@@ -233,8 +230,8 @@ status line, but the displayed schema is never sourced from the snapshot.

 ## Version Suggestion Logic

-- **Major bump** (1.0.0 -> 2.0.0): Breaking changes like type/field/enum removals
-- **Minor bump** (1.0.0 -> 1.1.0): Additions (new types, fields, enum values)
+- **Major bump** (1.0.0 -> 2.0.0): Breaking changes like type/field/select-option removals
+- **Minor bump** (1.0.0 -> 1.1.0): Additions (new types, fields, select options)
 - **Patch bump** (1.0.0 -> 1.0.1): No structural changes (rare)

 ## Best Practices
diff --git a/docs/product/roadmap.md b/docs/product/roadmap.md
index efe4cda..2663a02 100644
--- a/docs/product/roadmap.md
+++ b/docs/product/roadmap.md
@@ -1,145 +1,59 @@
 # Bowerbird Roadmap

-> Versioned milestones for Bowerbird development
-
----
-
-## Version Philosophy
-
-**v1: Schema + Dashboards** — Rock-solid schema enforcement, inheritance model, type safety, and saved queries
-**v2: Schema expressiveness + PKM** — A richer schema (aliases, traits, hierarchical scope) so the AI agent uses it correctly, plus deeper queries and visibility
-**v3: AI safety net** — Deterministic primitives *under* the AI agent (no LLM in bwrb): `list --fuzzy`, `audit: unlinked-mention`, daily-note sweep, `schema discover`, event-driven task recurrence
-
----
-
-## v1.0: Schema (Current Focus)
-
-The core promise: your notes can't violate the schema.
-
-### Execution Order
-
-Work should proceed in this order due to dependencies:
-
-#### Phase 1: The Big Rename + Refactor
-| Priority | Issue | Title | Blocked By |
-|----------|-------|-------|------------|
-| P0 | `bwrb-cr7` | Rename ovault to bwrb | — |
-| P0 | `bwrb-wbz` | Implement inheritance model | `bwrb-cr7` |
-
-#### Phase 2: Core Inheritance Features
-After inheritance model is in place:
-| Priority | Issue | Title |
-|----------|-------|-------|
-| P1 | `bwrb-9g9` | Implement ownership and folder computation |
-| P1 | `bwrb-0k0` | Update tests for new schema format |
-| P1 | `bwrb-taz` | Implement context field validation |
-| P1 | `bwrb-ita` | Implement recursive type support |
-| P1 | `bwrb-oa8` | Update audit for new type resolution |
-
-#### Phase 3: Schema Management CLI
-| Priority | Issue | Title |
-|----------|-------|-------|
-| P1 | `bwrb-tsh` | Schema Management CLI |
-| P2 | `bwrb-w2a` | `bwrb schema new type` command |
-| P2 | `bwrb-tev` | `bwrb schema new field` command |
-| P1 | — | Field primitives (text, number, boolean, relation) |
-
-#### Phase 4: Polish
-| Priority | Issue | Title |
-|----------|-------|-------|
-| P2 | `bwrb-3nd` | Schema migration system |
-| P2 | `bwrb-fkd` | Finalize command surface |
-| P2 | `bwrb-oay` | Template spawning with ownership |
-| P2 | `bwrb-xy1` | Remove name_field, standardize on 'name' |
-
-#### Phase 5: Dashboards
-Dashboards are saved `bwrb list` queries that can be recalled by name. This minimal implementation builds on existing list infrastructure.
-
-| Priority | Issue | Title |
-|----------|-------|-------|
-| P1 | #196 | Storage format and persistence layer |
-| P1 | #197 | `dashboard <name>` - Run saved query |
-| P1 | #199 | `dashboard list` - List saved dashboards |
-| P1 | #200 | `dashboard new` - Create dashboard |
-| P2 | #198 | `dashboard` (no args) - Picker or default |
-| P2 | #201 | `dashboard edit` - Modify dashboard |
-| P2 | #202 | `dashboard delete` - Remove dashboard |
-| P2 | #203 | Default dashboard support |
-| P2 | #204 | List `--save-as` flag |
-
-### v1.0 Exit Criteria
-
-- [x] Renamed to Bowerbird (CLI, config, docs, repo)
-- [x] Inheritance model fully implemented
-- [x] Ownership/colocation working
-- [x] Context field validation in audit
-- [x] Schema management CLI (schema new/edit/delete/list)
-- [x] Field primitives: text, number, boolean, date, select, relation, list
-- [ ] Dashboard system (storage, CRUD commands, list --save-as)
-- [x] All tests passing with new schema format
-- [ ] Documentation website (bwrb.dev)
-
----
-
-## v2.0: Schema Expressiveness + PKM (Future)
-
-Make the schema richer so the AI agent uses it correctly, and make queries deeper. The schema is the shared language between the human and the agent; investing here pays off everywhere. See `plans/features/schema-expressiveness.md`.
-
-### Planned Features
-
-| Feature | Issue | Description |
-|---------|-------|-------------|
-| Aliases | #266 | First-class alias field role; substrate for the ingest safety net |
-| Traits | #442 | Composition (`also-has`) alongside inheritance (`is-a`) |
-| Hierarchical scope | #554 | Contexts as real notes + `under` join; collapses scope + context |
-| Link validation | `bwrb-6f0` | Broken link detection in audit |
-| Command consolidation | `bwrb-fkd` | Merge list/search/open |
-
-### v2.0 Exit Criteria
-
-- [ ] Alias field role and Obsidian-format validation
-- [ ] Trait composition with deterministic precedence rules
-- [ ] Hierarchical scope with `under` operator
-- [ ] Comprehensive link validation
-- [ ] Polished, consistent CLI surface
-
----
-
-## v3.0: AI Safety Net (Future)
-
-bwrb is the **deterministic safety net under the AI agent, not an LLM caller.** The AI agent (Claude Code, Codex, etc.) does open-world extraction; bwrb provides closed-world verification — deterministic primitives that guarantee nothing gets swept under the rug. No LLM, no OpenRouter client, no cost tracking in bwrb. See `plans/features/ingest-safety-net.md` and `plans/features/task-system.md`.
-
-### Planned Features
-
-| Feature | Issue | Description |
-|---------|-------|-------------|
-| `list --fuzzy` | #93 | Scored candidate lookup so the agent checks "does X exist?" before writing |
-| `audit: unlinked-mention` | #93 | Flag known-entity names in prose that aren't wikilinked (exact/alias auto-fixable; fuzzy flag-only) |
-| `audit: frequent-unlinked-term` | — | Advisory nudge toward entities mentioned often but with no note yet |
-| Daily-note sweep | #87 | Frontmatter convention + saved query proving every ramble was looked at |
-| Task recurrence | #107 | Event-driven spawn-on-transition + offset templating (no daemon, no cron) |
-
-### v3.0 Exit Criteria
-
-- [ ] `list --fuzzy` returns scored candidates
-- [ ] `unlinked-mention` audit with exact/alias auto-fix and fuzzy review
-- [ ] Daily-note sweep coverage query
-- [ ] Event-driven recurrence with audit backstop
-- [ ] Zero LLM calls — works entirely offline, no AI keys
-
----
-
-## Deferred (Post-v3)
-
-| Feature | Issue | Notes |
-|---------|-------|-------|
-| `schema discover` | #97 | Deterministic field-usage facts over a folder (not AI schema generation) |
-
----
-
-## Reference
-
-- **Product Vision:** `docs/product/vision.md`
-- **Type System (overview):** `docs/product/type-system.md`
-- **Type System (technical):** `docs/technical/inheritance.md`
-- **Issue Tracker:** GitHub Issues
+> Shipped foundation and remaining pre-1.0 priorities.
+
+User-facing status is summarized on the docs-site
+[Roadmap](../../docs-site/src/content/docs/product/roadmap.md). Feature behavior
+is canonical in the relevant docs-site concepts and command references.
+
+## Shipped foundation
+
+The old v1/v2/v3 phase labels no longer describe product state. Their principal
+features have shipped:
+
+- **Schema and enforcement:** version 2 flat schemas, single inheritance,
+  explicit-key inherited field overrides, traits, ownership, recursive types,
+  schema CRUD, effective-schema migrations, validation, and audit repair
+- **PKM/query surface:** dashboards and `list --save-as`, aliases, hierarchical
+  scope and `under()`, partial dates, relative dates, custom calendars, and
+  canonical `list` name/fuzzy/body/content/open modes
+- **Deterministic safety net:** `unlinked-mention`,
+  `frequent-unlinked-term`, daily-note coverage queries, `schema discover`, and
+  event-driven recurrence with an audit backstop
+- **Document history:** native forks, system `id` and `forked-from`, field
+  `reset_on_fork`, lineage inspection, lineage integrity audits, and fork-safe
+  deletion
+- **Delivery:** live docs-site, generated JSON Schema, JSON-capable automation
+  on the commands that advertise it, shell completion, and release packaging
+
+The compatibility `search` and `open` commands remain callable for existing
+scripts, but `list` is the canonical read surface and `edit` is the canonical
+mutation surface.
+
+## Current focus
+
+1. **Pre-1.0 contract hardening** — Keep help, docs, agent guidance, generated
+   schema, completion, and tests synchronized with shipped behavior.
+2. **Safe automation** — Preserve command-specific JSON shapes, clean exits,
+   non-interactive guarantees, and conservative destructive-operation gates.
+3. **Schema evolution reliability** — Continue strengthening migration/audit
+   behavior as field and calendar expressiveness grows.
+4. **Known parity gaps** — Resolve schema/config command coverage
+   ([#809](https://github.com/3mdistal/bwrb/issues/809)) and completion tables
+   ([#810](https://github.com/3mdistal/bwrb/issues/810)).
+
+## Future boundary
+
+Bowerbird stays the deterministic layer under an AI agent. It does not call
+models, host notes, sync vaults, or become a writing application. Future work is
+tracked in GitHub issues and `plans/features/`; a proposal remains a proposal
+until merged. Evergreen docs must describe shipped behavior, while historical
+release notes preserve when it arrived.
+
+## References
+
+- [Product Vision](vision.md)
+- [Canonical documentation policy](canonical-docs-policy.md)
+- [Type System](type-system.md)
+- [Inheritance technical note](../technical/inheritance.md)
+- [Issue tracker](https://github.com/3mdistal/bwrb/issues)
diff --git a/docs/product/system-frontmatter.md b/docs/product/system-frontmatter.md
index 6bda1e8..c504172 100644
--- a/docs/product/system-frontmatter.md
+++ b/docs/product/system-frontmatter.md
@@ -4,10 +4,12 @@ This document defines bwrb-managed frontmatter fields that are not required to b

 ## System-managed fields

-These fields are written by bwrb and are always allowed in frontmatter:
+These fields are recognized by bwrb and are always allowed in frontmatter:

-- `id`
-- `name`
+- `id` (written by ordinary creation and forks)
+- `name` (persisted from JSON creation when supplied; interactive creation
+  currently derives the effective name from the filename without writing the
+  key, tracked in [#813](https://github.com/3mdistal/bwrb/issues/813))
 - `forked-from` (immediate source note UUID, written by `bwrb new --fork`)

 Audit/validation behavior:
diff --git a/docs/product/type-system.md b/docs/product/type-system.md
index b9a64b0..aeb0706 100644
--- a/docs/product/type-system.md
+++ b/docs/product/type-system.md
@@ -27,8 +27,9 @@ meta (global fields: status, created)

 **What this means:**
 - A `task` automatically has all `objective` fields AND all `meta` fields
-- Add a field to `meta` → every note gets it
-- No duplicate field definitions
+- Add a field to `meta` → every descendant type inherits it
+- A child can re-declare only the keys that differ; its explicit metadata and
+  structural keys override the inherited field, while omitted keys stay inherited

 ### 2. Types Link to Context (Relationships)

@@ -108,8 +109,10 @@ chapter: "Act One"          ← scene's parent can be a chapter
 ### Unique Type Names
 No two types can share a name. `type: task` is always unambiguous.

-### Single Inheritance
-A type has exactly one parent. No mixins, no multiple inheritance. Simple.
+### Single Inheritance, Explicit Composition
+A type has exactly one `extends` parent. Reusable `traits` provide separate
+also-has composition for cross-cutting field bundles; they do not create a
+second parent chain.

 ### Ownership is Optional
 Not everything needs to be owned. Use ownership for private/internal notes, skip it for shared resources.
@@ -143,8 +146,9 @@ When creating a type, the user decides:

 1. **What does it extend?** (determines inherited fields)
 2. **What fields does it add?** (its unique data)
-3. **Does it own children?** (private notes that live with it)
-4. **Is it recursive?** (can contain instances of itself)
+3. **Which traits does it compose?** (reusable cross-cutting fields)
+4. **Does it own children?** (private notes that live with it)
+5. **Is it recursive?** (can contain instances of itself)

 ---

@@ -162,6 +166,7 @@ Fields have a **prompt type** that determines how values are collected and what
 | `number` | Numeric input | `number` | Priority, word count, ratings |
 | `boolean` | Y/n confirm | `true`/`false` | Completed, archived, pinned |
 | `date` | Date input | `string` (YYYY-MM-DD) | Due dates, created dates |
+| `relative-date` | Structured JSON/object input | object or object list | Positions relative to another note's date |
 | `select` | Numbered picker | `string` or `string[]` | Status, category, tags |
 | `relation` | Picker from vault | `string` (wikilink) | Parent task, milestone, project |
 | `list` | Comma-separated input | `string[]` | Aliases, keywords |
@@ -200,13 +205,14 @@ Relation fields link to notes of a specific type (and its descendants):
 {
   "milestone": {
     "prompt": "relation",
-    "source": "milestone",
-    "format": "wikilink"
+    "source": "milestone"
   }
 }
 ```

-The picker shows only notes matching the `source` type constraint.
+The picker shows only notes matching the `source` type constraint. Relation
+storage uses the vault-wide `config.link_format`; version 2 fields do not carry
+a per-field `format` property.

 ### Field Inheritance

diff --git a/docs/product/vision.md b/docs/product/vision.md
index 4a05a29..2cffefb 100644
--- a/docs/product/vision.md
+++ b/docs/product/vision.md
@@ -120,8 +120,9 @@ The CLI should be predictable and learnable.

 - Small command surface (target: <15 top-level commands)
 - Consistent flags across commands
-- JSON mode for every command (AI/scripting friendly)
-- No hidden modes or surprising behavior
+- Machine-readable modes on commands that explicitly advertise them
+- Hidden compatibility commands stay documented as compatibility surfaces, not
+  presented as canonical workflows
 - Selection prompts use consistent input rules: number keys (1-9, 0) select and submit, arrow keys move selection, Enter submits the highlighted option
 - `audit --fix` behavior is conservative and documented (see `docs/product/audit-fix-policy.md`)

@@ -172,7 +173,7 @@ Bowerbird fails if:

 ## Inheritance Model

-Bowerbird uses strict type inheritance (design in progress).
+Bowerbird ships strict single-parent type inheritance.

 **Principles:**
 - All types inherit from `meta` (global fields)
@@ -216,11 +217,16 @@ Target: <15 top-level commands that cover all use cases.
 - `bwrb new` — Create notes with schema-driven prompts
 - `bwrb edit` — Modify existing note frontmatter
 - `bwrb list` — Query, resolve, search, and open notes
+- `bwrb recent` — List recently modified notes
 - `bwrb delete` — Remove notes with backlink warnings
 - `bwrb audit` — Validate notes against schema
 - `bwrb bulk` — Batch frontmatter operations
 - `bwrb schema` — Inspect and manage schema
 - `bwrb template` — Manage note templates
+- `bwrb dashboard` — Run and manage saved list queries
+- `bwrb init` — Initialize a vault
+- `bwrb config` — Manage the command-editable config subset
+- `bwrb completion` — Generate shell completion scripts

 **Schema and Template use unified verbs:**

@@ -245,13 +251,15 @@ bwrb template list [type] [name]   # List all, or show details if both provided
 - `search` and `open` remain hidden compatibility commands for existing scripts.
 - `edit` remains the canonical mutation surface; compatibility `search --edit`
   retains its established meaning.
-- The AI safety-net primitives (`list --fuzzy`, `audit: unlinked-mention`) are deferred to post-V1.0
+- The AI safety-net primitives (`list --fuzzy`, `unlinked-mention`,
+  `frequent-unlinked-term`, `schema discover`, and recurrence) are shipped.

 ### Design Principles

 1. **Consistent flags** — Same flag means same thing everywhere
 2. **Unified verbs** — `new`, `edit`, `delete`, and `list` carry the main note workflows
-3. **JSON mode everywhere** — `--output json` on all commands (see `docs/product/cli-output-contract.md`)
+3. **Explicit automation contracts** — command-specific `--output json` and
+   `--json` support with documented shapes (see `docs/product/cli-output-contract.md`)
 4. **Dry-run default for destructive ops** — `--execute` to apply (including auto audit fixes); use `--dry-run` to preview interactive audit fixes
 5. **Discoverable prompts** — Missing required info prompts, doesn't error

@@ -266,7 +274,8 @@ In short: docs-site is canonical for user-facing CLI behavior; `docs/product/` i
 Commands in `bwrb --help` are ordered to reflect the product's priority model and guide users through a logical workflow:

 1. **CRUD operations** — `new`, `edit`, `delete` (core note actions)
-2. **Query operations** — `list`, `open`, `search` (discovery and navigation)
+2. **Query operations** — `list`, `recent` (canonical discovery and navigation;
+   `open`/`search` are hidden compatibility commands)
 3. **Schema and management** — `schema`, `audit`, `bulk`, `template` (schema enforcement and maintenance)
 4. **Saved queries** — `dashboard` (saved configurations, follows template conceptually)
 5. **Meta/utility** — `init`, `config`, `completion`, `help` (one-time setup and operational commands)
@@ -282,15 +291,15 @@ This ordering presents commands as a guided path: create notes → find notes
 1. **Schema enforcement** — Hard on CLI, soft audit on drift
 2. **Inheritance model** — Full, consistent type inheritance
 3. **Core commands** — new, edit, list, audit, bulk, schema, template
-4. **JSON mode** — Every command scriptable
+4. **Automation contracts** — Machine-readable support and exact shapes are
+   documented per command
 5. **Migration tooling** — Rename fields, change select options, refactor types

 ### Post-V1.0

-- Schema expressiveness — aliases, traits, hierarchical scope
-- Ingest safety net — `list --fuzzy`, `audit: unlinked-mention` / `frequent-unlinked-term`, daily-note sweep
-- `schema discover` — deterministic field-usage facts over a folder
-- Task system — event-driven recurrence + offset templating
+- Further contract hardening and schema ergonomics
+- Completion and config/schema parity
+- Conservative audit and migration expansion as new schema capabilities ship

 ---

diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index 4a510a7..dc56114 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -22,7 +22,8 @@ bwrb finds the vault in this order:
 1. `--vault <path>` flag
 2. Find-up nearest ancestor containing `.bwrb/schema.json`
 3. `BWRB_VAULT` environment variable
-4. Current working directory (error if not a vault)
+4. Bounded find-down beneath the current directory: one candidate is selected;
+   multiple candidates prompt in a TTY or error in non-interactive/JSON mode

 Always verify you're targeting the correct vault before operations.

@@ -35,6 +36,7 @@ Create a new bwrb vault with `init`:
 bwrb init --yes

 # Initialize at specific path
+mkdir -p /path/to/vault
 bwrb init /path/to/vault --yes

 # Reinitialize existing vault (destructive)
@@ -44,11 +46,14 @@ bwrb init --force --yes
 bwrb init --yes --output json
 ```

+The target directory must already exist. `init` creates `.bwrb/` inside it; it
+does not create the vault directory itself.
+
 The command creates `.bwrb/schema.json` with:
 - Version 2 format
 - Default `wikilink` link format
 - Auto-detected Obsidian vault name (if `.obsidian/` exists)
-- Empty `types: {}` (add types with `bwrb schema type new`)
+- Empty `types: {}` (add types with `bwrb schema new type`)

 ## Schema Discovery

@@ -92,11 +97,21 @@ bwrb supports vault-wide configuration in `.bwrb/schema.json` under the `config`
 |--------|--------|---------|-------------|
 | `link_format` | `wikilink`, `markdown` | `wikilink` | Format for relation field links |
 | `date_format` | Pattern string | `YYYY-MM-DD` | Format for date fields |
+| `date_granularity` | `day`, `month`, `year` | `day` | Vault default for allowed partial-date precision |
 | `calendars` | Object | `{}` | Custom calendar registry for non-Gregorian date fields |
 | `open_with` | `system`, `editor`, `visual`, `obsidian` | `system` | Default --open behavior |
 | `editor` | Command string | `$EDITOR` | Terminal editor command |
 | `visual` | Command string | `$VISUAL` | GUI editor command |
+| `obsidian_vault` | String | auto | Obsidian vault name for URI opening |
+| `default_dashboard` | String | none | Dashboard run with no name |
 | `excluded_directories` | `string[]` | `[]` | Directory prefixes to exclude from discovery/targeting |
+| `mention_fuzzy_threshold` | Integer `0`–`5` | `2` | Fuzzy edit-distance cap for mention suggestions |
+| `mention_corpus_calibration` | Boolean | `true` | Dampen vault-common single-word targets |
+| `mention_corpus_min_notes` | Integer | `3` | Corpus damping minimum note count |
+| `mention_corpus_noncanonical_ratio` | Number `0`–`1` | `0.5` | Corpus damping casing threshold |
+| `mention_link_once` | Boolean | `false` | Limit auto-fixes to one link per note/target pair |
+| `mention_exclude_types` | `string[]` | `[]` | Types excluded from mention target indexing |
+| `mention_exclude_paths` | `string[]` | `[]` | Globs excluded from mention target indexing |

 ### Date Format

@@ -133,7 +148,7 @@ with `calendar` or type-level `calendar_default`:
 ```

 Calendar date strings use `<eraShort> <year>-<month>-<day> [<hour>:<minute>]`,
-for example `AR 3019-09-02 266:50`. JSON list output expands these fields as
+for example `AR 3019-01-02 266:50` for the one-month calendar above. JSON list output expands these fields as
 `{ value, calendar, linear }`; sort and `--where` compare the linear value.
 For calendar-anchored relative-date chains, `d` means the calendar's
 `hoursInDay`; `w` is rejected.
@@ -142,20 +157,28 @@ For calendar-anchored relative-date chains, `d` means the calendar's
 # View current config
 bwrb config list

-# Edit config option
-bwrb config edit date_format  # Interactive
-bwrb config edit date_format --json '"MM/DD/YYYY"'  # Non-interactive
+# Edit a command-supported config option
+bwrb config edit open_with --json '"editor"'

 # Exclude directories globally
 bwrb config edit excluded_directories --json '["Archive","Templates"]'
 ```

+`config list/edit` currently supports only `link_format`, `editor`, `visual`,
+`open_with`, `obsidian_vault`, `default_dashboard`, `excluded_directories`,
+`mention_exclude_types`, `mention_exclude_paths`, and `mention_link_once`.
+`date_format`, `date_granularity`, `calendars`, `mention_fuzzy_threshold`, and
+the `mention_corpus_*` keys are valid schema settings but are **schema-only**:
+edit `.bwrb/schema.json` and run `bwrb schema validate`. Do not send them to
+`bwrb config edit` (tracked in
+[#809](https://github.com/3mdistal/bwrb/issues/809)).
+
 ## Built-in Frontmatter Fields

-Some fields are written by bwrb regardless of schema:
+Some fields are recognized by bwrb regardless of schema:

 - `id`: reserved/system-managed UUID created by `bwrb new` and should not be edited.
-- `name`: written by `bwrb new` as the note title; `bwrb audit` does not treat it as an unknown field even if the schema does not declare it.
+- `name`: always allowed and used as an explicit identity when present. JSON creation persists the input `name`; interactive creation currently derives `_name` from the filename without persisting this key ([#813](https://github.com/3mdistal/bwrb/issues/813)).
 - `forked-from`: reserved immediate-source UUID for document lineage. It is not a wikilink. Agents may encounter hand-authored values, but must not set or modify it through ordinary `new --json`, `edit`, or template input.

 Create a document fork when preserving an earlier draft matters:
@@ -217,10 +240,14 @@ bwrb list --name "Projects/Duplicate.md" --open --app print --picker none
 # Target by stable id
 bwrb list --id "<uuid>" --output json

-# Full-text search in note content
+# Full-text search in the serialized Markdown file (including frontmatter today)
 bwrb list --body "search term" --output json
 ```

+Despite the historical `--body` name, current content matching includes YAML
+frontmatter. Use `--where` when you need a field-specific predicate; body-only
+masking is tracked in [#812](https://github.com/3mdistal/bwrb/issues/812).
+
 ### Relative-Date Fields

 Schema fields with `prompt: "relative-date"` store structured constraints, not
@@ -258,7 +285,18 @@ bwrb new task --json '{"name": "Task", "_body": "## Notes\n\n- Captured from a s
 bwrb new task --template epic --no-instances --json '{"name": "Ship feature"}'
 ```

-Some templates and schema types define **instance scaffolding** (child notes created alongside the main note). By default, `bwrb new` creates those instances; pass `--no-instances` to skip child creation.
+Some templates define **instance scaffolding** (child notes created alongside
+the main note). By default, `bwrb new` creates those instances; pass
+`--no-instances` to skip child creation. Every child is filed in its own type's
+configured `output_dir`, not beside the parent unless those directories happen
+to match.
+
+Instance defaults on fields whose resolved schema prompt is `date` evaluate the
+same relative date expressions as the parent (`@today+3d`, `today() + '7d'`).
+Date-looking defaults on non-date fields remain literal. Instance `defaults`
+and an explicit instance `filename` do **not** interpolate parent placeholders
+such as `{name}`; use literal child values or the child type's own filename
+pattern.

 When `bwrb new --json` runs instance scaffolding, the response includes an `instances` object with the created, skipped, and error lists. This object is omitted when `--no-instances` is set.

@@ -485,7 +523,7 @@ bwrb dashboard list --output json  # JSON output for scripting

 ## Best Practices

-1. **Always use `--output json`** for list/search/audit when parsing output
+1. **Use canonical `list --output json`** for note discovery and `audit --output json` for validation; avoid starting new automation on hidden compatibility `search`/`open`
 2. **Always use `--picker none`** to prevent interactive prompts blocking automation
 3. **Query schema first** before creating notes to understand required fields
 4. **Use `--json` input** for `new` and `edit` to avoid interactive prompts
diff --git a/docs/technical/inheritance.md b/docs/technical/inheritance.md
index 2411336..b5e3178 100644
--- a/docs/technical/inheritance.md
+++ b/docs/technical/inheritance.md
@@ -1,718 +1,46 @@
-# Bowerbird Inheritance Model
+# Inheritance Resolution Notes

-> Single inheritance + context relationships + ownership
+> Concise maintainer notes for the shipped version 2 schema resolver.

----
+User-facing behavior is canonical in the docs-site
+[Types and Inheritance](../../docs-site/src/content/docs/concepts/types-and-inheritance.md)
+and [Schema Reference](../../docs-site/src/content/docs/reference/schema.md).
+Product rationale lives in [Type System](../product/type-system.md).

-## Overview
+## Resolution layers

-Bowerbird uses a simple, consistent model for organizing notes:
+Types form a single-parent `extends` tree rooted at implicit `meta`. Effective
+fields are assembled in this precedence order, highest first:

-1. **Inheritance** — What a note IS (determines fields)
-2. **Context** — What a note SUPPORTS (determines relationships)
-3. **Ownership** — Whether a note is PRIVATE to its context (determines folder structure)
-
-These three concepts are orthogonal and compose cleanly.
-
----
-
-## Inheritance ("Is A")
-
-Every type extends exactly one parent. All types ultimately inherit from `meta`.
-
-```
-meta
-├── reflection
-│   ├── daily-note
-│   ├── idea
-│   └── learning
-├── objective
-│   ├── goal
-│   ├── project
-│   ├── milestone
-│   └── task
-├── draft
-│   ├── chapter
-│   ├── scene
-│   └── research
-└── entity
-    ├── person
-    ├── place
-    └── software
-```
-
-### Rules
-
-1. **Single inheritance only** — No multiple parents, no mixins
-2. **No cycles** — A type cannot extend its own descendant
-3. **`meta` is the root** — Implicitly created, cannot be deleted
-4. **`meta` cannot extend anything** — It's the top
-5. **Unique type names** — No two types can share a name, regardless of position in tree
-6. **Implicit extension** — Types without `extends` implicitly extend `meta`
-
-### Field Inheritance
-
-Child types inherit all fields from ancestors:
-
-```json
-{
-  "meta": {
-    "fields": {
-      "status": { "prompt": "select", "enum": "status", "default": "raw" },
-      "created": { "value": "$NOW" }
-    }
-  },
-  "objective": {
-    "extends": "meta",
-    "fields": {
-      "deadline": { "prompt": "text", "required": false }
-    }
-  },
-  "task": {
-    "extends": "objective",
-    "fields": {
-      "status": { "default": "inbox" },  // Override default only
-      "assignee": { "prompt": "relation", "source": "person" }
-    }
-  }
-}
-```
-
-A `task` note has:
-- `status` (from meta, default overridden to "inbox")
-- `created` (from meta)
-- `deadline` (from objective)
-- `assignee` (from task)
-
-### Field Override Rules
-
-Child types can only override **default values**, not field structure:
-
-| Can Override | Cannot Override |
-|--------------|-----------------|
-| `default` value | `prompt` type |
-| | `enum` reference |
-| | `required` status |
-| | `format` |
-
-If you need fundamentally different behavior, define a new field.
-
-### Type Field in Frontmatter
-
-Notes use the **leaf type name** (not full path):
-
-```yaml
-type: task
-```
-
-Full path is never needed because type names are unique.
-
-### Type Input in CLI
-
-CLI accepts the type name, validates uniqueness:
-
-```bash
-bwrb new task           # Works (unique name)
-bwrb new daily-note     # Works (unique name)
-```
-
-If somehow a name collision existed (schema validation should prevent this), CLI would error with suggestions.
-
----
-
-## Context ("Supports")
-
-Context fields link notes to what they support, without inheritance.
-
-### Examples
-
-**Task → Milestone:**
-```yaml
-type: task
-milestone: "[[Q1 Launch]]"
-```
-
-**Research → Draft:**
-```yaml
-type: research
-for: "[[My Novel]]"
-```
-
-**Scene → Chapter:**
-```yaml
-type: scene
-parent: "[[Chapter 1]]"
-```
-
-### Context Field Definition
-
-Any wikilink field can be a context relationship:
-
-```json
-{
-  "task": {
-    "extends": "objective",
-    "fields": {
-      "milestone": {
-        "prompt": "relation",
-        "source": "milestone",
-        "format": "wikilink",
-        "required": false
-      }
-    }
-  }
-}
-```
-
-### Source Types
-
-The `source` property controls what notes can be linked:
-
-```json
-// Specific type only
-"source": "milestone"
-
-// Any type in a branch (includes all descendants)
-"source": "objective"  // Accepts goal, project, milestone, task
-
-// Any note in the vault
-"source": "any"
-```
-
-Using a parent type (like `objective`) automatically includes all its descendants. No need to enumerate subtypes.
-
-### Single vs. Multiple
-
-Context fields can accept one or many values:
-
-```json
-// Single value (default)
-"milestone": {
-  "source": "milestone",
-  "multiple": false
-}
-
-// Multiple values
-"tags": {
-  "source": "any",
-  "multiple": true
-}
-```
-
----
-
-## Ownership ("Belongs To")
-
-Ownership determines whether notes are private to their context and where they live.
-
-### The `owned` Property
-
-The **parent** declares ownership of its children using `owned: true` on a context field:
-
-```json
-{
-  "draft": {
-    "extends": "meta",
-    "fields": {
-      "research": {
-        "prompt": "relation",
-        "source": "research",
-        "format": "wikilink",
-        "multiple": true,
-        "owned": true
-      },
-      "related-research": {
-        "prompt": "relation",
-        "source": "research",
-        "format": "wikilink",
-        "multiple": true,
-        "owned": false
-      }
-    }
-  }
-}
-```
-
-```yaml
-# My Novel.md
-type: draft
-research: ["[[Character Research]]", "[[World Building]]"]
-related-research: ["[[General Fantasy Tropes]]"]
-```
-
-- `Character Research` and `World Building` are **owned** by My Novel
-  - They live in `drafts/My Novel/research/`
-  - No other note can reference them in any schema field
-- `General Fantasy Tropes` is **not owned**
-  - It lives in `research/` (its default location)
-  - Other drafts can also reference it
-
-### Ownership Rules
-
-1. **Ownership is declared by the parent** — The field with `owned: true` is on the parent, not the child
-2. **Owned notes are exclusive** — An owned note cannot be referenced by ANY schema field on any other note
-3. **Owned notes colocate automatically** — They live in the owner's folder, in a subfolder by type
-4. **`owned: true` works with `multiple: true`** — A parent can own multiple children
-5. **Body wikilinks are unrestricted** — You can always link to any note in body text
-
-When creating owned notes via `bwrb new --owner`, the CLI also writes an `owner` frontmatter field
-to the child note (as a wikilink) for traceability. Ownership is still declared by the parent field.
-
-### Folder Structure Examples
-
-**Without ownership (flat by type):**
-```
-objectives/
-└── tasks/
-    ├── Fix login bug.md
-    ├── Update docs.md
-    └── Ship feature.md
-
-research/
-├── Character Research.md
-├── World Building.md
-└── General Fantasy Tropes.md
-```
-
-**With ownership (grouped by owner):**
-```
-drafts/
-├── Quick Thought.md                    # No owned children
-└── My Novel/                           # Has owned children
-    ├── My Novel.md
-    ├── research/
-    │   ├── Character Research.md       # Owned by My Novel
-    │   └── World Building.md           # Owned by My Novel
-    └── chapters/
-        ├── Chapter 1/
-        │   ├── Chapter 1.md
-        │   └── scenes/
-        │       ├── Opening.md
-        │       └── Climax.md
-        └── Chapter 2.md
-
-research/
-└── General Fantasy Tropes.md           # Shared, not owned
+```text
+own type fields > traits > inherited parent fields
 ```

-### Ownership vs. Shared References
-
-Choose based on your use case:
-
-| Use Case | Ownership | Field Config |
-|----------|-----------|--------------|
-| "This research is ONLY for this novel" | Owned | `owned: true` |
-| "This research is useful across drafts" | Shared | `owned: false` (or omit) |
-| "Link to related context without ownership" | Reference | Any field without `owned` |
-
-### Default Folder Computation
-
-When a note is NOT owned, its folder is computed from the type hierarchy:
-
-```
-type: task
-extends: objective
-extends: meta
-
-Default folder: objectives/tasks/
-```
-
-The path uses pluralized type names from the inheritance chain (excluding meta).
-
----
-
-## Recursion ("Self-Nesting")
-
-Some types can contain instances of themselves.
-
-### Enabling Recursion
-
-```json
-{
-  "task": {
-    "extends": "objective",
-    "recursive": true
-  }
-}
-```
-
-When `recursive: true`:
-- A `parent` field is implied (or can be explicitly defined)
-- `parent` accepts the same type (task → task)
-- Enables hierarchical queries
-
-### Parent Field
-
-The parent field for recursive types. Note that for recursion, the **child** declares its parent (inverse of ownership):
-
-```json
-{
-  "task": {
-    "extends": "objective",
-    "recursive": true,
-    "fields": {
-      "parent": {
-        "prompt": "relation",
-        "source": "task",      // Same type
-        "format": "wikilink",
-        "required": false
-      }
-    }
-  }
-}
-```
-
-For subtasks to live with their parent, the **parent task** would have an `owned: true` field pointing to child tasks. But in practice, recursive types often just use the parent reference for hierarchy without strict ownership.
-
-### Mixed Parent Types
-
-Some types can have a parent of a different type OR self-recurse:
-
-```json
-{
-  "scene": {
-    "extends": "draft",
-    "recursive": true,
-    "fields": {
-      "parent": {
-        "source": "chapter",   // Primary parent type
-        "format": "wikilink"
-      }
-    }
-  }
-}
-```
-
-This means:
-- A scene's parent can be a `chapter` (the defined source)
-- OR a scene's parent can be another `scene` (because recursive: true)
-
-### Cycle Detection
-
-Bowerbird prevents parent cycles that would create infinite loops:
-
-```yaml
-# Task A
-type: task
-parent: "[[Task B]]"
-
-# Task B
-type: task
-parent: "[[Task A]]"   # ERROR: Would create cycle A → B → A
-```
-
-**Behavior:**
-- `bwrb new` and `bwrb edit` check for cycles before saving
-- Self-references are blocked (a note cannot be its own parent)
-- Error message shows the full cycle path for debugging
-- `bwrb audit` also detects cycles in existing notes
-
-### Hierarchical Queries
-
-Recursion enables tree-based queries:
-
-```bash
-bwrb list task --tree              # Render as hierarchy
-bwrb list task --roots             # Only tasks with no parent
-bwrb list task --children-of "[[Epic]]"  # Direct children
-bwrb list task --descendants-of "[[Epic]]"  # All nested
-bwrb list task --depth 2           # Top 2 levels only
-```
-
----
-
-## Abstract vs. Concrete Types
-
-Types can be abstract (no direct instances) or concrete (has instances).
-
-### Inference Rules
-
-Bowerbird infers this from usage:
-
-1. **Has owned children** → Concrete (the parent instances exist)
-2. **Has notes with this exact type** → Concrete
-3. **Neither of the above** → Abstract
-
-### Query Behavior
-
-```bash
-# Abstract type: recursive by default
-bwrb list objective          # Returns tasks, milestones, goals, projects
-
-# Concrete type: exact by default
-bwrb list task               # Returns only tasks
-
-# Override with flags
-bwrb list objective --exact      # Only type: objective (probably none)
-bwrb list task --recursive       # Tasks and any task subtypes
-```
-
-### Output Clarity
-
-When listing an abstract type, output shows actual types:
-
-```
-$ bwrb list objective
-
-TYPE       NAME                 STATUS
-task       Fix login bug        in-flight
-task       Update docs          planned
-milestone  Q1 Launch            on-deck
-goal       Ship v1.0            raw
-```
-
----
-
-## Schema Structure
-
-### Full Example
-
-```json
-{
-  "enums": {
-    "status": ["raw", "inbox", "planned", "in-flight", "blocked", "done", "dropped"],
-    "draft-status": ["idea", "outlining", "drafting", "revising", "done"]
-  },
-
-  "types": {
-    "meta": {
-      "fields": {
-        "status": { "prompt": "select", "enum": "status", "default": "raw" },
-        "created": { "value": "$NOW" },
-        "modified": { "value": "$NOW" }
-      }
-    },
-
-    "reflection": {
-      "fields": {
-        "date": { "value": "$TODAY" }
-      }
-    },
-
-    "daily-note": {
-      "extends": "reflection"
-    },
-
-    "idea": {
-      "extends": "reflection"
-    },
-
-    "objective": {
-      "fields": {
-        "deadline": { "prompt": "text", "required": false }
-      }
-    },
-
-    "goal": {
-      "extends": "objective"
-    },
-
-    "project": {
-      "extends": "objective",
-      "fields": {
-        "goal": {
-          "prompt": "relation",
-          "source": "goal",
-          "format": "wikilink"
-        }
-      }
-    },
-
-    "milestone": {
-      "extends": "objective",
-      "fields": {
-        "project": {
-          "prompt": "relation",
-          "source": "project",
-          "format": "wikilink"
-        }
-      }
-    },
-
-    "task": {
-      "extends": "objective",
-      "recursive": true,
-      "fields": {
-        "status": { "default": "inbox" },
-        "milestone": {
-          "prompt": "relation",
-          "source": "milestone",
-          "format": "wikilink"
-        },
-        "subtasks": {
-          "prompt": "relation",
-          "source": "task",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        }
-      }
-    },
-
-    "draft": {
-      "fields": {
-        "draft-status": { "prompt": "select", "enum": "draft-status", "default": "idea" },
-        "chapters": {
-          "prompt": "relation",
-          "source": "chapter",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        },
-        "research": {
-          "prompt": "relation",
-          "source": "research",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        }
-      }
-    },
-
-    "chapter": {
-      "extends": "draft",
-      "recursive": true,
-      "fields": {
-        "scenes": {
-          "prompt": "relation",
-          "source": "scene",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        },
-        "subchapters": {
-          "prompt": "relation",
-          "source": "chapter",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        }
-      }
-    },
-
-    "scene": {
-      "extends": "draft",
-      "recursive": true,
-      "fields": {
-        "subscenes": {
-          "prompt": "relation",
-          "source": "scene",
-          "format": "wikilink",
-          "multiple": true,
-          "owned": true
-        }
-      }
-    },
-
-    "research": {
-      "extends": "draft"
-    },
-
-    "entity": {},
-
-    "person": {
-      "extends": "entity",
-      "fields": {
-        "email": { "prompt": "text" }
-      }
-    },
-
-    "place": {
-      "extends": "entity",
-      "fields": {
-        "location": { "prompt": "text" }
-      }
-    },
-
-    "software": {
-      "extends": "entity",
-      "fields": {
-        "url": { "prompt": "text" }
-      }
-    }
-  }
-}
-```
-
-### Validation Rules
-
-Bowerbird validates schemas on load:
-
-1. **No duplicate type names** — Error if two types share a name
-2. **No circular extends** — Error if A extends B extends A
-3. **Valid extends targets** — Referenced parent must exist
-4. **Valid source targets** — Referenced types in `source` must exist
-5. **Owned notes are exclusive** — Error if a note is referenced by multiple `owned: true` fields
-6. **Recursive implies ownership or parent** — Warning if `recursive: true` but no ownership field or parent-like field
-
----
-
-## Migration from Legacy Schema
-
-### Old Model (Legacy)
-
-```json
-{
-  "types": {
-    "objective": {
-      "subtypes": {
-        "task": {
-          "output_dir": "Objectives/Tasks",
-          "frontmatter": { ... }
-        }
-      }
-    }
-  }
-}
-```
-
-### New Model (Bowerbird)
-
-```json
-{
-  "types": {
-    "objective": { },
-    "task": {
-      "extends": "objective",
-      "fields": { ... }
-    }
-  }
-}
-```
-
-### Key Changes
-
-| Legacy | New |
-|--------|------|
-| Nested `subtypes` | Flat types with `extends` |
-| `output_dir` explicit | Computed from hierarchy + ownership |
-| `frontmatter` object | `fields` object |
-| `type` + `{type}-type` fields | Single `type` field |
-| Instance-grouped types | `owned: true` on parent's field |
-
-### Migration Steps
-
-1. Flatten nested subtypes into top-level types with `extends`
-2. Remove `output_dir` (let Bowerbird compute, or use colocation)
-3. Rename `frontmatter` to `fields`
-4. Update notes: remove `{type}-type` field, keep only `type` with leaf name
-
----
+- Parent fields are inherited through the ancestor chain.
+- Traits are composed in declaration order. A trait field fully replaces the
+  inherited field of the same name; a later trait replaces an earlier trait.
+- An own field fully replaces a colliding trait field.
+- An own field colliding directly with an inherited parent field is an
+  **explicit-key merge**: every locally declared key wins, including structural
+  keys such as `prompt`, `options`, `multiple`, `required`, and `source`; omitted
+  keys stay inherited.

-## Summary
+The resolver implementation is `computeEffectiveFields` in
+`src/lib/schema.ts`. Migration comparison uses each concrete type's effective
+old and new fields in `src/lib/migration/diff.ts`, so a parent change fans out
+only to descendants whose effective field actually changes.

-| Concept | Purpose | Mechanism |
-|---------|---------|-----------|
-| **Inheritance** | What a note IS | `extends` property, single parent |
-| **Context** | What a note SUPPORTS | Wikilink fields with `source` |
-| **Ownership** | Whether a note is PRIVATE | `owned: true` on parent's field |
-| **Recursion** | Self-nesting | `recursive: true` on type |
-| **Abstract/Concrete** | Query defaults | Inferred from usage |
+## Related systems

-The model is simple:
-- Inherit fields from one parent
-- Link to context via fields
-- Optionally own your children (they become private and colocate with you)
-- Body wikilinks are always unrestricted
+- `field_order` follows the same inheritance/trait/own layering unless a type
+  supplies a complete explicit order.
+- Relation `source` accepts a type name, an array of type names, or `any`; a
+  parent type source includes descendants.
+- Ownership is declared with `owned: true` on a relation field and is separate
+  from type inheritance.
+- Recursive note hierarchies use ordinary relation fields (typically `parent`)
+  and do not add a second type-inheritance mechanism.

-Everything else composes from these primitives.
+Do not mirror the complete user contract here. Update the canonical docs-site
+pages alongside resolver changes and keep this note focused on implementation
+topology. Fossils are charming in museums; less so in technical contracts.
diff --git a/schema.schema.json b/schema.schema.json
index e127ccc..3417e16 100644
--- a/schema.schema.json
+++ b/schema.schema.json
@@ -417,7 +417,7 @@
               }
             }
           ],
-          "description": "Type name(s) for relation and relative-date prompts. When a relation's value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the search command docs for the shortest-unambiguous-form rule."
+          "description": "Type name(s) for relation and relative-date prompts. When a relation's value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the canonical list resolution docs for the shortest-unambiguous-form rule."
         },
         "filter": {
           "type": "object",
diff --git a/src/types/schema.ts b/src/types/schema.ts
index 645dc91..a6c21a6 100644
--- a/src/types/schema.ts
+++ b/src/types/schema.ts
@@ -140,7 +140,7 @@ export const FieldSchema = z.object({
     .union([z.string(), z.array(z.string())])
     .optional()
     .describe(
-      'Type name(s) for relation and relative-date prompts. When a relation\'s value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the search command docs for the shortest-unambiguous-form rule.'
+      'Type name(s) for relation and relative-date prompts. When a relation\'s value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the canonical list resolution docs for the shortest-unambiguous-form rule.'
     ),
   // Filter conditions for type-based source queries
   // Applies frontmatter conditions to filter results (e.g., { status: { not_in: ["settled"] } })
diff --git a/docs-site/src/content/docs/reference/commands/init.md b/docs-site/src/content/docs/reference/commands/init.md
new file mode 100644
index 0000000..90add20
--- /dev/null
+++ b/docs-site/src/content/docs/reference/commands/init.md
@@ -0,0 +1,56 @@
+---
+title: bwrb init
+description: Initialize a new Bowerbird vault
+---
+
+Create a `.bwrb/` directory and a version 2 `.bwrb/schema.json` in a new vault.
+
+## Synopsis
+
+```bash
+bwrb init [options] [path]
+```
+
+The positional `path` is the directory to initialize. When it is omitted,
+`init` uses the global `--vault` target if supplied, otherwise the current
+directory. Unlike commands that open an existing vault, `init` does not run
+find-up or find-down discovery for its target. The target directory must already
+exist; `init` creates `.bwrb/` inside it, not the directory itself.
+
+## Options
+
+| Option | Description |
+| --- | --- |
+| `-y, --yes` | Skip prompts and use defaults |
+| `-f, --force` | Overwrite an existing `.bwrb/` directory |
+| `--output <format>` | `text` (default) or `json` |
+
+## Examples
+
+```bash
+# Initialize the current directory without prompts
+bwrb init --yes
+
+# Initialize a specific path
+mkdir -p ~/notes
+bwrb init ~/notes --yes
+
+# Use the global vault target
+bwrb --vault ~/notes init --yes
+
+# Machine-readable result
+bwrb init ~/notes --yes --output json
+
+# Replace existing Bowerbird configuration (destructive)
+bwrb init ~/notes --force --yes
+```
+
+`--force` can replace the existing `.bwrb/` configuration, so inspect the
+target carefully before using it. A normal `init` refuses to overwrite an
+existing configuration.
+
+## See Also
+
+- [Quick Start](/getting-started/quick-start/)
+- [Schema Reference](/reference/schema/)
+- [Installation](/getting-started/installation/)

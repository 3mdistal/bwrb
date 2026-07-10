# Final Fable verification follow-up

This is the final follow-up to your NON-BLOCKING review of the Bowerbird documentation parity diff.

The review points were checked against source and runtime evidence:
- v0.1.9..v0.2.0 has 81 first-parent merge commits including release PR #747, hence 80 non-release PRs.
- PRs #794, #797, and #801 are all in v0.2.2..v0.2.3.
- src/commands/audit.ts returns success from auto mode even when remaining issues exist; the nuance has been restored.
- a fresh built-CLI disposable-vault test produced AR 3019-02-02 266:50 and linear 4057466.8333333335.
- src/lib/output.ts declares JsonError.data?: unknown exactly.
- the Quick Start output order was captured from the built CLI.
- source inspection found -o means --output for schema migrate and dashboard, so the overbroad targeting claim has been corrected.
- the Quick Start now says to replace init's generated schema.
- the technical-note tonal aside was removed.

Review only the resolution diff below. Your first line MUST be exactly NO BLOCKERS or BLOCKERS. Report a blocker only for a remaining accuracy or contract contradiction.

## Resolution diff

diff --git a/docs-site/src/content/docs/getting-started/quick-start.md b/docs-site/src/content/docs/getting-started/quick-start.md
index f222f79..5b8bd53 100644
--- a/docs-site/src/content/docs/getting-started/quick-start.md
+++ b/docs-site/src/content/docs/getting-started/quick-start.md
@@ -7,24 +7,27 @@ This guide walks you through creating a vault with a schema and your first note.

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

-Create `.bwrb/schema.json`. Here's a minimal schema with two types:
+Replace the generated `.bwrb/schema.json` with this minimal schema containing
+two types:

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
@@ -32,11 +35,12 @@ Create `.bwrb/schema.json`. Here's a minimal schema with two types:
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
@@ -49,7 +53,8 @@ Create `.bwrb/schema.json`. Here's a minimal schema with two types:
           "options": ["low", "medium", "high"],
           "default": "medium"
         }
-      }
+      },
+      "field_order": ["type", "created", "status", "priority"]
     }
   }
 }
@@ -78,12 +83,18 @@ The result is a properly-structured markdown file:
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
@@ -180,25 +191,40 @@ Special values:

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
@@ -237,6 +263,7 @@ export BWRB_VAULT=~/notes
 | `bwrb bulk --type <type> --set key=value` | Apply frontmatter changes in bulk |
 | `bwrb template list [type]` | List templates for a type |
 | `bwrb dashboard [name]` | Run a saved query |
+| `bwrb init [path] --yes` | Initialize a vault with version 2 defaults |
 | `bwrb config list` | Show vault config values |
 | `bwrb completion <shell>` | Generate shell completion script |

diff --git a/docs-site/src/content/docs/reference/targeting.md b/docs-site/src/content/docs/reference/targeting.md
index d1f32bc..4e33a23 100644
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

@@ -302,7 +304,11 @@ See also: [CLI Safety and Flags](/concepts/cli-safety-and-flags/)

 ## Output Formats

-Use `--output <format>` (or `-o`) to control how results are displayed:
+Use the long `--output <format>` option when you want portable command syntax.
+On note workflows such as `new`, `edit`, `list`, and `recent`, `-o` means
+`--open`. A few management subcommands, including `schema migrate` and
+`dashboard run`, use `-o` for `--output`; check the command's help before using
+the short form.

 | Format | Description |
 |--------|-------------|
@@ -311,7 +317,7 @@ Use `--output <format>` (or `-o`) to control how results are displayed:
 | `paths` | File paths only |
 | `link` | Wikilinks (`[[Note Name]]`) |
 | `tree` | Hierarchical tree view (list only) |
-| `content` | Full file contents (search only) |
+| `content` | Full file contents (`list` and compatibility `search`) |

 ```bash
 bwrb list --type task --output json
diff --git a/docs/product/cli-output-contract.md b/docs/product/cli-output-contract.md
index c390f26..6cde948 100644
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
@@ -62,98 +57,29 @@ export interface JsonError {
   }>;
   code?: number;
 }
-
-export type JsonResult<T = unknown> = JsonSuccess<T> | JsonError;
-```
-
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
 ```

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
+The process exit code is authoritative; `code` is best-effort metadata. Clients
+must ignore unknown fields so compatible metadata can be added later.

-Exception: `bwrb audit --fix --auto` exits `0` after applying unambiguous fixes even if issues remain. Remaining issues are reported in the output summary and should be treated as follow-up work rather than a hard failure.
+One command-specific exception is deliberate: `audit --fix --auto` exits `0`
+after its preview or execution pass even when non-auto-fixable issues remain.
+Interactive `audit --fix` exits non-zero when issues remain. Consumers that need
+the remaining-issue count should parse the audit summary rather than infer it
+from the auto-fix process status.

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
diff --git a/docs/technical/inheritance.md b/docs/technical/inheritance.md
index 2411336..7e4675a 100644
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
+topology.

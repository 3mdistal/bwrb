# Changelog

All notable changes to Bowerbird are documented in this file.

## [Unreleased]

### Changed (Breaking)

- **Standardized `-o` flag to mean `--open` across all commands** (#239)
  - Commands with `--open` now support `-o` shorthand: `new`, `edit`, `list`, `search`
  - `-o` no longer means `--output` on any command
  - Use `--output` (spelled out) for output format on all commands
  - Migration: Replace `-o json` with `--output json` in scripts
  - Example: `bwrb list task -o json` → `bwrb list task --output json`
  - This improves CLI consistency: `-o` now always means "open" rather than having different meanings on different commands

- **`bwrb audit --fix` now applies fixes by default** (#346)
  - Use `--dry-run` to preview without writing
  - `--execute` is no longer required (accepted as deprecated no-op)
  - `--fix` requires explicit targeting (`--type`, `--path`, `--where`, `--body`, or `--all`)

- **Vault auto-detection now uses nearest `.bwrb/schema.json` (find-up)** (#337)
  - Precedence: `--vault` > find-up > `BWRB_VAULT` > `cwd` (error if not a vault)

### Added

- **Stable system-managed note IDs** (#334)
  - `bwrb new` writes an `id` (UUIDv4) to frontmatter
  - IDs are never reused (append-only registry in `.bwrb/ids.jsonl`)
  - Commands using targeting selectors support `--id <uuid>` for stable lookup

- **Interactive parent type selection in `schema new type`** (#240)
  - When creating a new type interactively, now prompts "Extend from type" with list of existing types
  - Shows "Root (extends meta)" option for creating standalone types
  - Displays inherited fields after parent selection to help users understand what they're inheriting
  - `--inherits` CLI flag still works for non-interactive/scripted usage

- **Audit --fix Phase 1: Core directory and type fixes** (#152, #268)
  - `wrong-directory` issues are now auto-fixable in `audit --fix --auto`
    - Files in wrong directories are automatically moved to correct location based on type
    - Wikilinks pointing to moved files are automatically updated
    - Use `--dry-run` to preview moves without writing
  - `owned-wrong-location` issues are now auto-fixable in `audit --fix --auto`
    - Owned notes in wrong locations are moved to correct owner's directory
    - Wikilinks are updated automatically
    - Use `--dry-run` to preview moves without writing
  - `invalid-type` issues now have interactive fix support
    - Prompts for type selection from available types
    - Shows suggestions for similar type names (typos)
  - `parent-cycle` issues now have interactive fix support
    - Detects cycles in recursive type parent references
    - Offers to clear parent field or select different parent
  - JSON output now includes additional issue metadata: `expectedDirectory`, `currentDirectory`, `cyclePath`, `ownerPath`, `ownedNotePath`

- **Audit --fix Phase 4: Structural integrity fixes** (#271)
  - `frontmatter-not-at-top`: move a single clean-parsing YAML frontmatter block to the top
  - `duplicate-frontmatter-keys`: auto-merge same/empty values; interactive keep-first/keep-last/skip when values differ
  - `malformed-wikilink`: deterministic bracket repairs for near-wikilinks in frontmatter only (scalars and list items)

### Changed

- **Consolidated CLI reference documentation** (#257)
  - Each top-level command (`config`, `schema`, `template`) now has a single comprehensive page
  - Subcommands are documented as sections with anchor links instead of separate pages
  - Reduces navigation depth and makes it easier to see all related functionality at a glance
  - Matches common CLI documentation patterns (e.g., git man pages)

### Added

- **Parent template instance scaffolding** (#75)
  - Templates can now define `instances` array to automatically create child notes when a parent note is created
  - `bwrb new` with instance-enabled templates creates all specified child files in the parent's directory
  - Added `--no-instances` flag to skip instance scaffolding when desired
  - CLI output shows created/skipped/failed instances with summary
  - JSON mode includes `instances` object with `created`, `skipped`, and `errors` arrays
  - Existing instance files are skipped (not overwritten) with a warning

- **Vault initialization command** (#188)
  - `bwrb init [path]` creates a new vault with `.bwrb/schema.json`
  - Interactive prompts for link format and editor preferences
  - Non-interactive mode with `--yes` for scripting
  - Auto-detects Obsidian vault name from `.obsidian/` directory
  - `--force` flag to reinitialize existing vaults
  - JSON Schema hosted at `https://bwrb.dev/schema.json` for editor support

- **Link normalization during schema migration** (#86)
  - When `config.link_format` changes in schema.json, `bwrb schema migrate` automatically normalizes all relation field links to the new format
  - Supports conversion between `wikilink` (`[[Note]]`) and `markdown` (`[Note](Note.md)`) formats
  - Changes are applied as part of the normal migration workflow with dry-run preview and backup

- **High-confidence stale reference auto-fix** (#86)
  - `bwrb audit --fix --auto` now automatically fixes stale references when exactly one similar file exists with high similarity
  - Uses Levenshtein distance (<=2) or prefix matching to determine high confidence
  - Low-confidence matches are still queued for manual review

### Changed

- **Audit body link validation deferred to v2.0** (#86)
  - Stale reference detection for body content (wikilinks in markdown body) is removed from v1.0 scope
  - Audit now only validates frontmatter relation fields, aligning with the documented type system scope
  - Body content links remain "unrestricted" per product vision; comprehensive body validation will be added in v2.0

### Fixed

- **Ignore slashes in note names when creating files** (#353)

- **Fixed markdown→wikilink conversion in link format migration** (#182)
  - `bwrb schema migrate` now correctly converts markdown links `[Note](Note.md)` to wikilinks `[[Note]]`
  - Previously, the conversion produced invalid output like `[[[Note](Note.md)]]`
  - Added `extractMarkdownLinkTarget()` utility function for parsing markdown link targets
  - Added comprehensive tests for link utilities and migration execution

### Changed (Breaking)

- **Renamed "enum" terminology to "option" for consistency with schema model** (#179)
  - Validation error type: `invalid_enum_value` → `invalid_option_value`
  - Audit issue code: `invalid-enum` → `invalid-option`
  - Export renamed: `suggestEnumValue()` → `suggestOptionValue()`
  - Background: Global enums were replaced with inline `options` on fields in #165. This aligns error terminology with the current schema model.
  - Migration: Scripts checking for `type: 'invalid_enum_value'` in JSON output should update to `type: 'invalid_option_value'`. Scripts using `--only invalid-enum` or `--ignore invalid-enum` should update to `invalid-option`.

### Added

- **Dashboard delete command** (#202)
  - `bwrb dashboard delete [name]` removes saved dashboards
  - Interactive picker when no name provided
  - Confirmation prompt (skip with `--force`)
  - JSON mode returns success/error with `wasDefault` indicator
  - Automatically clears default dashboard config when deleting the default

### Documentation

- **Complete command reference for all CLI commands** (#213)
  - Enhanced targeting reference with full selector documentation, command matrix, and safety gates
  - Updated all 13 command pages: `new`, `edit`, `list`, `search`, `open`, `delete`, `audit`, `bulk`, `schema`, `template`, `config`, `completion`, `dashboard`
  - Added subcommand pages for `schema` (list, validate, diff, migrate, history)
  - Added subcommand pages for `template` (list, new, edit, delete, validate)
  - Added subcommand pages for `config` (list, edit)
  - Comprehensive options tables with short flags (-t, -p, -w, -b, -x, -o)
  - Two-gate safety model documentation for destructive commands
  - JSON mode examples for scripting and automation
  - Cross-linked related commands throughout

### Changed (Internal)

- **Consolidated test schemas into shared fixtures** (#65)
  - Added `tests/ts/fixtures/schemas.ts` as single source of truth for test schemas
  - `BASELINE_SCHEMA`: Canonical realistic schema for most tests (inheritance, relations, ownership)
  - `MINIMAL_SCHEMA`: Fast tests needing just one type
  - `AUDIT_SCHEMA`, `PAGINATION_SCHEMA`: Special-case schemas for specific test scenarios
  - Composable functions: `withEntityPerson()`, `withBrokenRelation()`, `withTypes()`
  - Synced static fixture vault schema with `BASELINE_SCHEMA`
  - Removed duplicate `tests/fixtures/test_schema.json`
  - Migrated test files to import shared schemas instead of inline definitions

### Removed (Breaking)

- **Simple filter flags (`--status=active`, `--priority=high`, etc.) have been removed** (#220)
  - These deprecated flags are no longer supported on `list`, `search`, `bulk`, and `edit` commands
  - Use `--where` expressions instead:
    ```bash
    # Before (no longer works):
    bwrb list task --status=active
    bwrb bulk idea --priority=high --set reviewed=true
    
    # After:
    bwrb list task --where "status == 'active'"
    bwrb bulk idea --where "priority == 'high'" --set reviewed=true
    ```
  - Migration notes:
    - Equality: `--status=active` → `--where "status == 'active'"`
    - Negation: `--status!=active` → `--where "status != 'active'"`
    - Multiple values (OR): `--status=active,done` → `--where "status == 'active' || status == 'done'"`
    - Multiple filters (AND): `--status=active --priority=high` → `--where "status == 'active'" --where "priority == 'high'"`
  - Rationale: `--where` is more powerful (supports operators, functions, boolean logic), reduces flag proliferation, and provides a consistent query interface

### Added

- **`--verbose` flag for `schema list` to show all types with fields inline** (#146)
  - Shows complete schema overview with all types and their fields in a single view
  - Displays inheritance relationships: `task (extends objective) -> Objectives/Tasks`
  - Marks inherited fields with `(inherited)` annotation
  - Shows required fields with `[required]` marker
  - JSON mode: `--output json` returns structured data with `own_fields` and `inherited_fields` per type
  - Replaces need to run `schema list type <name>` for each type individually

- **Default dashboard configuration via `--set-default` flag** (#203)
  - `bwrb dashboard new my-tasks --type task --set-default` creates and sets as default
  - `bwrb dashboard edit my-tasks --set-default` sets existing dashboard as default
  - `bwrb config edit default_dashboard` allows setting/clearing default via config
  - When configured, `bwrb dashboard` (no args) runs the default instead of showing picker

- **`dashboard edit` command to modify existing dashboards** (#201)
  - `bwrb dashboard edit <name>` opens interactive editor with current values as defaults
  - `bwrb dashboard edit` (no args) shows picker to select dashboard
  - Flag-based editing: `--type`, `--where`, `--path`, `--body`, `--default-output`, `--fields`
  - JSON mode: `--json '{"type":"task"}'` replaces entire definition
  - Preserves unchanged fields when using flags

- **Dashboard picker and default dashboard support** (#198)
  - `bwrb dashboard` (no args) shows an interactive picker to select from saved dashboards
  - Picker shows dashboard names with type info (e.g., "my-tasks (task)")
  - Configure default dashboard in schema: `config.default_dashboard: "dashboard-name"`
  - Default dashboard runs automatically when configured
  - Graceful fallback: warns and shows picker if configured default doesn't exist
  - JSON mode: `--output json` returns list of available dashboards
  - Helpful message when no dashboards exist

- **`--save-as` flag for list command to save queries as dashboards** (#204)
  - `bwrb list --type task --where "status='active'" --save-as "active-tasks"` saves query as reusable dashboard
  - Saves all query parameters: type, path, where, body, output, and fields
  - Error if dashboard already exists (use `--force` to overwrite)
  - Confirmation message on stderr to keep stdout clean for piping
  - Run saved dashboards with `bwrb dashboard <name>`

- **Standardized `-x` shorthand for `--execute`** (#142)
  - Added `-x` as alias for `--execute` on `bulk`, `schema delete`, and `schema migrate` commands
  - Consistent with existing `-x` shorthand on `delete` command
  - Reduces keystrokes for common dry-run → execute workflow

- **Unified opener with config.open_with integration** (#183)
  - New `system` and `visual` app modes for opening notes
  - App modes: `system` (OS default), `editor` ($EDITOR), `visual` ($VISUAL), `obsidian`, `print`
  - Precedence chain: `--app` flag > `BWRB_DEFAULT_APP` env > `config.open_with` > `system`
  - Default changed from `obsidian` to `system` for broader compatibility
  - Obsidian vault name resolution: `config.obsidian_vault` > auto-detect from `.obsidian/` > folder basename
  - Updated help text across all commands (`open`, `search`, `list`, `edit`, `new`)

### Removed

- **Legacy enum migration operations** (#180)
  - Removed `EnumMigrationOpSchema` and related types (`add-enum-value`, `remove-enum-value`, `rename-enum-value`)
  - Removed enum-related `DetectedChange` variants
  - Removed `valueMappings` parameter from migration execution (was only used for enum value remapping)
  - Global enums were removed in #165; this cleans up the dead migration code
  - No user impact: enum migrations were never released

### Changed

- **Refactored global option handling** (#134)
  - Replaced brittle `cmd.parent?.parent?.opts()` chains with `getGlobalOpts()` helper
  - Uses Commander.js `optsWithGlobals()` for reliable option access at any nesting depth
  - Prevents silent breakage when command nesting changes during refactoring

### Fixed

- **Date macros now use local timezone** (#184)
  - `$TODAY`, `$NOW`, `today()`, `now()`, and `{date}` now use local time instead of UTC
  - Fixes off-by-one day errors when running commands in evening hours in timezones behind UTC
  - Consistent semantics: all user-facing dates are in local timezone

### Added

- **Global vault configuration system** (#184)
  - New `config` block in `schema.json` for vault-wide settings
  - `bwrb config list [option]` - View current configuration values
  - `bwrb config edit [option]` - Edit configuration interactively or with `--json`
  - Available options: `link_format`, `editor`, `visual`, `open_with`, `obsidian_vault`
  - Auto-detection of Obsidian vault name from `.obsidian` folder

- **Global link format configuration**
  - Replaces per-field `format` property with vault-wide `config.link_format`
  - Supported formats: `wikilink` (default), `markdown`
  - Wikilinks always quoted for YAML safety: `"[[Note]]"`
  - Markdown format: `"[Note](Note.md)"`
  - Audit system validates relation fields against configured format

- **Multi-select support for select fields** (#166)
  - Select fields can now allow multiple selections via `multiple: true`
  - Interactive prompt uses checkboxes (Space to select, Enter to confirm)
  - Values stored as YAML arrays: `tags: [urgent, blocked]`
  - Validation ensures all selected values are valid options
  - Example: `{ "tags": { "prompt": "select", "options": ["urgent", "blocked", "review"], "multiple": true } }`

- **New `boolean` field primitive** (#163)
  - Fields can now use `prompt: "boolean"` for yes/no values
  - Uses Y/n confirmation prompt during note creation
  - Stored as YAML boolean literals: `completed: true` or `archived: false`
  - Example: `{ "completed": { "prompt": "boolean", "default": false } }`

- **New `number` field primitive** (#164)
  - Fields can now use `prompt: "number"` for numeric values
  - Supports both integers and floating-point numbers
  - Stored as YAML number literals: `priority: 1` or `rating: 4.5`
  - Example: `{ "priority": { "prompt": "number", "default": 0 } }`

### Changed (Breaking)

- **Removed deprecated schema commands** (#143, #145)
  - `schema show` removed - use `schema list` or `schema list type <name>` instead
  - `schema add-type` removed - use `schema new type` instead
  - `schema add-field` removed - use `schema new field` instead
  - `schema remove-type` removed - use `schema delete type` instead
  - `schema remove-field` removed - use `schema delete field` instead
  - `schema edit-type` removed - use `schema edit type` instead
  - `schema edit-field` removed - use `schema edit field` instead
  - These commands were deprecated in v0.2.0 and have now been fully removed
  - The new unified verb pattern (`schema new/edit/delete/list`) is the canonical API

- **Renamed `input` prompt type to `text`** (#160)
  - The prompt type `input` has been renamed to `text` to describe the value type, not the UX
  - Update your schemas: `{ "prompt": "input" }` → `{ "prompt": "text" }`
  - CLI flag updated: `--type input` → `--type text`

- **Renamed `dynamic` prompt type to `relation`** (#161)
  - The prompt type `dynamic` has been renamed to `relation` (industry standard term)
  - Update your schemas: `{ "prompt": "dynamic" }` → `{ "prompt": "relation" }`
  - CLI flag updated: `--type dynamic` → `--type relation`

- **Renamed `multi-input` prompt type to `list`** (#162)
  - The prompt type `multi-input` has been renamed to `list` to describe the value type
  - Update your schemas: `{ "prompt": "multi-input" }` → `{ "prompt": "list" }`
  - Body sections also updated: `{ "prompt": "multi-input" }` → `{ "prompt": "list" }`
  - CLI flag updated: `--type multi-input` → `--type list`

- **Removed per-field `format` property in favor of global config** (#184)
  - The `format` property on field definitions has been removed
  - Link format is now configured globally via `config.link_format` in schema.json
  - Migration: Remove `format` from field definitions, add `config: { link_format: "wikilink" }` to schema root

- **Replaced global `enums` block with inline `options` on fields** (#165)
  - The global `enums` block has been removed from schema.json
  - Select fields now define their options inline: `{ "prompt": "select", "options": ["a", "b", "c"] }`
  - Removed CLI commands: `schema enum add`, `schema enum delete`, `schema enum list`, `schema enum edit`
  - CLI flag change: `--enum <name>` → `--options "a,b,c"` on `schema add-field`
  - Interactive prompts now ask "Enter options (comma-separated)" instead of "Enum to use"
  - Migration: Move enum values from `enums.<name>` to inline `options` arrays on each field
  - Example migration:
    ```json
    // Before (v1):
    { "enums": { "status": ["raw", "done"] }, "types": { "task": { "fields": { "status": { "prompt": "select", "enum": "status" }}}}}
    
    // After (v2):
    { "types": { "task": { "fields": { "status": { "prompt": "select", "options": ["raw", "done"] }}}}}
    ```

### Fixed

- **Audit similar files suggestions no longer match unrelated files**
  - Files with leading/trailing underscores (like `_daily-note`) no longer match everything
  - Short substrings embedded in words no longer cause false matches (e.g., "Jailbirds" no longer suggests "AI")
  - Levenshtein distance threshold now scales with string length to avoid weak matches like "README" → "Resume"

- **`new --json` now honors `--owner` and `--standalone` flags** (#138)
  - Previously, ownership flags were silently ignored in JSON mode, always creating pooled notes
  - `--owner "[[Note]]"` creates the note in the owner's folder
  - `--standalone` explicitly creates a pooled note (default behavior)
  - Using both flags together now returns a clear error
  - Invalid ownership scenarios (non-ownable type, non-existent owner, meaningless `--standalone`) return structured JSON errors

- **search/edit/open now find notes in gitignored type directories** (#149)
  - Previously, notes in type directories that were also in `.gitignore` or `schema.audit.ignored_directories` were invisible to `search`, `edit`, and `open` commands, while `list --type` could find them
  - Fix: navigation/search now uses hybrid discovery - type files ignore exclusion rules (matching `list --type` behavior), while unmanaged files still respect exclusions
  - This ensures consistency with the product principle "unified verbs"

- **Vault-wide audit now detects wrong-directory issues** (#147)
  - Previously, `bwrb audit` (without type) would not flag files in wrong directories
  - Root cause: vault-wide discovery didn't set internal metadata needed by the check
  - Fix: removed unnecessary condition since resolved type is available from frontmatter

### Added

- **Hierarchy functions for `--where` expressions** (#121)
  - `isRoot()` - Match notes with no parent
  - `isChildOf('[[Note]]')` - Match direct children of specified note
  - `isDescendantOf('[[Note]]')` - Match all descendants of specified note
  - Example: `bwrb list --type task --where "isDescendantOf('[[Epic]]') && status != 'done'"`
  - Functions work with recursive types and respect `--depth`/`-L` flag

- **`-L` alias for `--depth` flag** (#121)

- **`--type`/`-t` flag for `new` command** (#120)
  - Explicit type selection: `bwrb new --type task` or `bwrb new -t task`
  - Positional argument still works: `bwrb new task`

- **Recursive type support with cycle detection** (#95)
  - Types with `recursive: true` can now self-nest (e.g., tasks with subtasks)
  - Mixed hierarchies: recursive types that `extend` another type can have parent of either type
  - Eager cycle detection: `bwrb new` and `bwrb edit` block parent references that would create cycles
  - `source` field property now accepts an array of types for multi-type validation

- **Context field validation** (#99)
  - `bwrb new --json` and `bwrb edit --json` validate context field references
  - Validates that wikilink targets exist and match the field's `source` type constraint
  - `bwrb audit --fix` handles `invalid-source-type` issues interactively

- **Preview flag for open and search commands** (#98)
  - `bwrb open --preview` and `bwrb search --open --preview` show file contents in fzf picker
  - Uses `bat` for syntax highlighting when available, falls back to `cat`

- **Schema management CLI**
  - `bwrb schema new type/field/enum` - Create types, fields, and enums
  - `bwrb schema edit type/field/enum` - Modify existing schema elements (interactive)
  - `bwrb schema delete type/field/enum` - Remove schema elements (dry-run by default, `--execute` to apply)
  - `bwrb schema list [types|fields|enums]` - View schema overview or filter by category
  - Enum deletion blocks when enum is in use by fields (safety improvement)

- **Schema migration system**
  - `bwrb schema diff` - Shows pending changes between current schema and last-applied snapshot
  - `bwrb schema migrate` - Applies schema changes to existing notes (dry-run by default)
  - `bwrb schema history` - Shows migration history
  - Automatic change classification: deterministic (auto-apply) vs non-deterministic (requires confirmation)
  - Smart version suggestions based on change severity (major/minor/patch)
  - Backup by default when executing migrations (`--no-backup` to skip)
  - See `docs/product/migrations.md` for full documentation

- **Shell completion for bash, zsh, and fish**
  - `bwrb completion bash|zsh|fish` outputs shell scripts for tab completion
  - Completes commands, options, `--type` values (from schema), and `--path` values (vault directories)

- **Unified CLI targeting model**
  - All set-operating commands support four composable selectors: `--type`, `--path`, `--where`, `--body`
  - Selectors compose via AND: `bwrb list --type task --where "status='active'" --path "Projects/*"`
  - Smart positional detection: first argument auto-detected as type, path (contains `/`), or where expression
  - **`delete` command**: Supports bulk deletion with full targeting selectors and two-gate safety model

- **Targeting safety gate for `bulk` command**
  - Bulk operations require explicit targeting to prevent accidental vault-wide mutations
  - Must specify `--where` filter(s) OR use `--all` flag before any operation runs
  - Two-gate safety model: explicit targeting + explicit execution (`--execute`)

- **Ownership model for colocated notes**
  - Parent notes can declare ownership of child notes via `owned: true` on context fields
  - Owned notes are automatically colocated with their owner
  - `bwrb new` prompts for owner selection when creating ownable note types
  - Supports `--owner "[[Note Name]]"` and `--standalone` flags for non-interactive use
  - `bwrb audit` detects ownership violations

- **Context field type validation in audit**
  - `bwrb audit` validates that context fields reference notes of the correct type
  - New issue code: `invalid-source-type`

- **Custom plural names for folder computation**
  - Add `plural` property to type definitions for custom folder naming
  - Auto-pluralization fallback for types without explicit plural

- **Relative date expressions in template defaults**
  - Templates can use dynamic date expressions like `today()` or `today() + '7d'` in defaults
  - Supported functions: `today()` (YYYY-MM-DD), `now()` (YYYY-MM-DD HH:MM)
  - Supports addition/subtraction with duration literals: `'7d'`, `'1w'`, `'2h'`, `'30min'`, `'1mon'`, `'1y'`

- **`bwrb delete` command**
  - Delete notes from the vault with picker support
  - Interactive confirmation prompt (use `--force` to skip)
  - Backlink detection warns if other notes link to the file being deleted

- **`bwrb template delete` command**
  - Delete templates via CLI: `bwrb template delete <type> <name>`

- **Template constraints**
  - Templates can enforce stricter validation rules than the base schema
  - `constraints` section with `required`, `validate`, and `error` properties
  - `validate: "<expression>"` validates field values using expression syntax with `this` keyword

- **Body sections via `_body` in JSON mode**
  - The `--json` flag for `bwrb new` accepts a `_body` field to populate body sections
  - Section content can be string (for paragraphs) or string[] (for bullets/checkboxes)

- **Full-text content search**
  - `--body` / `-b` flag enables searching inside file contents using ripgrep
  - `--type <type>` restricts search to specific types
  - `--where <expr>` filters results by frontmatter expressions
  - `-C, --context <n>` controls context lines shown around matches

- **Template management commands**
  - `bwrb template list [type] [name]` - List templates or show specific template details
  - `bwrb template validate [type]` - Validate templates against schema
  - `bwrb template new <type>` - Create new templates interactively or via JSON
  - `bwrb template edit <type> <name>` - Edit existing templates

### Changed

- **Template command unified verbs** (#123)
  - `template list [type] [name]` - Shows template details when both args provided
  - `template new [type]` - Prompts for type if omitted
  - `template edit [type] [name]` - Shows template picker if args omitted
  - `template delete [type] [name]` - Shows template picker if args omitted

- **Unified search/open/edit commands** (#119)
  - `search` is the single note-resolution core with `--open` and `--edit` modes
  - `bwrb search "note" --edit` - Edit frontmatter of matching note
  - `bwrb search "note" --edit --json '{"status":"done"}'` - Non-interactive edit via JSON patch
  - `bwrb search "note" --open` - Open matching note
  - `open` and `edit` commands use unified targeting (`--type`, `--path`, `--where`, `--body`)

- **Unified verbs for schema commands** (#122)
  - New commands with consistent verb pattern: `schema new`, `schema edit`, `schema delete`, `schema list`

- **Unified `--output` flag for list and search commands** (#118)
  - `list` command: `--output <format>` with choices: `default`, `paths`, `tree`, `link`, `json`
  - `search` command: `--output <format>` with choices: `default`, `paths`, `link`, `content`, `json`
  - New `link` format outputs wikilinks (`[[Note Name]]`)

- **Ownership model completion**
  - `queryByType()` explicitly excludes owned notes from dynamic source results
  - Owned notes cannot be selected when populating frontmatter fields on other notes

### Removed

- **Global `enums` block and enum CLI commands** (#165)
  - `schema enum add`, `schema enum delete`, `schema enum list`, `schema enum edit` commands removed
  - Global `enums` block no longer supported in schema.json
  - Use inline `options` arrays on select fields instead
- **Hierarchy flags on `list` command** (#121) - Use `--where` with hierarchy functions instead
- **`--default` and `--instance` flags from `new` command** (#120)
- **Instance-grouped dead code** (#120) - ~500 lines of unused code removed
- **`dynamic_sources`** - Use type-based sources on fields instead

### Fixed

- **Removed incorrect positional type deprecation warnings from audit and bulk commands** (#127)
- **`bwrb schema add-field meta` now works correctly**
- **Better error messages for `--source` flag in dynamic fields**
- **`search --body` validates filter fields when `--type` is specified**
- **Fixed relative path calculation in file discovery**
- **PTY tests failing due to node-pty spawn-helper permissions**
- **Body sections skipped when using templates** - Now works alongside templates
- **Numbered select prompt flicker** - Uses differential updates instead of full re-render

## [0.1.2] - 2026-01-11

### Changed (Breaking)

- **`bwrb audit --fix` now applies fixes by default** (#352)
  - Use `--dry-run` to preview without writing
  - `--execute` is no longer required (accepted as deprecated no-op)
  - `--fix` requires explicit targeting (`--type`, `--path`, `--where`, `--body`, or `--all`)

- **Vault auto-detection now uses nearest `.bwrb/schema.json` (find-up)** (#347)
  - Precedence: `--vault` > find-up > `BWRB_VAULT` > `cwd` (error if not a vault)

- **Upgrade notes**
  - `bwrb audit --fix` writes by default; use `--dry-run` to preview. Example: `bwrb audit --fix --type task --dry-run`
  - If you rely on running from `cwd`, pass `--vault <path>` (or set `BWRB_VAULT`) to avoid “find-up” selecting a parent vault

### Added

- **Stable system-managed note IDs** (#351)
  - `bwrb new` writes an `id` (UUIDv4) to frontmatter
  - IDs are never reused (append-only registry in `.bwrb/ids.jsonl`)
  - Keep `.bwrb/ids.jsonl` with your vault backups to preserve ID continuity
  - Commands using targeting selectors support `--id <uuid>` for stable lookup

- **Configurable excluded directories** (#339)

- **Audit detection: trailing whitespace in raw frontmatter** (#341)

- **Audit --fix: migrate unknown fields** (#345)

- **Audit --fix Phase 4: structural integrity fixes** (#340)
  - `frontmatter-not-at-top`: move a single clean-parsing YAML frontmatter block to the top
  - `duplicate-frontmatter-keys`: auto-merge same/empty values; interactive keep-first/keep-last/skip when values differ
  - `malformed-wikilink`: deterministic bracket repairs for near-wikilinks in frontmatter only (scalars and list items)

- **Validate unknown fields in `--where` and `--fields`** (#326)

- **Schema validate warns when `output_dir` is missing** (#348)

### Fixed

- **Aligned JSON Schema with runtime schema** (#323)

- **Ignore slashes in note names when creating files** (#355)

- **Avoid truncated JSON output on `delete` errors** (#350)

- **`delete` falls back to help when query-parsed** (#360)

- **Add max attempts for UUID generation** (#361)

### Documentation

- **Document CLI flag semantics (`--force` vs `--execute`)** (#324)
- **Document audit trailing-whitespace in AI skill** (#357)
- **Define CLI JSON output + exit contract** (#362)

### Changed (Internal)

- **Stop exporting unused note-id helpers (Knip)** (#359)

## [0.2.0] - 2025-12-29

Complete rewrite from shell scripts to TypeScript with significant new features.

### Added

- **Template system** (`new` command)
  - Templates in `.bwrb/templates/{type}/{subtype}/*.md`
  - Auto-use `default.md` template when present
  - `--template <name>` to use specific template
  - `--no-template` to skip template system
  - Template defaults skip prompting for those fields
  - `prompt-fields` to force prompting even with defaults
  - Template body with `{field}` and `{date}` substitution
  - Full JSON mode support for automation

- **Navigation commands** (`open`, `search`)
  - `bwrb open [query]` - Open notes in Obsidian, editor, or system default
  - `bwrb search [query]` - Find notes and generate wikilinks
  - Picker modes: fzf, numbered select, or auto-detect
  - `BWRB_DEFAULT_APP` environment variable for default app mode

- **Bulk operations** (`bulk`)
  - Mass frontmatter changes with `--set`, `--remove`, `--rename` flags
  - `--move` flag to relocate files with automatic wikilink updates
  - Backup system for safe batch operations
  - Dry-run mode for previewing changes

- **Audit command** (`audit`)
  - Validate notes against schema definitions
  - Detect missing required fields, invalid enum values, stale references
  - `--fix` mode for interactive repairs
  - `--allow-field` for schema exceptions

- **JSON I/O mode**
  - `--json` and `--output json` flags for scripting/AI integration
  - Non-interactive mode for automation

- **Enhanced list command**
  - `--output paths` to show vault-relative paths
  - `--fields` flag for frontmatter table output
  - Inline filtering with query expressions

### Changed

- **TypeScript migration** - Complete rewrite from Bash to TypeScript
- **Strict TypeScript** - Enabled additional strict compiler options
- Unified prompt cancellation with explicit null contract

### Fixed

- Quoted-wikilink auto-fix no longer double-quotes values
- Unary `!` operator now works correctly in filter expressions
- `--open` flag on `new` command respects `BWRB_DEFAULT_APP`

## [0.1.0] - 2025-12-23

Initial release.

### Added

- Schema-driven note creation with `new` command
- Interactive type/subtype selection
- Dynamic frontmatter prompts (enums, text, vault queries)
- Configurable body sections
- Edit mode for existing files
- List command with type filtering
- Vault path resolution via `--vault`, `BWRB_VAULT`, or cwd

# Changelog

All notable changes to Bowerbird are documented in this file.

## [Unreleased]

### Added

- **Recursive type support with cycle detection** (#95)
  - Types with `recursive: true` can now self-nest (e.g., tasks with subtasks)
  - Mixed hierarchies: recursive types that `extend` another type can have parent of either type
    - Example: A `scene` extends `chapter` with `recursive: true` - parent can be a chapter OR another scene
  - Eager cycle detection: `bwrb new` and `bwrb edit` block parent references that would create cycles
    - Error message shows the full cycle path for debugging
  - `source` field property now accepts an array of types for multi-type validation
  - New `src/lib/hierarchy.ts` module with shared cycle detection utilities

- **Context field validation** (#99)
  - `bwrb new --json` and `bwrb edit --json` now validate context field references
  - Validates that wikilink targets exist and match the field's `source` type constraint
  - Returns `invalid_context_source` errors with details (field, value, expected types, actual type)
  - `bwrb audit --fix` now handles `invalid-source-type` issues interactively
  - Fix options: select valid replacement note, clear field, skip, or quit

### Changed

- **Ownership model completion** (bwrb-9g9/#88)
  - `queryByType()` now explicitly excludes owned notes from dynamic source results
  - Owned notes cannot be selected when populating frontmatter fields on other notes
  - `bwrb list` continues to show all notes including owned (for discoverability)
  - Added documentation for ownership visibility semantics in type-system.md

### Added

- **Schema management CLI** (bwrb-tsh)
  - `bwrb schema edit-type <name>` - Modify type settings (output directory, extends, filename pattern)
  - `bwrb schema remove-type <name>` - Remove a type from schema (dry-run by default, `--execute` to apply)
  - `bwrb schema edit-field <type> <field>` - Modify field properties (required, default, label)
  - `bwrb schema remove-field <type> <field>` - Remove a field from a type (dry-run by default)
  - All destructive operations show impact analysis (affected files, child types) before confirmation
  - Interactive mode for edit-field when no flags provided
  - Full JSON output support with `--output json`

- **Schema migration system** (bwrb-3nd)
  - `bwrb schema diff` - Shows pending changes between current schema and last-applied snapshot
  - `bwrb schema migrate` - Applies schema changes to existing notes (dry-run by default)
  - `bwrb schema history` - Shows migration history
  - Automatic change classification: deterministic (auto-apply) vs non-deterministic (requires confirmation)
  - Smart version suggestions based on change severity (major/minor/patch)
  - Backup by default when executing migrations (`--no-backup` to skip)
  - Schema snapshots stored in `.bwrb/schema.applied.json`
  - Migration history tracked in `.bwrb/migrations.json`
  - Supports field, enum, and type operations
  - See `docs/product/migrations.md` for full documentation

- **Shell completion for bash, zsh, and fish** (bwrb-nn8b)
  - `bwrb completion bash|zsh|fish` outputs shell scripts for tab completion
  - Completes commands, options, `--type` values (from schema), and `--path` values (vault directories)
  - Dynamic completions that always match the installed version
  - See README for installation instructions

- **Unified CLI targeting model** (bwrb-s8kt)
  - All set-operating commands now support four composable selectors: `--type`, `--path`, `--where`, `--text`
  - Selectors compose via AND: `bwrb list --type task --where "status=active" --path "Projects/*"`
  - Smart positional detection: first argument auto-detected as type, path (contains `/`), or where expression
  - **`list` command**: Added `--type`, `--path`, `--text` options; type positional now deprecated
  - **`bulk` command**: Added `--path`, `--text` options; type positional now deprecated
  - **`audit` command**: Added `--type`, `--where`, `--text` options
  - **`search` command**: Added `--path` option for glob filtering
  - **`delete` command**: Now supports bulk deletion with full targeting selectors
    - Two-gate safety model: requires explicit targeting + `--execute` flag
    - Dry-run by default shows files that would be deleted
    - Example: `bwrb delete --type task --where "status=done" --execute`
  - Deprecation warnings for type positional argument (use `--type` instead)
  - New shared targeting module (`src/lib/targeting.ts`) for consistent behavior

- **Targeting safety gate for `bulk` command** (bwrb-da6s)
  - Bulk operations now require explicit targeting to prevent accidental vault-wide mutations
  - Must specify `--where` filter(s) OR use `--all` flag before any operation runs
  - Without targeting: `bwrb bulk idea --set x=y` now errors with:
    `No files selected. Use --type, --path, --where, --text, or --all.`
  - With targeting: `bwrb bulk idea --all --set x=y` or `bwrb bulk idea --where "status == 'x'" --set x=y`
  - This implements the "two-gate safety model" from docs/product/cli-targeting.md:
    1. **Targeting gate**: Must specify explicit scope (`--where` or `--all`)
    2. **Execution gate**: Must use `--execute` to apply changes (existing behavior)
  - Help text updated to document the safety model
  - Note: Simple filters (`--status=raw`) are deprecated and do NOT satisfy the targeting gate

### Fixed

- **`bwrb schema add-field meta` now works correctly** (bwrb-tsbb)
  - Previously failed with `Type "meta" not found in raw schema` when meta was implicit
  - Now creates the meta type definition in schema.json when adding a field to implicit meta
  - Fields added to meta correctly inherit to all types as documented in type-system.md

### Improved

- **Better error messages for `--source` flag in dynamic fields** (bwrb-dbvv)
  - Detects when user provides an enum value instead of a type name
    - e.g., `"person" is a value in the "entity-type" enum, not a type name`
  - Detects legacy path format usage and suggests correct syntax
    - e.g., `Source "entity/person" uses path format. Use just the type name: "person"`
  - Suggests similar type names for typos (using fuzzy matching)
    - e.g., `Did you mean: project?`
  - Lists available types when no close match exists
  - Provides actionable hints for filtering by enum values

### Added

- **`bwrb schema add-field` command** (bwrb-tev)
  - Add fields to existing types via CLI without editing schema.json directly
  - Interactive mode: prompts for field name, prompt type, and relevant options
  - Non-interactive mode: use `--type`, `--enum`, `--source`, `--value` flags with `--output json`
  - Supports all prompt types: input, select, date, multi-input, dynamic, and fixed value
  - Validates field names (lowercase, alphanumeric with hyphens)
  - Prevents duplicate fields and overriding inherited fields
  - Automatically updates field_order and validates the schema
  - Shows inheritance notes when adding fields to parent types
  - Example: `bwrb schema add-field task priority --type select --enum priority`

- **PTY tests for schema add-type interactive wizard** (bwrb-h3xh)
  - Comprehensive coverage for the interactive type creation flow
  - Tests for all field wizard prompt types: input, select, date, multi-input, dynamic, fixed value
  - Cancellation tests at each step (extends, output dir, field wizard)
  - Field validation and retry behavior tests
  - Error handling tests (non-existent parent type, no enums for select, no types for dynamic)
  - Early completion tests (done immediately, answer no to add fields)

- **`bwrb schema add-type` command** (bwrb-w2a)
  - Create new type definitions via CLI without editing schema.json directly
  - Interactive mode: prompts for parent type, output directory, and field definitions
  - Non-interactive mode: use `--extends`, `--output-dir` flags with `--output json`
  - Field wizard supports all prompt types: input, select, date, multi-input, dynamic, and fixed value
  - Validates type names (lowercase, alphanumeric with hyphens, no reserved names)
  - Validates parent type exists before creating child type
  - Automatically updates schema.json and validates the result
  - Example: `bwrb schema add-type task --extends objective --output-dir Tasks`

- **`--open` flag for `search` and `list` commands** (bwrb-fkd)
  - `bwrb search "My Note" --open` - Search for a note and open it in Obsidian/editor
  - `bwrb list task --status=inbox --open` - Filter notes and pick one to open
  - `--app <mode>` flag specifies how to open: obsidian (default), editor, system, print
  - Respects `BWRB_DEFAULT_APP` environment variable
  - Works with both name search and content search modes
  - For `list`, uses picker when multiple results (in interactive mode)
  - The `open` command is now an alias for `search --open` (kept for backward compatibility)

### Breaking Changes

- **Removed `dynamic_sources` - use type-based sources instead** (bwrb-fqh)
  - The `dynamic_sources` section in schema.json is no longer supported
  - Schemas using `dynamic_sources` will error on load with a migration guide
  - **Migration**: Replace `source: "dynamic_source_name"` with `source: "type_name"` on fields
  - **Migration**: Move filter conditions from `dynamic_sources` to the field's `filter` property
  
  Before:
  ```json
  {
    "dynamic_sources": {
      "active_milestones": {
        "dir": "Objectives/Milestones",
        "filter": { "status": { "not_in": ["settled"] } }
      }
    },
    "types": {
      "task": {
        "fields": {
          "milestone": { "source": "active_milestones", "format": "wikilink" }
        }
      }
    }
  }
  ```
  
  After:
  ```json
  {
    "types": {
      "task": {
        "fields": {
          "milestone": {
            "source": "milestone",
            "filter": { "status": { "not_in": ["settled"] } },
            "format": "wikilink"
          }
        }
      }
    }
  }
  ```
  
  - Type-based sources automatically include descendant types (e.g., `source: "objective"` includes tasks, milestones)
  - Owned notes are excluded from source queries (they cannot be referenced by other notes)
  - Context field validation (`invalid-source-type` in audit) now works for all fields, not just type-based ones

### Added

- **Enum management commands** (bwrb-1kr)
  - `bwrb schema enum list` - Show all enums with their values and field usage
  - `bwrb schema enum add <name>` - Create a new enum (interactive or `--values` flag)
  - `bwrb schema enum update <name>` - Modify enum values (`--add`, `--remove`, `--rename`)
  - `bwrb schema enum delete <name>` - Delete an enum (refuses if in use, `--force` to override)
  - Full JSON output support with `--output json` for all enum commands
  - Validation: enum names must be alphanumeric with hyphens/underscores, values cannot contain commas or newlines
  - Note: Enum changes only update schema.json; use `bwrb bulk` or `bwrb audit --fix` to update existing notes

### Breaking Changes

- **Renamed project from ovault to bwrb**
  - CLI command: `ovault` -> `bwrb`
  - Config directory: `.ovault/` -> `.bwrb/`
  - Environment variables: `OVAULT_*` -> `BWRB_*`
    - `OVAULT_VAULT` -> `BWRB_VAULT`
    - `OVAULT_DEFAULT_APP` -> `BWRB_DEFAULT_APP`
    - `OVAULT_AUDIT_EXCLUDE` -> `BWRB_AUDIT_EXCLUDE`
  - **Migration required**: Rename `.ovault/` to `.bwrb/` in your vaults
  - **Migration required**: Update any scripts or shell configs using `OVAULT_*` environment variables

### Added

- **Ownership model for colocated notes** (bwrb-9g9)
  - Parent notes can declare ownership of child notes via `owned: true` on context fields
  - Owned notes are automatically colocated with their owner (e.g., `drafts/My Novel/research/`)
  - `bwrb new` prompts for owner selection when creating ownable note types
  - Supports `--owner "[[Note Name]]"` and `--standalone` flags for non-interactive use
  - `bwrb audit` detects ownership violations:
    - `owned-note-referenced`: Non-owner referencing an owned note
    - `owned-wrong-location`: Owned note not in expected folder location
  - New schema field: `owned: true` on dynamic source fields declares child ownership

- **Context field type validation in audit** (bwrb-taz)
  - `bwrb audit` now validates that context fields (wikilink fields with `source` property) reference notes of the correct type
  - New issue code: `invalid-source-type` - reports when a field references a note of the wrong type
  - Example: If a task's `milestone` field has `source: "milestone"`, audit will error if it links to a task instead
  - Supports parent types: `source: "objective"` accepts objectives and all descendants (task, milestone, etc.)
  - JSON output includes `expectedType` and `actualType` for debugging

- **Custom plural names for folder computation** (bwrb-2e1)
  - Add `plural` property to type definitions for custom folder naming
  - Example: `"research": { "plural": "research" }` → folder is `research/` not `researches/`
  - Auto-pluralization fallback for types without explicit plural (task → tasks, story → stories)
  - Default folder paths now computed from type hierarchy when no `output_dir` specified
  - Example: task (extends objective, extends meta) → `objectives/tasks/`

- **Relative date expressions in template defaults** (ovault-gqj)
   - Templates can now use dynamic date expressions like `today()` or `today() + '7d'` in defaults
   - Supported functions: `today()` (YYYY-MM-DD), `now()` (YYYY-MM-DD HH:MM)
   - Supports addition/subtraction with duration literals: `'7d'`, `'1w'`, `'2h'`, `'30min'`, `'1mon'`, `'1y'`
   - Date expressions are validated during `bwrb template validate`
   - Example template default: `deadline: "today() + '7d'"` sets deadline to 7 days from creation

- **`bwrb delete` command** (ovault-44z)
   - Delete notes from the vault: `bwrb delete [query]`
  - Query resolution with picker support (fzf, numbered, or auto-detect)
  - Interactive confirmation prompt (use `--force` to skip)
  - Backlink detection warns if other notes link to the file being deleted
  - JSON output mode with `--output json` (requires `--force`)
  - Completes the CRUD cycle for notes: new, edit, list, open, delete

- **`bwrb template delete` command** (ovault-3gb)
   - Delete templates via CLI: `bwrb template delete <type> <name>`
  - Interactive confirmation prompt (use `--force` to skip)
  - JSON output mode with `--output json`
  - Completes the template CRUD cycle (list, show, new, edit, delete)

### Breaking Changes

- **Duration unit for months changed from `m` to `mon`** (ovault-gqj)
  - Previously ambiguous: `m` could mean minutes or months
  - Now uses `mon` for months (e.g., `'1mon'` instead of `'1m'`)
  - Minutes remain `min` (e.g., `'30min'`)
   - **Migration required**: Update any `--where` expressions using `'1m'`, `'2m'`, etc. to `'1mon'`, `'2mon'`

- **Removed `name_field` from schema** (ovault-jxd)
   - The `name_field` property is no longer supported in schema definitions
   - All types now use a standard `"name"` field in JSON mode payloads
   - Interactive prompts show "Name:" for all types instead of custom labels
   - **Migration required**: Remove all `name_field` entries from your `.bwrb/schema.json`
  - **JSON API change**: Use `{"name": "My Note"}` instead of `{"Task name": "My Note"}`

### Added

- **Comprehensive integration tests for edit command** (ovault-deg)
  - New `edit.test.ts` with 27 tests covering file loading, type detection, body preservation, error handling, and JSON merge semantics
  - Tests for subtype detection (objective/task, objective/milestone)
  - Tests for body content preservation including checkboxes, special characters, wikilinks, and code blocks
  - Tests for frontmatter order preservation per schema definition
  - Edge case tests for paths with spaces, empty JSON patches, and deeply nested paths
  - Note: `--open` flag is tested via help text only (avoids triggering Obsidian during tests)

- **`includeTemplates` option for PTY test helpers** (ovault-a8o)
  - `withTempVault` and `withTempVaultRelative` now accept an options object with `includeTemplates`
  - Set `includeTemplates: true` to copy all templates from the fixture vault
  - Set `includeTemplates: ['idea', 'objective']` to copy only specific types
  - New `copyFixtureTemplates()` utility for manual template copying
  - Fully backwards compatible: existing tests using array syntax still work

### Fixed

- **`search --text` now validates filter fields when `--type` is specified** (ovault-ywr)
  - Simple filters like `--status=value` are now validated against the schema when using `--type`
  - Unknown field names and invalid enum values produce helpful error messages
  - Consistent behavior with the `list` command which already validates filters
  - Without `--type`, filters are not validated (no schema context available)

### Added

- **Template constraints** (ovault-31k)
  - Templates can now enforce stricter validation rules than the base schema
  - `constraints` section in template frontmatter with `required`, `validate`, and `error` properties
  - `required: true` makes optional fields required for that template
  - `validate: "<expression>"` validates field values using expression syntax with `this` keyword
  - `error: "<message>"` provides custom error messages when validation fails
  - Constraint validation runs after all prompts before creating the note
  - Full JSON mode support with detailed error reporting
  - Example: `constraints: { deadline: { required: true, validate: "this < today() + '7d'", error: "Deadline must be within 7 days" } }`

- **Parent templates for instance scaffolding** (ovault-5li)
  - Templates for instance-grouped types can now scaffold multiple files at once
  - `instances` array in template frontmatter specifies subtype files to create
  - Each instance supports: `subtype` (required), `filename` (optional), `template` (optional), `defaults` (optional)
  - Template names are resolved against the subtype's template directory
  - Existing files are skipped with a warning (not overwritten)
  - Full progress reporting in interactive mode
  - Example: `instances: [{ subtype: version, filename: "Draft v1.md" }, { subtype: research, template: seo }]`

- **`this` keyword in expression evaluation**
  - Expression system now supports `ThisExpression` node type for constraint validation
  - `this` refers to the current field value being validated

### Breaking Changes

- **Template location changed from `Templates/` to `.bwrb/templates/`** (ovault-33b)
   - Templates are now stored in `.bwrb/templates/{type}/{subtype}/*.md`
  - This keeps templates hidden from Obsidian's note browser and prevents accidental edits
  - Existing templates in `Templates/` will need to be migrated manually

- **Renamed `link` command to `search`** (ovault-boe)
   - `bwrb link` is now `bwrb search` with more flexible output options
  - Default output is now just the note name (previously was wikilink `[[Name]]`)
  - Use `--wikilink` flag to get the old default behavior
  - Removed `--bare` flag (name-only output is now the default)
  - JSON output structure changed: `target` -> `name`, `relativePath` -> `path`

### Added

- **Body sections via `_body` in JSON mode** (ovault-slq)
   - The `--json` flag for `bwrb new` now accepts a `_body` field to populate body sections
  - Eliminates the need to create a note, read it, then edit it to populate body content
  - Section content can be string (for paragraphs) or string[] (for bullets/checkboxes)
   - Example: `bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'`
  - Validates section names against schema and provides helpful error messages with available sections
  - Works with templates: body input is merged into template body

- **Full-text content search** (ovault-acb)
  - New `--text` / `-t` flag enables searching inside file contents using ripgrep
  - `--type <type>` restricts search to specific types (e.g., `--type task`)
  - `--where <expr>` filters results by frontmatter expressions
  - Simple filters (`--field=value`, `--field!=value`) for consistency with `list` command
  - `-C, --context <n>` controls context lines shown around matches (default: 2)
  - `--no-context` hides context lines
  - `-S, --case-sensitive` for case-sensitive matching (default: case-insensitive)
  - `-E, --regex` treats pattern as regex (default: literal string)
  - `-l, --limit <n>` caps maximum files returned (default: 100)
  - JSON output includes match details with line numbers and context
   - Example: `bwrb search "deploy" --text --type task --status!=done`

- **New `search` command output formats** (ovault-boe)
  - `--wikilink` - Output `[[Name]]` format for Obsidian links
  - `--path` - Output vault-relative path with extension
  - `--content` - Output full file contents (frontmatter + body)
  - Default output is just the note name (basename without .md)
  - Flags are mutually exclusive with priority: content > path > wikilink > name
  - Warning displayed when multiple format flags are provided

- **Multi-match JSON output for search** (ovault-boe)
  - In JSON mode, ambiguous queries now return all matches as success (instead of error)
  - Enables AI agents to discover notes without requiring exact matches
  - No query in JSON mode returns all notes in the vault
  - Use `--content` flag to include file contents in JSON output (opt-in to avoid large payloads)

- **New `template` command for template management** (ovault-33b)
   - `bwrb template list [type]` - List all templates or filter by type
   - `bwrb template show <type> <name>` - Show template details
   - `bwrb template validate [type]` - Validate templates against schema with full error reporting
   - `bwrb template new <type>` - Create new templates interactively or via JSON
   - `bwrb template edit <type> <name>` - Edit existing templates interactively or via JSON
  - Full validation: type path exists, defaults match field enums, prompt-fields reference valid fields
  - Typo suggestions using Levenshtein distance for field names and enum values
  - JSON mode support for all subcommands (`--output json` or `--json`)

### Changed

- **Consolidated file discovery logic** (ovault-5jk)
  - Moved duplicated file discovery functions from `audit/detection.ts` to shared `discovery.ts` module
  - Single source of truth for `discoverManagedFiles`, `collectAllMarkdownFiles`, `findSimilarFiles`, etc.
  - Added dedicated test suite for discovery module (31 tests)
  - Reduces code duplication by ~200 lines

- **Extracted `resolveAndPick` helper** (ovault-bjg)
  - DRYs up ~76 lines of duplicated query resolution + picker logic from `open` and `link` commands
  - Adds `exitWithResolutionError` helper for consistent error output with optional candidates list
  - Makes it easier to add new commands that need file selection

### Fixed

- **Fixed relative path calculation in file discovery** (ovault-acb)
  - Using `path.relative()` instead of string slicing for robust path handling
  - Fixes issues when vault path is specified as a relative path

- **PTY tests failing due to node-pty spawn-helper permissions** (ovault-ne9)
  - The node-pty npm package publishes `spawn-helper` binary without execute permission
  - Added postinstall script to fix permissions on macOS after `pnpm install`
  - PTY tests now run reliably instead of being skipped

### Changed

- **Standardized on pnpm as package manager**
  - Added `packageManager` field to package.json to enforce pnpm
  - Removed `package-lock.json` from repository (was stale and causing confusion)
  - Added `package-lock.json` to `.gitignore`

### Added

- **Comprehensive PTY test coverage** for all interactive prompt types
  - Text input prompts (`promptInput`, `promptRequired`)
  - Confirmation prompts (`promptConfirm`)
  - Multi-input prompts (`promptMultiInput`)
  - Selection with pagination (page navigation with +/-/=)
  - Full command flow tests for `new`, `edit`, and `audit --fix`
  - Cancellation behavior at every prompt point
  - Template selection and overwrite confirmation
  - Enhanced helpers: `typeText()`, `typeAndEnter()`, `waitForStable()`, temp vault utilities
  - Graceful skip when node-pty is unavailable (CI without TTY, etc.)

### Fixed

- **Body sections skipped when using templates** 
  - Previously, if a template had body content, schema-defined body_sections with prompts were completely skipped
  - Now, promptable body_sections work alongside templates: existing template content is shown, then user is prompted for additional items
  - Added items are appended to matching sections in the template
  - Sections not in template are added at the end of the body
  - Supports checkboxes, bullets, and paragraph content types

- **Numbered select prompt flicker** (ovault-18j)
  - Arrow key navigation now uses differential updates instead of full re-render
  - Only the changed lines (old/new selection) are updated
  - Eliminates visual flicker during navigation

## [0.2.0] - 2025-12-29

Complete rewrite from shell scripts to TypeScript with significant new features.

### Added

- **Template system** (`new` command)
  - Templates in `Templates/{type}/{subtype}/*.md`
  - Auto-use `default.md` template when present
  - `--template <name>` to use specific template
  - `--default` to require default template
  - `--no-template` to skip template system
  - Template defaults skip prompting for those fields
  - `prompt-fields` to force prompting even with defaults
  - Template body with `{field}` and `{date}` substitution
  - Full JSON mode support for automation

- **Navigation commands** (`open`, `link`)
  - `bwrb open [query]` - Open notes in Obsidian, editor, or system default
   - `bwrb search [query]` - Find notes and generate wikilinks
  - Picker modes: fzf, numbered select, or auto-detect
  - `OVAULT_DEFAULT_APP` environment variable for default app mode
  - PR #10

- **Bulk operations** (`bulk`)
  - Mass frontmatter changes with `--set`, `--remove`, `--rename` flags
  - `--move` flag to relocate files with automatic wikilink updates
  - Backup system for safe batch operations
  - Dry-run mode for previewing changes
  - PRs #8, #9

- **Audit command** (`audit`)
  - Validate notes against schema definitions
  - Detect missing required fields, invalid enum values, stale references
  - `--fix` mode for interactive repairs
  - `--allow-field` for schema exceptions
  - Format and stale detection
  - PR #7

- **JSON I/O mode**
  - `--input-json` and `--output json` flags for scripting/AI integration
  - Non-interactive mode for automation
  - PR #5

- **Enhanced list command**
  - `--paths` flag to show vault-relative paths
  - `--fields` flag for frontmatter table output
  - Inline filtering with query expressions
  - PR #1

- **CLI polish**
  - Improved help text across all commands
  - Number navigation for enum selection
  - Consistent Ctrl+C cancellation handling
  - PR #3

- **Integration tests**
  - Comprehensive test suite for all CLI commands
  - PR #4

### Changed

- **TypeScript migration** - Complete rewrite from Bash to TypeScript (PR #2)
- **Strict TypeScript** - Enabled additional strict compiler options (PR #6)
- Unified prompt cancellation with explicit null contract

### Fixed

- Quoted-wikilink auto-fix no longer double-quotes values
- Unary `!` operator now works correctly in filter expressions
- `--open` flag on `new` command respects `OVAULT_DEFAULT_APP`

## [0.1.0] - 2025-12-23

Initial release.

### Added

- Schema-driven note creation with `new` command
- Interactive type/subtype selection
- Dynamic frontmatter prompts (enums, text, vault queries)
- Configurable body sections
- Edit mode for existing files
- List command with type filtering
- Vault path resolution via `--vault`, `OVAULT_VAULT`, or cwd

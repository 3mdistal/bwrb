# Changelog

All notable changes to ovault are documented in this file.

## [Unreleased]

### Breaking Changes

- **Renamed `link` command to `search`** (ovault-boe)
  - `ovault link` is now `ovault search` with more flexible output options
  - Default output is now just the note name (previously was wikilink `[[Name]]`)
  - Use `--wikilink` flag to get the old default behavior
  - Removed `--bare` flag (name-only output is now the default)
  - JSON output structure changed: `target` -> `name`, `relativePath` -> `path`

### Added

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
  - Example: `ovault search "deploy" --text --type task --status!=done`

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
  - `ovault open [query]` - Open notes in Obsidian, editor, or system default
  - `ovault link [query]` - Generate wikilinks with shortest unambiguous form
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

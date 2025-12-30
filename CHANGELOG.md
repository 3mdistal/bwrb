# Changelog

All notable changes to ovault are documented in this file.

## [Unreleased]

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
  - Automatic skip when node-pty is incompatible (e.g., Node.js 25)

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

---
title: Changelog
description: Release history and notable changes
---

All notable changes to Bowerbird are documented here.

For the complete changelog with all details, see [CHANGELOG.md](https://github.com/3mdistal/bwrb/blob/main/CHANGELOG.md) in the repository.

## Recent Highlights

### Unreleased

### 0.3.0

- **Removed deprecated CLI surfaces** — `search` and `open`, legacy `list`
  aliases and hierarchy flags, `--text` aliases on mutating/audit commands,
  and legacy audit exclusion inputs now reject. Use the documented `list`,
  `--output`, `--body`, `--where`, `config.excluded_directories`, and
  `BWRB_EXCLUDE` replacements.

### 0.2.4

- **Existing-note lineage adoption** — `bwrb lineage adopt <child> --from <parent>` adds a dry-run-first, lock-coordinated path for recording known derivation between existing same-type notes without rewriting their bodies or ordinary metadata
- **Portable lineage mutation locking** — fork, adopt, delete, and note-ID coordination now have real cross-process stress coverage, a focused Windows CI lane, and stable retryable output when a non-force delete target disappears while waiting for its lock
- **Edit/lineage concurrency** — edit commits now share fork/adopt path locks, replay stale JSON patches from fresh bytes, and return stable retryable output without overwriting newer identity or provenance writes
- **Creation placement and identity parity** — interactive and JSON creation share canonical output-directory resolution and persist the supplied identity consistently
- **Body-only content targeting** — `--body` excludes YAML frontmatter while preserving original file line numbers and body-only match context
- **Date settings in config** — `config list/edit` exposes validated date format and granularity settings with deterministic canonical ISO storage
- **Completion parity** — shell completion tracks the visible command surface, real schema/template subcommands, and the full `recent` workflow

### 0.2.3

- **Relative-date fields** — position notes before, after, or equal to other notes, with query-time resolution and audit warnings for invalid chains
- **Custom calendars** — define fictional or alternative calendars for date validation, sorting, comparisons, JSON output, audit, and relative-date anchors
- **Lineage foundation** — reserved `forked-from`, per-field `reset_on_fork`, and audit checks for malformed IDs, dangling provenance, duplicate identities, and cycles establish the shared document-history contract (#802)
- **Document forks** — `bwrb new --fork <target>` creates an ordinary sibling note with a fresh ID and immutable immediate-source provenance
- **Fork lineage inspection** — `bwrb list --lineage <target>` renders the complete connected fork component, including sibling and cousin branches, as a tree, paths, links, content, or structured JSON
- **Fork-safe deletion** — `bwrb delete` refuses notes with direct fork children or duplicate identities unless forced, preserving child provenance for audit when the parent is deliberately removed
- **Unified note discovery** — `bwrb list` is the canonical surface for finding, filtering, inspecting, linking, and opening notes; `search` and `open` remain available for compatibility
- **JSON-mode reliability** — edit, open, and prompt-mode commands exit cleanly with one coherent JSON result even when stdin remains open

### 0.2.2

- **Mention target exclusions** — `mention_exclude_types` and `mention_exclude_paths` keep imported/reference notes out of unlinked-mention target pools while still scanning them as source documents
- **First-occurrence mention linking** — `mention_link_once` and `audit --fix --auto --mention-link-once` can limit auto-fixes to one new wikilink per note/target pair
- **Type-aware relation resolution** — bare wikilink relation refs now resolve against the field source type before treating same-name notes as ambiguous
- **Unlinked mention noise** — single-word note names require exact casing, common English single-word note names are skipped, aliases remain case-insensitive, and fuzzy suggestions use a length-scaled cap
- **Unlinked mention precision** — single-word names use full-vault corpus commonness damping and sentence-position guards to avoid casing-only false positives

### 0.2.1

- **Headless migration execution** — `schema migrate --execute` supports non-interactive `--yes` / `--set-version` workflows
- **Migration diff fixes** — prompt and date-granularity edits, inherited field structural overrides, and safe relation-source widenings are classified correctly
- **Vault path fixes** — global and relative vault paths now behave consistently across `init`, completion, and command cwd resolution
- **Write/audit parity** — relation writes, required defaults, and plain list prompts now agree with audit validation
- **Hierarchy and mention-noise fixes** — duplicate ancestor basenames no longer confuse hierarchy walks, and unlinked-mention audit skips structural headings

### 0.2.0

- **Traits** — Reusable field bundles you compose into types, instead of repeating fields per type
- **Hierarchical scope** — Contexts become first-class notes, plus an `under()` operator for "anywhere beneath this ancestor" relation queries
- **Fuzzy search** — `--fuzzy` scored note/entity lookup, wired into `--output content`, `--open`, and `--edit`
- **`recent` command** — List recently modified notes, with `--open` / `--save-as` and `file.*` sort keys
- **Partial dates** — Date fields accept `YYYY` and `YYYY-MM` precision via per-field granularity
- **Aliases** — Resolve and link a note by alternate names
- **Audit ingest safety net** — Unlinked-mention detection, body wikilink/file-link validation, and required body-section checks
- **Recurrence** — Event-driven recurrence with offset multi-spawn and successor name templates
- Plus a deep audit / migration / ownership hardening wave and several performance wins (see [CHANGELOG.md](https://github.com/3mdistal/bwrb/blob/main/CHANGELOG.md))

### 0.1.9

- **Self-documenting schema** — Add a `description` to any type, field, or `select` option; `bwrb schema list` (and its `--output json`) surfaces them, so the schema itself documents what each type/field/option is for
- **`list --sort`, `--limit`, `--count`** — Sort by a frontmatter field, cap rows, or print just the match count
- **Schema discovery aliases** — Shorthand forms for navigating types in `schema list`
- **Raw `_body` in JSON note creation** — Supply a note body directly when creating notes via JSON
- **Actionable template validation** — `template` surfaces concrete, fixable health warnings
- Fixes: unsafe-filename warnings, `edit --json` output handling, `list` tree hierarchy, and a batch of `new`/`edit`/`delete`/`search`/`bulk` JSON-mode correctness fixes

### Earlier highlights

- **Dashboard queries** — Save and run queries with `--save-as` and `bwrb dashboard`
- **Unified opener** — Consistent `--app` modes across commands
- **Multi-select fields** — Select multiple options with `multiple: true`
- **Boolean and number primitives** — New field types

### Breaking Changes

- Removed deprecated schema commands (use unified verb pattern)
- Renamed `input` prompt to `text`
- Renamed `dynamic` prompt to `relation`

---

*See the [full changelog](https://github.com/3mdistal/bwrb/blob/main/CHANGELOG.md) for complete details.*

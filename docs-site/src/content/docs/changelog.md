---
title: Changelog
description: Release history and notable changes
---

All notable changes to Bowerbird are documented here.

For the complete changelog with all details, see [CHANGELOG.md](https://github.com/3mdistal/bwrb/blob/main/CHANGELOG.md) in the repository.

## Recent Highlights

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

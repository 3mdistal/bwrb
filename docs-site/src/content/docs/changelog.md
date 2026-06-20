---
title: Changelog
description: Release history and notable changes
---

All notable changes to Bowerbird are documented here.

For the complete changelog with all details, see [CHANGELOG.md](https://github.com/3mdistal/bwrb/blob/main/CHANGELOG.md) in the repository.

## Recent Highlights

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

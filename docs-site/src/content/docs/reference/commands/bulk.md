---
title: bwrb bulk
description: Batch frontmatter operations
---

Perform batch operations on multiple notes with targeting and safety gates.

## Synopsis

```bash
bwrb bulk [options] [target]
```

The target argument is auto-detected as type, path (contains `/`), or where expression.

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type |
| `-p, --path <glob>` | Filter by file path (supports globs) |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable, ANDed) |
| `-b, --body <query>` | Filter by body content |
| `-a, --all` | Target all files (requires explicit intent) |

### Operations

| Option | Description |
|--------|-------------|
| `--set <field>=<value>` | Set field value (or clear with `--set field=`) |
| `--rename <old>=<new>` | Rename field |
| `--delete <field>` | Delete field |
| `--append <field>=<value>` | Append to list field |
| `--remove <field>=<value>` | Remove from list field |
| `--move <path>` | Move files to path (auto-updates wikilinks) |

### Execution

| Option | Description |
|--------|-------------|
| `-x, --execute` | Actually apply changes (dry-run by default) |
| `--backup` | Create backup before changes |
| `--limit <n>` | Limit to n files |

### Output

| Option | Description |
|--------|-------------|
| `--verbose` | Show detailed changes per file |
| `--quiet` | Only show summary |
| `--output <format>` | Output format: `text`, `json` |

## Safety: Two-Gate Model

Bulk operations require **two explicit gates** to prevent accidents:

1. **Targeting gate**: Specify selectors (`--type`, `--path`, `--where`, `--body`) OR use `--all`
2. **Execution gate**: Use `--execute` to apply changes (dry-run by default)

```bash
# Error: no targeting specified
bwrb bulk --set status=done
# "No files selected. Use --type, --path, --where, --body, or --all."

# Dry-run: shows what would change
bwrb bulk --type task --set status=done

# Actually applies changes
bwrb bulk --type task --set status=done --execute
```

## Examples

### Set Operations

```bash
# Set field on matching notes
bwrb bulk --type task --where "status == 'in-progress'" --set status=done --execute

# Clear a field
bwrb bulk --type task --set old_field= --execute

# Set multiple fields
bwrb bulk --type task --where "status == 'done'" --set archived=true --set "archived-date=2025-01-15" --execute
```

### Field Management

```bash
# Rename a field
bwrb bulk --all --rename old-field=new-field --execute

# Delete a field
bwrb bulk --type task --delete legacy_field --execute
```

### List Field Operations

```bash
# Append to a list field
bwrb bulk --type task --where "priority == 'high'" --append tags=urgent --execute

# Remove from a list field
bwrb bulk --type task --remove tags=deprecated --execute
```

### File Movement

```bash
# Move files to archive (updates wikilinks automatically)
bwrb bulk --type idea --where "status == 'settled'" --move Archive/Ideas --execute
```

### Targeting

```bash
# By type
bwrb bulk --type task --set status=done --execute

# By path
bwrb bulk --path "Archive/**" --set archived=true --execute

# By content
bwrb bulk --body "TODO" --set needs-review=true --execute

# By frontmatter
bwrb bulk --where "status == 'active' && priority < 3" --set urgent=true --execute

# All files
bwrb bulk --all --set reviewed=true --execute
```

### Safety Options

```bash
# Create backup before changes
bwrb bulk --type task --all --set status=archived --execute --backup

# Limit scope
bwrb bulk --type task --set status=done --execute --limit 10

# Preview with verbose output
bwrb bulk --type task --set status=done --verbose
```

## Migration Workflows

```bash
# Bulk-add type to existing files by location
bwrb bulk --path "Reflections/Daily Notes" --set type=daily-note --execute

# Find files with legacy frontmatter
bwrb list --where "!isEmpty(old_field)"
# Warning: 'old_field' not in schema

# Rename field across all notes of a type
bwrb bulk --type task --rename old_field=new_field --execute
```

## See Also

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — `--execute` vs `--force` semantics
- [Targeting Model](/reference/targeting/) — Full selector reference
- [bwrb audit](/reference/commands/audit/) — Validate notes
- [bwrb delete](/reference/commands/delete/) — Delete notes


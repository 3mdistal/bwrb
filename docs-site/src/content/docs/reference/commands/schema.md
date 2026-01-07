---
title: bwrb schema
description: Schema introspection and management
---

Inspect and manage your vault's schema definition.

## Synopsis

```bash
bwrb schema <subcommand>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [list](#list) | List schema contents |
| [validate](#validate) | Validate schema structure |
| [diff](#diff) | Show pending schema changes |
| [migrate](#migrate) | Apply schema changes to notes |
| [history](#history) | Show migration history |

## Quick Examples

```bash
# List all types
bwrb schema list

# Show specific type details
bwrb schema list type task

# Validate schema structure
bwrb schema validate

# Preview migration
bwrb schema diff

# Apply migration
bwrb schema migrate --execute
```

---

## list

List schema contents including types, fields, and detailed type information.

### Synopsis

```bash
bwrb schema list [options]
bwrb schema list types [options]
bwrb schema list fields [options]
bwrb schema list type [options] <name>
```

### Subcommands

| Subcommand | Description |
|------------|-------------|
| (none) | Show full schema overview |
| `types` | List type names only |
| `fields` | List all fields across all types |
| `type <name>` | Show details for a specific type |

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

### Examples

```bash
# Show full schema overview
bwrb schema list

# List all type names
bwrb schema list types

# List all fields across types
bwrb schema list fields

# Show details for a specific type
bwrb schema list type task
bwrb schema list type objective/milestone

# JSON output for scripting
bwrb schema list --output json
bwrb schema list type task --output json
```

---

## validate

Validate your schema.json file for structural correctness.

### Synopsis

```bash
bwrb schema validate [options]
```

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

### Description

Validates the schema.json file against the expected structure:

- Required fields are present
- Field types are valid
- Enum values are properly defined
- Type hierarchies are consistent
- Output directories are specified

### Examples

```bash
# Validate schema
bwrb schema validate

# JSON output for CI
bwrb schema validate --output json
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Schema is valid |
| `1` | Validation errors found |

---

## diff

Show changes to the schema since the last migration.

### Synopsis

```bash
bwrb schema diff [options]
```

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

### Description

Compares the current schema.json against the last migration snapshot to show:

- New types added
- Types removed
- Fields added to types
- Fields removed from types
- Field definitions changed
- Enum values changed

### Examples

```bash
# Show what changed
bwrb schema diff

# JSON output for scripting
bwrb schema diff --output json
```

### Workflow

1. Make changes to `.bwrb/schema.json`
2. Run `bwrb schema diff` to preview changes
3. Run `bwrb schema migrate` to apply changes to existing notes

---

## migrate

Apply schema changes to existing notes in your vault.

### Synopsis

```bash
bwrb schema migrate [options]
```

### Options

| Option | Description |
|--------|-------------|
| `-x, --execute` | Actually apply the migration (default is dry-run) |
| `--no-backup` | Skip backup creation (not recommended) |
| `-o, --output <format>` | Output format: `text`, `json` |

### Description

Migrations update existing notes when the schema changes:

- Add new required fields with default values
- Remove deleted fields
- Rename fields
- Update enum values
- Move files to new output directories

### Safety

- **Dry-run by default**: Shows what would change without modifying files
- **Automatic backup**: Creates a backup before applying changes
- **Atomic operations**: All changes succeed or none are applied

### Examples

```bash
# Preview migration (dry-run)
bwrb schema migrate

# Apply migration with backup
bwrb schema migrate --execute

# Apply without backup (not recommended)
bwrb schema migrate --execute --no-backup
```

### Workflow

1. Make changes to `.bwrb/schema.json`
2. Run `bwrb schema diff` to preview changes
3. Run `bwrb schema migrate` to preview note updates
4. Run `bwrb schema migrate --execute` to apply

---

## history

View the history of schema migrations applied to your vault.

### Synopsis

```bash
bwrb schema history [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--limit <n>` | Number of entries to show (default: 10) |
| `-o, --output <format>` | Output format: `text`, `json` |

### Description

Shows a log of all migrations that have been applied:

- Migration timestamp
- Changes included
- Files affected

### Examples

```bash
# Show migration history
bwrb schema history

# Show last 5 migrations
bwrb schema history --limit 5

# JSON output
bwrb schema history --output json
```

---

## See Also

- [Schema concepts](/concepts/schema/) — Understanding schema structure
- [Migrations](/concepts/migrations/) — Migration workflow
- [bwrb audit](/reference/commands/audit/) — Validate notes against schema

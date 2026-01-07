---
title: Migrations
description: Safely evolve your schema over time
---

Schemas evolve. Bowerbird provides tools to migrate your notes when your schema changes, keeping your vault consistent without manual edits.

## Why Migrations?

When you modify your schema, existing notes may become inconsistent:

- **Rename a field** — Old notes still use the old name
- **Remove a select option** — Notes may reference invalid values
- **Rename a type** — Notes live in the wrong directory
- **Remove a field** — Old notes have orphaned data

Migrations update existing notes to match the new schema.

## Core Principles

Bowerbird's migration system follows four principles:

1. **Migrations are explicit** — You intentionally trigger migrations; they don't run automatically
2. **Safe by default** — Dry-run mode shows what would change before applying
3. **Backup by default** — A backup is created before changes are applied
4. **Git handles history** — Bowerbird tracks current and last-applied states; use Git for deeper history

:::note[Bowerbird + Git]
Bowerbird focuses on schema management, not version control. It integrates cleanly with Git — you handle versioning, Bowerbird handles schema enforcement. Separate concerns, clean workflow.
:::

## Migration Workflow

The typical workflow has four steps:

### 1. Modify Your Schema

Edit `.bwrb/schema.json` to make your changes (add fields, rename types, etc.).

### 2. Check What Changed

Run `bwrb schema diff` to see pending changes:

```bash
bwrb schema diff
```

```
Pending Schema Changes

Deterministic changes (will be auto-applied):
  + Add field "importance" to type "idea"
  + Add field "source" to type "idea"

Non-deterministic changes (require confirmation):
  - Remove field "priority" from type "idea"

Note: Schema version is still 1.0.0.
You'll be prompted to update it when running `bwrb schema migrate --execute`.

Run `bwrb schema migrate` to preview the migration.
Run `bwrb schema migrate --execute` to apply changes.
```

### 3. Preview the Migration

Run `bwrb schema migrate` (without `--execute`) to see what would happen:

```bash
bwrb schema migrate
```

```
Migration Preview (Dry-Run)

Deterministic changes (will be auto-applied):
  + Add field "importance" to type "idea"
  + Add field "source" to type "idea"

Non-deterministic changes (require confirmation):
  - Remove field "priority" from type "idea"
Files scanned: 4
Files affected: 0

Run `bwrb schema migrate --execute` to apply these changes.
```

### 4. Apply the Migration

When ready, execute the migration:

```bash
bwrb schema migrate --execute
```

This will:
1. Prompt for a new schema version
2. Create a backup (unless `--no-backup` is passed)
3. Apply changes to affected notes
4. Save the new schema snapshot
5. Record the migration in history

## Change Classifications

Bowerbird classifies schema changes into two categories:

### Deterministic Changes

These can be applied automatically without user input:

| Change | Notes Don't Need Updates Because... |
|--------|-------------------------------------|
| Add field | Missing fields are valid (fields aren't required by default) |
| Add select option | Existing values remain valid |
| Add type | No existing notes to update |

### Non-Deterministic Changes

These require confirmation because they affect existing data:

| Change | What Happens |
|--------|--------------|
| Remove field | Field is removed from affected notes |
| Rename field | Field name is updated in affected notes |
| Remove select option | Affected notes flagged for review |
| Rename type | Notes are moved to the new directory |
| Remove type | Existing notes become orphaned (warning) |

## Version Suggestion

When you run `bwrb schema migrate --execute`, Bowerbird suggests a version bump based on your changes:

| Change Severity | Version Bump | Example |
|-----------------|--------------|---------|
| Breaking (removals, renames) | Major | 1.0.0 → 2.0.0 |
| Additions | Minor | 1.0.0 → 1.1.0 |
| No structural changes | Patch | 1.0.0 → 1.0.1 |

You can accept the suggestion or enter your own version.

## Storage and Files

Bowerbird stores migration state in `.bwrb/`:

```
.bwrb/
├── schema.json           # Current schema (you edit this)
├── schema.applied.json   # Last successfully migrated schema
├── migrations.json       # History of applied migrations
└── backups/              # Timestamped backups before migrations
```

- **schema.json**: Your current schema definition
- **schema.applied.json**: Snapshot from the last migration — used to compute diffs
- **migrations.json**: Log of all migrations with timestamps and changes
- **backups/**: Timestamped directories containing pre-migration file copies

## History and Recovery

### Viewing History

See past migrations with:

```bash
bwrb schema history
bwrb schema history --limit 5
```

### Recovery Options

Bowerbird does not have a rollback command. Instead:

1. **Use Git** — Commit your schema and notes together. Roll back with `git checkout` or `git revert`
2. **Use backups** — Migrations create backups in `.bwrb/backups/`
3. **Fix forward** — Make additional schema changes and run another migration

This design keeps Bowerbird focused on schema management while Git handles version control.

## First-Time Setup

When you first use migrations on a vault:

```bash
bwrb schema diff
```

```
No previous schema snapshot found.

This is either a new vault or migrations haven't been used yet.
Run `bwrb schema migrate --execute` to create the initial snapshot.
```

Run the initial migration to establish a baseline:

```bash
bwrb schema migrate --execute
```

```
Initial schema snapshot created (version 1.0.0)

Future schema changes will be tracked from this point.
```

## Best Practices

### Commit Schema with Migrations

Keep `schema.json` and affected notes in the same commit:

```bash
# Make schema changes, then:
bwrb schema migrate --execute
git add .bwrb/ Notes/
git commit -m "Rename priority to importance"
```

### Always Preview First

Never run `--execute` without previewing:

```bash
bwrb schema diff          # What changed in the schema?
bwrb schema migrate       # What will happen to notes?
bwrb schema migrate --execute  # Apply when ready
```

### Use Meaningful Versions

Your schema version communicates intent:

- **Major** (2.0.0): Breaking changes that affect how notes are used
- **Minor** (1.1.0): New capabilities, backward compatible
- **Patch** (1.0.1): Fixes or clarifications

### Let Git Handle History

Don't rely on `.bwrb/migrations.json` for rollback. It's for reference, not recovery. Keep your vault in Git.

## Command Reference

| Command | Purpose |
|---------|---------|
| [`bwrb schema diff`](/reference/commands/schema/diff/) | Show pending schema changes |
| [`bwrb schema migrate`](/reference/commands/schema/migrate/) | Preview or apply migrations |
| [`bwrb schema history`](/reference/commands/schema/history/) | View migration history |

## Next Steps

- [Schema Reference](/reference/schema/) — Full schema format documentation
- [Validation and Audit](/concepts/validation-and-audit/) — Finding and fixing inconsistencies
- [Bulk Operations](/reference/commands/bulk/) — Batch frontmatter changes

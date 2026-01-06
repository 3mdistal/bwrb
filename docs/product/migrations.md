# Schema Migrations

Schema migrations enable safe evolution of vault schemas by detecting changes, generating migration plans, and applying them to existing notes.

## Core Principles

1. **Migrations are explicit** - Users must intentionally bump the schema version and execute migrations
2. **Safe by default** - Dry-run mode shows what would change before applying
3. **Backup by default** - Migrations create backups unless explicitly skipped
4. **Git handles history** - Bowerbird maintains only current and last-applied schema states; deeper history is Git's responsibility

## Schema Versioning

Schemas include a `schemaVersion` field for tracking content versions:

```json
{
  "version": 2,
  "schemaVersion": "1.0.0",
  "types": { ... }
}
```

- `version`: Format version (internal, managed by Bowerbird)
- `schemaVersion`: User-controlled semantic version for tracking schema evolution

## Commands

### `bwrb schema diff`

Shows pending changes between the current schema and the last-applied snapshot.

```bash
bwrb schema diff
bwrb schema diff --json
```

Output categorizes changes as:
- **Deterministic**: Can be auto-applied (field additions, enum additions, type additions)
- **Non-deterministic**: Require user input (field removals, enum value removals, type removals)

### `bwrb schema migrate`

Applies schema changes to existing notes.

```bash
# Dry-run (default) - shows what would change
bwrb schema migrate

# Execute migration - prompts for new version, creates backup, applies changes
bwrb schema migrate --execute

# Skip backup (power users)
bwrb schema migrate --execute --no-backup
```

When executing:
1. Shows pending changes
2. Prompts for new schema version (suggests based on change severity)
3. Creates backup (unless `--no-backup`)
4. Applies changes to affected notes
5. Saves schema snapshot
6. Records migration in history

### `bwrb schema history`

Shows migration history.

```bash
bwrb schema history
bwrb schema history --json
```

## Migration Types

### Field Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add field | Deterministic | No action needed (field absent in old notes is valid) |
| Remove field | Non-deterministic | Removes field from affected notes |
| Rename field | Non-deterministic | Renames field in affected notes |
| Add select option | Deterministic | No action needed |
| Remove select option | Non-deterministic | Prompts for value mapping |
| Rename select option | Non-deterministic | Updates references in notes |

### Type Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add type | Deterministic | No action needed |
| Remove type | Non-deterministic | Orphans existing notes (warning) |
| Rename type | Non-deterministic | Moves notes to new directory |
| Reparent type | Non-deterministic | May require directory restructuring |

## Workflow Example

```bash
# 1. Make schema changes (interactively add a field)
bwrb schema new field task

# 2. Check what changed
bwrb schema diff
# Output:
# Deterministic changes:
#   + Add field "assignee" to type "task"
# Suggested version: 1.0.0 -> 1.1.0

# 3. Preview migration
bwrb schema migrate
# Output:
# Dry-run mode - no changes will be made
# 0 notes would be affected (field additions don't require note changes)

# 4. Apply migration
bwrb schema migrate --execute
# ? Enter new schema version [1.1.0]: 1.1.0
# Creating backup...
# Migration complete: 1.0.0 -> 1.1.0
```

## Storage

Bowerbird stores migration-related files in `.bwrb/`:

```
.bwrb/
├── schema.json           # Current schema
├── schema.applied.json   # Last successfully migrated schema (snapshot)
└── migrations.json       # History of applied migrations
```

## Version Suggestion Logic

- **Major bump** (1.0.0 -> 2.0.0): Breaking changes like type/field/enum removals
- **Minor bump** (1.0.0 -> 1.1.0): Additions (new types, fields, enum values)
- **Patch bump** (1.0.0 -> 1.0.1): No structural changes (rare)

## Best Practices

1. **Commit schema changes with migrations** - Keep schema.json and migration results in the same commit
2. **Review diffs before executing** - Always run `bwrb schema diff` or `bwrb schema migrate` (dry-run) first
3. **Use meaningful versions** - Bump major version for breaking changes that affect how notes are used
4. **Backup important vaults** - While Bowerbird creates backups, Git provides additional safety

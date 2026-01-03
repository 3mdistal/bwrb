# Schema Migrations

Schema migrations enable safe evolution of vault schemas by detecting changes, generating migration plans, and applying them to existing notes.

## Core Principles

1. **Migrations are explicit** - Users must intentionally bump the schema version and execute migrations
2. **Safe by default** - Dry-run mode shows what would change before applying
3. **Backup by default** - Migrations create backups unless explicitly skipped
4. **Git handles history** - Pika maintains only current and last-applied schema states; deeper history is Git's responsibility

## Schema Versioning

Schemas include a `schemaVersion` field for tracking content versions:

```json
{
  "version": 2,
  "schemaVersion": "1.0.0",
  "types": { ... },
  "enums": { ... }
}
```

- `version`: Format version (internal, managed by Pika)
- `schemaVersion`: User-controlled semantic version for tracking schema evolution

## Commands

### `pika schema diff`

Shows pending changes between the current schema and the last-applied snapshot.

```bash
pika schema diff
pika schema diff --json
```

Output categorizes changes as:
- **Deterministic**: Can be auto-applied (field additions, enum additions, type additions)
- **Non-deterministic**: Require user input (field removals, enum value removals, type removals)

### `pika schema migrate`

Applies schema changes to existing notes.

```bash
# Dry-run (default) - shows what would change
pika schema migrate

# Execute migration - prompts for new version, creates backup, applies changes
pika schema migrate --execute

# Skip backup (power users)
pika schema migrate --execute --no-backup
```

When executing:
1. Shows pending changes
2. Prompts for new schema version (suggests based on change severity)
3. Creates backup (unless `--no-backup`)
4. Applies changes to affected notes
5. Saves schema snapshot
6. Records migration in history

### `pika schema history`

Shows migration history.

```bash
pika schema history
pika schema history --json
```

## Migration Types

### Field Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add field | Deterministic | No action needed (field absent in old notes is valid) |
| Remove field | Non-deterministic | Removes field from affected notes |
| Rename field | Non-deterministic | Renames field in affected notes |

### Enum Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add enum value | Deterministic | No action needed |
| Remove enum value | Non-deterministic | Prompts for value mapping |
| Rename enum value | Non-deterministic | Updates references in notes |

### Type Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add type | Deterministic | No action needed |
| Remove type | Non-deterministic | Orphans existing notes (warning) |
| Rename type | Non-deterministic | Moves notes to new directory |
| Reparent type | Non-deterministic | May require directory restructuring |

## Workflow Example

```bash
# 1. Make schema changes
pika schema add-field task --name assignee --prompt input

# 2. Check what changed
pika schema diff
# Output:
# Deterministic changes:
#   + Add field "assignee" to type "task"
# Suggested version: 1.0.0 -> 1.1.0

# 3. Preview migration
pika schema migrate
# Output:
# Dry-run mode - no changes will be made
# 0 notes would be affected (field additions don't require note changes)

# 4. Apply migration
pika schema migrate --execute
# ? Enter new schema version [1.1.0]: 1.1.0
# Creating backup...
# Migration complete: 1.0.0 -> 1.1.0
```

## Storage

Pika stores migration-related files in `.pika/`:

```
.pika/
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
2. **Review diffs before executing** - Always run `pika schema diff` or `pika schema migrate` (dry-run) first
3. **Use meaningful versions** - Bump major version for breaking changes that affect how notes are used
4. **Backup important vaults** - While Pika creates backups, Git provides additional safety

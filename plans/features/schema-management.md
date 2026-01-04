# Schema Management CLI

> Interactive schema exploration and manipulation — never touch JSON directly

---

## Overview

The `bwrb schema` command provides full CLI control over the schema:

- Explore types, fields, and enums
- Add, edit, and remove types (with inheritance via `--extends`)
- Manage fields on types
- Handle migrations when schema changes

The goal is to **never require direct JSON editing**.

### Design Principles

- **Inheritance model**: All types extend from `meta` (explicitly or implicitly). A "subtype" is just a type with `--extends <parent>`.
- **Global enums**: Enums are schema-level resources referenced by fields. Composability comes from choosing which fields to include on which types.
- **Dry-run by default**: Destructive operations show what would change and prompt for confirmation. Use `--execute` to skip the prompt.
- **Migration integration**: Schema changes that affect existing files flow through `schema diff` → `schema migrate`.

---

## Command Surface

```bash
# Exploration
bwrb schema show                          # Tree view of all types
bwrb schema show task                     # Show specific type
bwrb schema validate                      # Validate schema structure

# Type management
bwrb schema add-type <name>               # Create new type (--extends for inheritance)
bwrb schema edit-type <name>              # Modify type settings
bwrb schema remove-type <name>            # Remove type (dry-run + prompt)

# Field management
bwrb schema add-field <type> [field]      # Add field to type
bwrb schema edit-field <type> <field>     # Modify field properties
bwrb schema remove-field <type> <field>   # Remove field (dry-run + prompt)

# Enum management
bwrb schema enum list                     # List all enums
bwrb schema enum add <name>               # Create new enum
bwrb schema enum update <name>            # Modify enum (--add, --remove, --rename)
bwrb schema enum delete <name>            # Remove enum

# Migration
bwrb schema diff                          # Show pending migrations
bwrb schema migrate                       # Apply migrations
bwrb schema history                       # Show migration history
```

---

## Schema Exploration

### Show All Types

```bash
bwrb schema show

# Schema v3
# 
# Enums:
#   status     inbox, backlog, planned, in-progress, done, cancelled
#   priority   low, medium, high, critical
# 
# Types:
#   meta                             (base type)
#     Fields: status, scopes, tags
#   
#   objective        extends: meta   Objectives/
#     Fields: type
#   
#   task             extends: objective   Objectives/Tasks/   [pooled]
#     Fields: milestone, deadline, priority
#     Inherited: status, scopes, tags, type
#   
#   milestone        extends: objective   Objectives/Milestones/   [pooled]
#     Fields: start-date, end-date
#     Inherited: status, scopes, tags, type
#   
#   idea             extends: meta   Ideas/   [pooled]
#     Fields: type, priority
#     Inherited: status, scopes, tags
```

### Show Specific Type

```bash
bwrb schema show task

# Type: task
# Extends: objective
# 
# Directory: Objectives/Tasks/
# Mode: pooled
# 
# Inherited Fields (from objective, meta):
#   status     select(status)      required, default: inbox
#   scopes     multi-input         default: []
#   tags       multi-input         default: []
#   type       value: "task"       (fixed)
# 
# Own Fields:
#   milestone  dynamic(milestones) required
#   deadline   date                optional
#   priority   select(priority)    default: medium
# 
# Files: 47
```

### Validate Schema

```bash
bwrb schema validate

# Validating schema...
# 
# OK Schema structure is valid
# OK All enum references exist
# OK All dynamic sources exist
# OK Type inheritance is valid
# 
# Warnings:
#   - Type 'draft' has no files in vault
#   - Enum 'old-status' is not used by any field
```

---

## Type Management

### Add Type

```bash
# Non-interactive (requires --output-dir):
bwrb schema add-type book --output-dir Books
bwrb schema add-type person --extends entity --output-dir Entities/People

# Interactive mode (prompts for options):
bwrb schema add-type project

# Creating new type: project
# 
# Extends (default: meta): entity
# 
# Output directory: Projects
# 
# Directory mode:
#   1. pooled (all files in one folder)
#   2. instance-grouped (files grouped by instance)
# > 1
# 
# Add fields now? [Y/n] y
# 
# Field name (or 'done'): deadline
# Prompt type:
#   1. input (text)
#   2. select (enum)
#   3. date
#   4. number
#   5. multi-input (list)
#   6. dynamic (from other notes)
#   7. fixed value
# > 3
# Required? [y/N] n
# 
# Field name (or 'done'): done
# 
# OK Created type 'project'
#   Extends: entity
#   Directory: Projects/
#   Fields: deadline
#   Inherited: status, scopes, tags (from entity, meta)
```

### Edit Type

```bash
bwrb schema edit-type project

# Editing type: project
# 
# What would you like to change?
#   1. Output directory (current: Projects)
#   2. Directory mode (current: pooled)
#   3. Parent type (current: entity)
#   4. Filename pattern
# > 1
# 
# Output directory: Projects/Active
# 
# OK Updated output directory for 'project'
#   Projects → Projects/Active
# 
# Note: Existing files not moved. Run 'bwrb bulk project --move' to relocate.
```

### Remove Type

```bash
bwrb schema remove-type project

# Removing type: project
# 
# This will:
#   - Remove type definition from schema
#   - NOT delete existing files (12 files in Projects/)
# 
# Existing files will become orphans (no type definition).
# 
# Apply? [y/N] y
# 
# OK Removed type 'project'
# 
# Tip: Run 'bwrb audit' to find orphaned files.

# Non-interactive:
bwrb schema remove-type project --execute
```

---

## Field Management

### Add Field

```bash
# Interactive:
bwrb schema add-field task

# Adding field to task
# 
# Field name: deadline
# Prompt type: date
# Required? [y/N] n
# Default value (blank for none): 
# Label (blank for field name): Due Date
# 
# OK Added field 'deadline' to task

# Non-interactive with flags:
bwrb schema add-field task deadline --prompt date --label "Due Date"
bwrb schema add-field task priority --prompt select --enum priority --default medium
```

### Edit Field

```bash
bwrb schema edit-field task priority

# Editing field 'priority' in task
# 
# Current configuration:
#   Prompt: select
#   Enum: priority
#   Required: no
#   Default: medium
# 
# What would you like to change?
#   1. Prompt type
#   2. Required status
#   3. Default value
#   4. Label
# > 3
# 
# New default value:
#   1. low
#   2. medium
#   3. high
#   4. critical
# > 3
# 
# OK Updated field 'priority' in task
#   default: medium → high
# 
# This only affects new notes. Existing notes unchanged.
```

### Remove Field

```bash
bwrb schema remove-field task legacy-notes

# Removing field 'legacy-notes' from task
# 
# 23 notes currently have this field.
# 
# This will:
#   - Remove field from schema
#   - NOT delete field from existing files
# 
# Apply? [y/N] y
# 
# OK Removed field 'legacy-notes' from schema
# 
# Note: 23 files still have 'legacy-notes' field.
# Run 'bwrb bulk task --delete legacy-notes --execute' to remove from files.

# Non-interactive:
bwrb schema remove-field task legacy-notes --execute
```

---

## Enum Management

### List Enums

```bash
bwrb schema enum list

# Enums:
#   status      inbox, backlog, planned, in-progress, done, cancelled
#               Used by: meta.status
#   
#   priority    low, medium, high, critical
#               Used by: task.priority, idea.priority
#   
#   scope       day, week, sprint, quarter, year
#               Used by: task.scope
```

### Add Enum

```bash
bwrb schema enum add scope

# Creating enum: scope
# 
# Values (comma-separated): day, week, sprint, quarter, year
# 
# OK Created enum 'scope' with 5 values
```

### Update Enum

```bash
# Add value
bwrb schema enum update status --add archived

# Adding 'archived' to enum 'status'
# Current: inbox, backlog, planned, in-progress, done, cancelled
# New:     inbox, backlog, planned, in-progress, done, cancelled, archived
# 
# OK Added 'archived' to enum 'status'

# Rename value
bwrb schema enum update status --rename in-flight=in-progress

# Renaming in enum 'status': in-flight → in-progress
# 
# 23 files use 'in-flight'.
# This change will be tracked as a pending migration.
# 
# OK Renamed 'in-flight' to 'in-progress'
# Run 'bwrb schema migrate' to update affected files.

# Remove value
bwrb schema enum update status --remove deprecated

# Removing 'deprecated' from enum 'status'
# 
# 5 files use 'deprecated'.
# This change will be tracked as a pending migration.
# 
# OK Removed 'deprecated' from enum 'status'
# Run 'bwrb schema migrate' to update affected files.
```

### Delete Enum

```bash
bwrb schema enum delete old-status

# Deleting enum: old-status
# 
# This enum is not used by any fields.
# 
# Apply? [y/N] y
# 
# OK Deleted enum 'old-status'

# If enum is in use:
bwrb schema enum delete status

# X Cannot delete enum 'status'
#   It is used by field 'meta.status'
# 
# Remove the field first, then delete the enum.
```

---

## Migration System

### How It Works

1. Schema changes that affect existing files create **pending migrations**
2. `bwrb schema diff` shows what migrations are pending
3. `bwrb schema migrate` executes migrations (dry-run + prompt by default)
4. Migrations are logged in `.bwrb/migrations/`

### Schema Diff

```bash
bwrb schema diff

# Pending migrations:
# 
# 1. Enum rename: status.in-flight → status.in-progress
#    Affects: 23 files
#    Auto-applicable: yes
# 
# 2. New required field: task.scope
#    Affects: 47 files (missing field)
#    Auto-applicable: yes (has default: week)
# 
# 3. Removed enum value: priority.low
#    Affects: 12 files
#    Auto-applicable: no (needs replacement value)
# 
# Run 'bwrb schema migrate' to apply.
```

### Schema Migrate

```bash
bwrb schema migrate

# Applying migrations...
# 
# 1. Enum rename: status.in-flight → status.in-progress
#    23 files would be updated
# 
# 2. New required field: task.scope
#    47 files would get 'scope: week'
# 
# 3. Removed enum value: priority.low
#    12 files have 'priority: low'. Replace with:
#      1. medium
#      2. high
#      3. critical
#    > 1
# 
# Apply these changes? [y/N] y
# 
# Applying...
#   OK Updated 23 files (enum rename)
#   OK Updated 47 files (new field)
#   OK Updated 12 files (enum removal)
# 
# OK Applied 3 migrations, updated 82 files

# Non-interactive:
bwrb schema migrate --execute
```

### Auto-Apply vs Prompt

**Auto-applicable (deterministic):**
- Enum value rename
- Add field with default
- Add enum value

**Requires prompt (non-deterministic):**
- Remove enum value (what's the replacement?)
- Remove field (delete data?)
- Change field type (how to convert?)

### Migration History

```bash
bwrb schema history

# Schema migration history:
# 
# v5 (2025-01-15 11:00)
#   Added project type
# 
# v4 (2025-01-14 09:00)
#   Added scope field to tasks
# 
# v3 (2025-01-12 14:30)
#   Renamed status enum values
#     in-flight → in-progress
# 
# v2 (2025-01-10 10:00)
#   Added objective type
# 
# v1 (2025-01-01 00:00)
#   Initial schema
```

---

## Deprecated Concepts

### Shared Fields (deprecated)

**Status:** Deprecated in favor of inheritance.

Previously, shared fields were defined at the schema level and referenced by types. With the inheritance model, this is redundant:

- **Old way:** Define `status` as a shared field, reference it in multiple types
- **New way:** Define `status` on `meta`, all types inherit it automatically

See issue `bwrb-iqng` for deprecation plan.

### Subtypes (deprecated)

**Status:** Replaced by flat types with `extends`.

Previously, subtypes were nested within parent types. Now all types are flat with explicit inheritance:

- **Old way:** `objective/task` as a nested subtype structure
- **New way:** `task` type with `extends: objective`

The `add-type --extends` flag handles this cleanly.

---

## Error Handling

### Invalid Operation

```bash
bwrb schema enum delete status

# X Cannot delete enum 'status'
#   It is used by field 'meta.status'
# 
# Remove the field first, then delete the enum.
```

### Circular Inheritance

```bash
bwrb schema edit-type meta --extends task

# X Cannot set parent type
#   This would create circular inheritance: meta → task → objective → meta
```

### Type Not Found

```bash
bwrb schema edit-type nonexistent

# X Type 'nonexistent' not found
# 
# Available types: meta, objective, task, milestone, idea
```

---

## Implementation Status

### Implemented

- [x] `schema show [type]` - Tree view and type details
- [x] `schema validate` - Schema validation
- [x] `schema add-type <name>` - Create new type (with `--extends`)
- [x] `schema add-field <type> [field]` - Add field to type
- [x] `schema enum list` - List all enums
- [x] `schema enum add <name>` - Create enum
- [x] `schema enum update <name>` - Modify enum
- [x] `schema enum delete <name>` - Remove enum
- [x] `schema diff` - Show pending migrations
- [x] `schema migrate` - Apply migrations
- [x] `schema history` - Migration history

### To Implement (bwrb-tsh)

- [ ] `schema edit-type <name>` - Modify type settings
- [ ] `schema remove-type <name>` - Remove type (dry-run + prompt)
- [ ] `schema edit-field <type> <field>` - Modify field properties
- [ ] `schema remove-field <type> <field>` - Remove field (dry-run + prompt)

---

## Success Criteria

1. **No JSON editing** — All operations via CLI
2. **Interactive by default** — Guided prompts for complex operations
3. **Dry-run for destructive ops** — Show changes, prompt for confirmation
4. **Migration integration** — Changes flow through diff → migrate
5. **Inheritance-aware** — Commands understand and display inheritance
6. **Validation** — Prevent invalid states (circular inheritance, missing refs)
7. **Discoverability** — `schema show` makes structure clear

# Schema Management CLI

> Interactive schema exploration and manipulation — never touch JSON directly

---

## Overview

The `pika schema` command provides full CLI control over the schema:

- Explore types, fields, and enums
- Add, edit, and remove types
- Manage shared fields
- Handle migrations when schema changes

The goal is to **never require direct JSON editing**.

---

## Command Surface

```bash
# Exploration
pika schema show                          # Tree view of all types
pika schema show objective/task           # Show specific type
pika schema validate                      # Validate schema structure

# Type management
pika schema add-type <name>               # Create new type
pika schema edit-type <name>              # Modify type settings
pika schema remove-type <name>            # Remove type

# Subtype management
pika schema add-subtype <type> <name>     # Add subtype
pika schema edit-subtype <type/subtype>   # Modify subtype
pika schema remove-subtype <type/subtype> # Remove subtype

# Field management
pika schema add-field <name> <type>       # Add field to type
pika schema edit-field <name> <type>      # Modify field
pika schema remove-field <name> <type>    # Remove field

# Shared fields
pika schema add-shared-field <name>       # Create shared field
pika schema edit-shared-field <name>      # Modify shared field
pika schema remove-shared-field <name>    # Remove shared field

# Enum management
pika schema add-enum <name>               # Create new enum
pika schema edit-enum <name> [options]    # Modify enum
pika schema remove-enum <name>            # Remove enum
pika schema list-enums                    # List all enums

# Migration
pika schema diff                          # Show pending migrations
pika schema apply                         # Apply migrations
pika schema history                       # Show migration history
```

---

## Schema Exploration

### Show All Types

```bash
pika schema show

# Schema v3
# 
# Shared Fields:
#   status     select(status)      required, default: inbox
#   scopes     multi-input         default: []
#   tags       multi-input         default: []
# 
# Enums:
#   status     inbox, backlog, planned, in-progress, done, cancelled
#   priority   low, medium, high, critical
# 
# Types:
#   objective/                      Objectives/
#     task                          Objectives/Tasks/       [pooled]
#       Fields: type, milestone, deadline, priority
#       Shared: status, scopes
#     milestone                     Objectives/Milestones/  [pooled]
#       Fields: type, start-date, end-date
#       Shared: status
#   
#   idea                            Ideas/                  [pooled]
#     Fields: type, priority
#     Shared: status, scopes, tags
#   
#   draft/                          Drafts/                 [instance-grouped]
#     version                       {instance}/             
#       Fields: type, canonical
#     research                      {instance}/             
#       Fields: type
#     notes                         {instance}/             
#       Fields: type
```

### Show Specific Type

```bash
pika schema show objective/task

# Type: objective/task
# 
# Directory: Objectives/Tasks/
# Mode: pooled
# 
# Shared Fields:
#   status     select(status)      required, default: inbox
#   scopes     multi-input         default: []
# 
# Type Fields:
#   type       value: "task"       (fixed)
#   milestone  dynamic(milestones) required
#   deadline   date                optional
#   priority   select(priority)    default: medium
# 
# Frontmatter Order:
#   type, status, milestone, deadline, priority, scopes
# 
# Files: 47
```

### Validate Schema

```bash
pika schema validate

# Validating schema...
# 
# ✓ Schema structure is valid
# ✓ All enum references exist
# ✓ All dynamic sources exist
# ✓ All shared field references exist
# 
# Warnings:
#   - Type 'draft/resources' has no files in vault
#   - Enum 'old-status' is not used by any type
```

---

## Type Management

### Add Type

```bash
pika schema add-type project

# Creating new type: project
# 
# Directory mode:
#   1. pooled (all files in one folder)
#   2. instance-grouped (files grouped by instance)
# > 2
# 
# Output directory: Projects
# 
# Include shared fields?
#   [x] status
#   [x] scopes
#   [ ] tags
# 
# Add type-specific fields now? [Y/n] y
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
# Default value (blank for none): 
# 
# Field name (or 'done'): done
# 
# Add subtypes now? [Y/n] y
# 
# Subtype name (or 'done'): plan
# Filename pattern: Plan.md
# 
# Subtype name (or 'done'): log
# Filename pattern: Log.md
# 
# Subtype name (or 'done'): done
# 
# ✓ Created type 'project' with 2 subtypes
#   Directory: Projects/{instance}/
#   Shared fields: status, scopes
#   Type fields: deadline
#   Subtypes: plan, log
```

### Edit Type

```bash
pika schema edit-type project

# Editing type: project
# 
# What would you like to change?
#   1. Output directory (current: Projects)
#   2. Directory mode (current: instance-grouped)
#   3. Shared fields
#   4. Frontmatter order
# > 3
# 
# Current shared fields: status, scopes
# 
# Shared fields to include:
#   [x] status
#   [x] scopes
#   [x] tags        ← added
# 
# ✓ Updated shared fields for 'project'
```

### Remove Type

```bash
pika schema remove-type project

# ⚠ Warning: Removing type 'project'
# 
# This will:
#   - Remove type definition from schema
#   - Remove 2 subtypes (plan, log)
#   - NOT delete existing files (12 files in Projects/)
# 
# Existing files will become orphans (no type definition).
# 
# Are you sure? [y/N] y
# 
# ✓ Removed type 'project'
# 
# Tip: Run 'pika audit' to find orphaned files.
```

---

## Field Management

### Add Field

```bash
pika schema add-field deadline task

# Adding field 'deadline' to objective/task
# 
# Prompt type:
#   1. input (text)
#   2. select (enum)
#   3. date
#   4. number
#   5. multi-input (list)
#   6. dynamic (from other notes)
#   7. fixed value
# > 3
# 
# Required? [y/N] n
# Default value (blank for none): 
# Label (blank for field name): Due Date
# 
# ✓ Added field 'deadline' to objective/task
# 
# 47 existing tasks don't have this field.
# Add to existing files? [y/N] n
```

### Edit Field

```bash
pika schema edit-field priority task

# Editing field 'priority' in objective/task
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
# New default value: high
# 
# ✓ Updated field 'priority' in objective/task
#   default: medium → high
# 
# This only affects new tasks. Existing tasks unchanged.
```

### Remove Field

```bash
pika schema remove-field legacy-notes task

# ⚠ Warning: Removing field 'legacy-notes' from objective/task
# 
# 23 tasks currently have this field.
# 
# Options:
#   1. Remove from schema only (field stays in files)
#   2. Remove from schema and delete from all files
# > 1
# 
# ✓ Removed field 'legacy-notes' from schema
# 
# Note: 23 files still have 'legacy-notes' field.
# Run 'pika bulk task --delete legacy-notes --execute' to remove from files.
```

---

## Shared Fields

### Add Shared Field

```bash
pika schema add-shared-field priority

# Creating shared field: priority
# 
# Prompt type:
#   1. input (text)
#   2. select (enum)
#   3. date
#   4. number
#   5. multi-input (list)
# > 2
# 
# Enum name: priority
# Enum exists: low, medium, high, critical
# 
# Required? [y/N] n
# Default value: medium
# 
# ✓ Created shared field 'priority'
# 
# Add to types now? [Y/n] y
# 
# Select types to add 'priority' to:
#   [x] idea
#   [x] objective/task
#   [ ] objective/milestone
#   [ ] draft
# 
# ✓ Added 'priority' to 2 types
```

### Edit Shared Field

```bash
pika schema edit-shared-field status

# Editing shared field: status
# 
# Current configuration:
#   Prompt: select
#   Enum: status
#   Required: yes
#   Default: inbox
# 
# What would you like to change?
#   1. Default value
#   2. Required status
#   3. Label
# > 1
# 
# New default value:
#   1. inbox
#   2. backlog
#   3. planned
#   4. in-progress
#   5. done
#   6. cancelled
# > 2
# 
# ✓ Updated shared field 'status'
#   default: inbox → backlog
# 
# Types using this field: idea, objective/task, objective/milestone, draft
# New tasks/ideas/etc. will default to 'backlog'.
```

---

## Enum Management

### Add Enum

```bash
pika schema add-enum scope

# Creating enum: scope
# 
# Values (comma-separated): day, week, sprint, quarter, year
# 
# ✓ Created enum 'scope' with 5 values
```

### Edit Enum

```bash
# Add value
pika schema edit-enum status --add archived

# Adding 'archived' to enum 'status'
# Current: inbox, backlog, planned, in-progress, done, cancelled
# New:     inbox, backlog, planned, in-progress, done, cancelled, archived
# 
# ✓ Added 'archived' to enum 'status'

# Rename value
pika schema edit-enum status --rename in-flight=in-progress

# Renaming in enum 'status': in-flight → in-progress
# 
# 23 files use 'in-flight'. Update them? [Y/n] y
# 
# Updating files...
#   ✓ Updated 23 files
# 
# ✓ Renamed 'in-flight' to 'in-progress'

# Remove value
pika schema edit-enum status --remove deprecated

# Removing 'deprecated' from enum 'status'
# 
# 5 files use 'deprecated'. Choose action:
#   1. Replace with another value
#   2. Remove from schema only (files become invalid)
#   3. Cancel
# > 1
# 
# Replace with:
#   1. inbox
#   2. backlog
#   3. planned
#   4. in-progress
#   5. done
#   6. cancelled
# > 6
# 
# Updating files...
#   ✓ Updated 5 files
# 
# ✓ Removed 'deprecated' from enum 'status'

# Reorder values
pika schema edit-enum priority --reorder

# Current order: low, medium, high, critical
# 
# New order (comma-separated): critical, high, medium, low
# 
# ✓ Reordered enum 'priority'
```

### List Enums

```bash
pika schema list-enums

# Enums:
#   status      inbox, backlog, planned, in-progress, done, cancelled
#               Used by: status (shared)
#   
#   priority    low, medium, high, critical
#               Used by: priority (shared), idea.priority
#   
#   scope       day, week, sprint, quarter, year
#               Used by: objective/task.scope
#   
#   draft-status  idea, outlining, drafting, revising, editing, complete
#               Used by: draft.status (override)
```

---

## Migration System

### How It Works

1. Schema changes that affect existing files create **pending migrations**
2. `pika schema diff` shows what migrations are pending
3. `pika schema apply` executes migrations
4. Migrations are logged in `.pika/migrations/`

### Schema Diff

```bash
pika schema diff

# Pending migrations:
# 
# 1. Enum rename: status.in-flight → status.in-progress
#    Affects: 23 files
#    Auto-applicable: yes
# 
# 2. New required field: objective/task.scope
#    Affects: 47 files (missing field)
#    Auto-applicable: yes (has default: week)
# 
# 3. Removed enum value: priority.low
#    Affects: 12 files
#    Auto-applicable: no (needs replacement value)
# 
# Run 'pika schema apply' to execute migrations.
```

### Schema Apply

```bash
pika schema apply

# Applying migrations...
# 
# 1. Enum rename: status.in-flight → status.in-progress
#    Updating 23 files...
#    ✓ Done
# 
# 2. New required field: objective/task.scope
#    Adding 'scope: week' to 47 files...
#    ✓ Done
# 
# 3. Removed enum value: priority.low
#    12 files have 'priority: low'. Replace with:
#      1. medium
#      2. high
#      3. critical
#    > 1
#    Updating 12 files...
#    ✓ Done
# 
# ✓ Applied 3 migrations
# ✓ Updated 82 files
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

---

## Schema Versioning

The schema tracks version and migration history:

```json
{
  "version": 5,
  "migrations": [
    {
      "version": 2,
      "timestamp": "2025-01-10T10:00:00Z",
      "description": "Added shared fields"
    },
    {
      "version": 3,
      "timestamp": "2025-01-12T14:30:00Z",
      "description": "Renamed status enum values"
    },
    {
      "version": 4,
      "timestamp": "2025-01-14T09:00:00Z",
      "description": "Added scope field to tasks"
    },
    {
      "version": 5,
      "timestamp": "2025-01-15T11:00:00Z",
      "description": "Added project type"
    }
  ],
  "shared_fields": { ... },
  "enums": { ... },
  "types": { ... }
}
```

### View History

```bash
pika schema history

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
#     raw → inbox
# 
# v2 (2025-01-10 10:00)
#   Added shared fields
#     status, scopes, tags
# 
# v1 (2025-01-01 00:00)
#   Initial schema
```

---

## Error Handling

### Invalid Operation

```bash
pika schema remove-enum status

# ✗ Cannot remove enum 'status'
#   It is used by shared field 'status'
# 
# To remove this enum:
#   1. Remove or modify the shared field first
#   2. Then remove the enum
```

### Circular Reference

```bash
pika schema add-field parent task --type dynamic --source tasks

# ⚠ Warning: This creates a self-referential field
#   'task.parent' references 'tasks' (which are tasks)
# 
# This is valid but may cause infinite loops in some operations.
# Continue? [y/N]
```

---

## Implementation Notes

### Schema Loading

```typescript
interface Schema {
  version: number;
  migrations: Migration[];
  shared_fields: Record<string, Field>;
  enums: Record<string, string[]>;
  types: Record<string, Type>;
  audit?: AuditConfig;
}

async function loadSchema(vaultPath: string): Promise<Schema> {
  const schemaPath = path.join(vaultPath, '.pika', 'schema.json');
  const content = await fs.readFile(schemaPath, 'utf-8');
  const raw = JSON.parse(content);
  
  // Validate with Zod
  return SchemaSchema.parse(raw);
}

async function saveSchema(vaultPath: string, schema: Schema): Promise<void> {
  // Increment version
  schema.version += 1;
  
  // Add migration record
  schema.migrations.push({
    version: schema.version,
    timestamp: new Date().toISOString(),
    description: currentMigrationDescription,
  });
  
  const schemaPath = path.join(vaultPath, '.pika', 'schema.json');
  await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2));
}
```

### Interactive Prompts

```typescript
import prompts from 'prompts';

async function promptForFieldType(): Promise<FieldPromptType> {
  const { type } = await prompts({
    type: 'select',
    name: 'type',
    message: 'Prompt type:',
    choices: [
      { title: 'input (text)', value: 'input' },
      { title: 'select (enum)', value: 'select' },
      { title: 'date', value: 'date' },
      { title: 'number', value: 'number' },
      { title: 'multi-input (list)', value: 'multi-input' },
      { title: 'dynamic (from other notes)', value: 'dynamic' },
      { title: 'fixed value', value: 'value' },
    ],
  });
  
  return type;
}
```

---

## Success Criteria

1. **No JSON editing** — All operations via CLI
2. **Interactive** — Guided prompts for complex operations
3. **Safe migrations** — Clear diff, confirmation, logging
4. **Reversible** — Migration history, schema versioning
5. **Validation** — Prevent invalid states
6. **Discoverability** — `schema show` makes structure clear

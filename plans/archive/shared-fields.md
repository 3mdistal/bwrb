# Shared Fields

> Global frontmatter fields that apply across all note types

---

## Overview

Currently, fields like `status` are defined separately in each type, leading to:

- **Duplication** — Same field defined multiple times
- **Inconsistency** — Different defaults or enum values per type
- **Missing fields** — Some types lack fields they should have

Shared fields solve this by defining fields once at the schema root level. Types **opt-in** to shared fields and can override defaults.

---

## Schema Structure

```json
{
  "version": 2,
  "shared_fields": {
    "status": {
      "prompt": "select",
      "enum": "status",
      "default": "inbox",
      "required": true
    },
    "scopes": {
      "prompt": "multi-input",
      "label": "Scopes (comma-separated)",
      "list_format": "yaml-array",
      "default": []
    },
    "tags": {
      "prompt": "multi-input",
      "list_format": "yaml-array",
      "default": []
    }
  },
  "enums": {
    "status": ["inbox", "backlog", "planned", "in-progress", "done", "cancelled"]
  },
  "types": {
    "idea": {
      "output_dir": "Ideas",
      "shared_fields": ["status", "scopes", "tags"],
      "frontmatter": {
        "type": { "value": "idea" },
        "priority": { "prompt": "select", "enum": "priority" }
      }
    },
    "objective": {
      "subtypes": {
        "task": {
          "output_dir": "Objectives/Tasks",
          "shared_fields": ["status", "scopes"],
          "frontmatter": {
            "type": { "value": "task" },
            "milestone": { "prompt": "dynamic", "source": "milestones" }
          },
          "field_overrides": {
            "status": { "default": "backlog" }
          }
        }
      }
    }
  }
}
```

---

## Key Concepts

### Opt-In Model

Types explicitly list which shared fields they include:

```json
{
  "shared_fields": ["status", "scopes", "tags"]
}
```

This is **opt-in**, not automatic. Types without `shared_fields` don't get them.

### Field Overrides

Types can override shared field properties:

```json
{
  "shared_fields": ["status"],
  "field_overrides": {
    "status": {
      "default": "planned",
      "required": false
    }
  }
}
```

Override-able properties:
- `default` — Different default value
- `required` — Change required status
- `label` — Different prompt label

Non-override-able properties:
- `enum` — Must use the shared enum for consistency
- `prompt` — Field type is fixed

### Field Merge Order

When building the field list for a type:

1. Start with shared fields (in schema order)
2. Apply field overrides
3. Add type-specific frontmatter fields
4. Apply `frontmatter_order` if specified

### Default Field Order

Shared fields appear **first** by default, then type-specific fields.

With `frontmatter_order`, you can customize:

```json
{
  "frontmatter_order": ["type", "status", "priority", "scopes", "deadline"]
}
```

---

## CLI Integration

### Creating Notes

Shared fields are prompted like any other field:

```bash
pika new idea
# Title: My Idea
# Status: [inbox] backlog, planned, in-progress, done, cancelled
# Scopes (comma-separated): personal, q1-2025
# Priority: [medium] low, high, critical
# → Creates Ideas/My Idea.md
```

### Listing Notes

Shared fields are available for filtering and display:

```bash
pika list idea --where "status == 'in-progress'"
pika list --all --where "isEmpty(scopes)"
pika list task --fields status,title,deadline
```

### Editing Notes

Shared fields can be edited like any other:

```bash
pika edit Ideas/My\ Idea.md --set status=done
```

---

## Example Output

With shared fields configured, a new idea would have:

```yaml
---
type: idea
status: inbox
scopes:
  - personal
  - q1-2025
tags:
  - brainstorm
priority: medium
---

# My Idea

...
```

---

## Audit Integration

Audit should verify shared fields:

### Checks

1. **Missing shared field** — Type opts-in but note lacks the field
2. **Invalid enum value** — Value not in shared enum
3. **Wrong field type** — e.g., string where array expected

### Example Output

```bash
pika audit

# Shared Field Issues:
#   Ideas/Old Idea.md
#     - Missing required field: status
#     - Missing field: scopes
#   
#   Objectives/Tasks/Task A.md
#     - Invalid status value: 'wip' (expected one of: inbox, backlog, planned, in-progress, done, cancelled)
```

### Auto-Fix

```bash
pika audit --fix --auto

# Fixing shared field issues...
#   Ideas/Old Idea.md
#     ✓ Added status: inbox (default)
#     ✓ Added scopes: [] (default)
# 
# Fixed 2 issues in 1 file
```

---

## Schema Management

### Adding a Shared Field

```bash
pika schema add-shared-field priority

# Field name: priority
# Prompt type: select
# Enum: priority
# Required: no
# Default: medium
# 
# ✓ Added shared field 'priority'
# 
# Add to types now? [Y/n] y
# Select types to add 'priority' to:
#   [x] idea
#   [x] objective/task
#   [ ] objective/milestone
#   [ ] draft
# 
# ✓ Added 'priority' to 2 types
```

### Modifying a Shared Field

```bash
pika schema edit-shared-field status --default planned

# Updated default for 'status': inbox → planned
# 
# 47 files have status: inbox
# Update to new default? [y/N]
```

### Removing a Shared Field

```bash
pika schema remove-shared-field scopes

# Warning: 'scopes' is used by 3 types:
#   - idea
#   - objective/task
#   - draft
# 
# This will:
#   - Remove 'scopes' from shared_fields
#   - Remove 'scopes' from type configurations
#   - NOT delete 'scopes' from existing notes
# 
# Continue? [y/N]
```

---

## Migration from Per-Type Fields

If you have existing per-type status fields:

### 1. Create Shared Field

```bash
pika schema add-shared-field status
# Define the canonical version
```

### 2. Audit Inconsistencies

```bash
pika audit --check-shared-migration status

# Status field migration analysis:
#   
#   Current definitions:
#     idea.status: enum=status, default=inbox
#     task.status: enum=task-status, default=raw
#     milestone.status: enum=milestone-status, default=active
#   
#   Proposed shared:
#     status: enum=status, default=inbox
#   
#   Value mapping needed:
#     task.status:
#       raw → inbox
#       in-flight → in-progress
#       complete → done
```

### 3. Bulk Update

```bash
pika bulk task --set status=inbox --where "status == 'raw'" --execute
pika bulk task --set status=in-progress --where "status == 'in-flight'" --execute
pika bulk task --set status=done --where "status == 'complete'" --execute
```

### 4. Update Schema

```bash
pika schema edit-type task --use-shared-field status
# Removes type-specific status, adds to shared_fields list
```

---

## Reserved/Native Fields

Some fields are always allowed, even if not in schema:

- `tags` — Obsidian native
- `aliases` — Obsidian native
- `cssclasses` — Obsidian native
- `publish` — Obsidian Publish

These are handled specially:
- Never flagged as "unknown" in audit
- Can be defined as shared fields for defaults/validation
- If not defined, they're pass-through (no validation)

---

## Implementation Notes

### Schema Loading

```typescript
function getFieldsForType(schema: Schema, typePath: string): Record<string, Field> {
  const typeConfig = getTypeConfig(schema, typePath);
  const fields: Record<string, Field> = {};
  
  // 1. Add shared fields
  for (const fieldName of typeConfig.shared_fields ?? []) {
    const sharedField = schema.shared_fields?.[fieldName];
    if (sharedField) {
      fields[fieldName] = { ...sharedField };
    }
  }
  
  // 2. Apply overrides
  for (const [fieldName, overrides] of Object.entries(typeConfig.field_overrides ?? {})) {
    if (fields[fieldName]) {
      fields[fieldName] = { ...fields[fieldName], ...overrides };
    }
  }
  
  // 3. Add type-specific fields
  for (const [fieldName, field] of Object.entries(typeConfig.frontmatter ?? {})) {
    fields[fieldName] = field;
  }
  
  return fields;
}
```

### Frontmatter Ordering

```typescript
function orderFields(
  fields: Record<string, Field>,
  sharedFieldNames: string[],
  frontmatterOrder?: string[]
): string[] {
  if (frontmatterOrder) {
    return frontmatterOrder.filter(name => name in fields);
  }
  
  // Default: shared fields first, then type-specific
  const sharedFirst = sharedFieldNames.filter(name => name in fields);
  const typeSpecific = Object.keys(fields).filter(name => !sharedFieldNames.includes(name));
  
  return [...sharedFirst, ...typeSpecific];
}
```

---

## Success Criteria

1. **Consistency** — Same field name always means the same thing
2. **Flexibility** — Types can opt-in and override defaults
3. **Migration support** — Easy to consolidate existing per-type fields
4. **Audit integration** — Shared fields validated like any other
5. **No breaking changes** — Existing vaults work without modification

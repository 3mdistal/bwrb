---
title: Quick Start
description: Create your first schema-validated note in 5 minutes
---

This guide walks you through creating a vault with a schema and your first note.

## 1. Create a Vault

A vault is any directory with a `.bwrb/schema.json` file:

```bash
mkdir my-vault
cd my-vault
mkdir -p .bwrb
```

## 2. Define a Schema

Create `.bwrb/schema.json`. Here's a minimal schema with two types:

```json
{
  "types": {
    "idea": {
      "output_dir": "Ideas",
      "frontmatter": {
        "type": { "value": "idea" },
        "created": { "value": "$NOW" },
        "status": {
          "prompt": "select",
          "options": ["raw", "developing", "mature"],
          "default": "raw"
        }
      }
    },
    "task": {
      "output_dir": "Tasks",
      "frontmatter": {
        "type": { "value": "task" },
        "created": { "value": "$NOW" },
        "status": {
          "prompt": "select",
          "options": ["todo", "in-progress", "done"],
          "default": "todo"
        },
        "priority": {
          "prompt": "select",
          "options": ["low", "medium", "high"],
          "default": "medium"
        }
      }
    }
  }
}
```

This schema defines:

- **`idea`** type — stored in `Ideas/`, with a status field
- **`task`** type — stored in `Tasks/`, with status and priority fields
- **Static fields** — `type` and `created` are set automatically
- **Prompted fields** — `status` and `priority` are chosen interactively

## 3. Create a Note

```bash
bwrb new idea
```

Bowerbird prompts you for:

1. **Title** — becomes the filename (e.g., "My Great Idea" → `Ideas/My Great Idea.md`)
2. **Status** — select from the defined options

The result is a properly-structured markdown file:

```markdown
---
type: idea
created: 2025-01-07 14:30
status: raw
---

```

## 4. List Your Notes

```bash
# List all ideas
bwrb list idea

# List with specific fields as a table
bwrb list idea --fields=status

# List tasks filtered by status
bwrb list task --where "status = 'todo'"
```

## 5. Open a Note

```bash
# Open in Obsidian (default)
bwrb open "My Great Idea"

# Open in your $EDITOR
bwrb open "My Great Idea" --app editor

# Just print the path
bwrb open "My Great Idea" --app print
```

## 6. Edit a Note

If you need to change frontmatter values:

```bash
bwrb edit Ideas/My\ Great\ Idea.md
```

Bowerbird shows the current values and lets you update them.

## 7. Audit for Drift

If you manually edit a file and accidentally break the schema:

```bash
# Check for violations
bwrb audit

# Fix violations interactively (requires explicit targeting)
bwrb audit --path "Ideas/**" --fix
```

Bowerbird reports issues like:

- Missing required fields
- Invalid field values (not in the allowed options)
- Unknown fields (not defined in schema)

## Understanding Schema Structure

### Static vs. Prompted Fields

**Static fields** have a `value` and are set automatically:

```json
{
  "type": { "value": "idea" },
  "created": { "value": "$NOW" }
}
```

Special values:
- `$NOW` — Current datetime (YYYY-MM-DD HH:mm)
- `$TODAY` — Current date (YYYY-MM-DD)

**Prompted fields** use interactive input:

```json
{
  "status": {
    "prompt": "select",
    "options": ["raw", "developing", "mature"],
    "default": "raw"
  }
}
```

### Field Types

| Prompt Type | Description | Example |
|-------------|-------------|---------|
| `select` | Choose from options | Status, priority |
| `text` | Free text input | Description |
| `number` | Numeric input | Word count |
| `boolean` | Yes/no | Completed |
| `date` | Date input | Deadline |
| `relation` | Link to another note | Parent task |

### Hierarchical Types

Types can have subtypes for nested categorization:

```json
{
  "types": {
    "objective": {
      "subtypes": {
        "task": { "output_dir": "Objectives/Tasks", ... },
        "milestone": { "output_dir": "Objectives/Milestones", ... }
      }
    }
  }
}
```

Access subtypes with slash notation:

```bash
bwrb new objective/task
bwrb list objective          # Lists all objectives (tasks + milestones)
bwrb list objective/task     # Lists only tasks
```

## Vault Path Resolution

Bowerbird finds your vault in this order:

1. `--vault=<path>` flag
2. `BWRB_VAULT` environment variable
3. Current working directory

Set a default vault in your shell profile:

```bash
export BWRB_VAULT=~/notes
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `bwrb new <type>` | Create a new note |
| `bwrb list <type>` | List notes of a type |
| `bwrb edit <path>` | Edit note frontmatter |
| `bwrb open [query]` | Open a note |
| `bwrb search [query]` | Find notes, generate wikilinks |
| `bwrb audit` | Check schema compliance |
| `bwrb schema list` | View schema types |

## Next Steps

- [Schema concepts](/concepts/schema/) — Deep dive into schema structure
- [Types and inheritance](/concepts/types/) — Organize types hierarchically
- [CLI Reference](/reference/commands/new/) — Full command documentation
- [Templates](/templates/overview/) — Create reusable note structures

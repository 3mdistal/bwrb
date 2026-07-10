---
title: Quick Start
description: Create your first schema-validated note in 5 minutes
---

This guide walks you through creating a vault with a schema and your first note.

## 1. Create a Vault

A vault is any directory with a `.bwrb/schema.json` file. Initialize one with
the shipped non-interactive defaults:

```bash
mkdir my-vault
cd my-vault
bwrb init --yes
```

## 2. Define a Schema

Replace the generated `.bwrb/schema.json` with this minimal schema containing
two types:

```json
{
  "version": 2,
  "types": {
    "idea": {
      "output_dir": "Ideas",
      "fields": {
        "type": { "value": "idea" },
        "created": { "value": "$NOW" },
        "status": {
          "prompt": "select",
          "options": ["raw", "developing", "mature"],
          "default": "raw"
        }
      },
      "field_order": ["type", "created", "status"]
    },
    "task": {
      "output_dir": "Tasks",
      "fields": {
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
      },
      "field_order": ["type", "created", "status", "priority"]
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
id: 550e8400-e29b-41d4-a716-446655440000
created: 2025-01-07 14:30
status: raw
---

```

Interactive creation derives the effective note name from the filename and does
not currently persist a `name` key. JSON creation persists `name` from its input;
the creation-mode mismatch is tracked in
[#813](https://github.com/3mdistal/bwrb/issues/813).

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
# Open with system default (default)
bwrb list --name "My Great Idea" --open

# Open in your $EDITOR
bwrb list --name "My Great Idea" --open --app editor

# Just print the path
bwrb list --name "My Great Idea" --open --app print
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

Types form a flat map. A child type points to its parent with `extends`:

```json
{
  "types": {
    "objective": {
      "output_dir": "Objectives",
      "fields": {
        "type": { "value": "objective" }
      }
    },
    "task": {
      "extends": "objective",
      "output_dir": "Objectives/Tasks",
      "fields": {
        "type": { "value": "task" }
      }
    },
    "milestone": {
      "extends": "objective",
      "output_dir": "Objectives/Milestones",
      "fields": {
        "type": { "value": "milestone" }
      }
    }
  }
}
```

Use the child name directly, or slash notation where a command accepts a type
path:

```bash
bwrb new task
bwrb list objective          # Lists all objectives (tasks + milestones)
bwrb list objective/task     # Lists only tasks
```

## Vault Path Resolution

Bowerbird finds your vault in this order:

1. `--vault=<path>` / `-v <path>` flag
2. The nearest parent directory with `.bwrb/schema.json`
3. `BWRB_VAULT` environment variable
4. A single vault discovered under the current directory

`bwrb init` creates a vault instead of finding one, so its target precedence is
different: positional `[path]`, then global `--vault` / `-v`, then the current
directory.

Set a default vault in your shell profile:

```bash
export BWRB_VAULT=~/notes
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `bwrb new <type>` | Create a new note |
| `bwrb edit <path>` | Edit note frontmatter |
| `bwrb delete [query]` | Delete notes from the vault |
| `bwrb list <type>` | List notes of a type |
| `bwrb list --name <query>` | Resolve a note; add `--open` or `--output link` |
| `bwrb list --fuzzy <query>` | Rank approximate name and alias matches |
| `bwrb schema list` | View schema types |
| `bwrb audit` | Check schema compliance |
| `bwrb bulk --type <type> --set key=value` | Apply frontmatter changes in bulk |
| `bwrb template list [type]` | List templates for a type |
| `bwrb dashboard [name]` | Run a saved query |
| `bwrb init [path] --yes` | Initialize a vault with version 2 defaults |
| `bwrb config list` | Show vault config values |
| `bwrb completion <shell>` | Generate shell completion script |

## Next Steps

- [Schema](/concepts/schema/) — Deep dive into schema structure
- [Types and Inheritance](/concepts/types-and-inheritance/) — Organize types hierarchically
- [CLI Reference](/reference/commands/new/) — Full command documentation
- [Templates](/templates/overview/) — Create reusable note structures

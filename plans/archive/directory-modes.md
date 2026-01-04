# Directory Modes

> Flexible organization patterns for different note types

---

## Overview

bwrb supports two directory organization patterns:

1. **Pooled** (default): All notes of a type live in one folder
2. **Instance-grouped**: Notes are grouped under parent instances

This allows flexibility for different use cases — tasks that should be browsable as a collection vs. writing projects where related files should live together.

---

## Pooled Mode

All instances of a type/subtype are stored in a single directory.

### Example Structure

```
Objectives/
  Tasks/
    Buy groceries.md
    Fix bug #123.md
    Write documentation.md
  Milestones/
    Q1 Release.md
    Beta Launch.md
Ideas/
  AI-powered search.md
  New dashboard design.md
```

### Schema Configuration

```json
{
  "types": {
    "objective": {
      "output_dir": "Objectives",
      "dir_mode": "pooled",
      "subtypes": {
        "task": {
          "output_dir": "Tasks"
        },
        "milestone": {
          "output_dir": "Milestones"
        }
      }
    },
    "idea": {
      "output_dir": "Ideas",
      "dir_mode": "pooled"
    }
  }
}
```

### CLI Behavior

```bash
bwrb new objective/task
# Title: Fix bug #123
# → Creates: Objectives/Tasks/Fix bug #123.md

bwrb list objective/task
# Lists all tasks from Objectives/Tasks/
```

### Use Cases

- **Tasks** — Browse all tasks in one place
- **Ideas** — See all ideas at a glance
- **Entities** (people, places, concepts) — Reference library
- Anything you want to browse as a **collection**

---

## Instance-Grouped Mode

Notes are grouped under parent instances. The parent type defines the instance, and subtypes are files within that instance's folder.

### Example Structure

```
Drafts/
  Q1 Blog Post/
    Q1 Blog Post.md       ← Parent/index note (type: draft)
    Draft v1.md           ← Subtype (draft/version)
    Draft v2.md           ← Subtype (draft/version)
    SEO Research.md       ← Subtype (draft/research)
    Feedback.md           ← Subtype (draft/notes)
  Technical Guide/
    Technical Guide.md
    Draft v1.md
    Research.md
Projects/
  Website Redesign/
    Website Redesign.md   ← Parent (type: project)
    Plan.md               ← Subtype (project/plan)
    Log.md                ← Subtype (project/log)
```

### Schema Configuration

```json
{
  "types": {
    "draft": {
      "output_dir": "Drafts",
      "dir_mode": "instance-grouped",
      "frontmatter": {
        "type": { "value": "draft" },
        "status": { "prompt": "select", "enum": "draft-status" }
      },
      "subtypes": {
        "version": {
          "filename": "Draft v{n}.md",
          "frontmatter": {
            "type": { "value": "draft/version" },
            "canonical": { "prompt": "confirm", "default": false }
          }
        },
        "research": {
          "filename": "Research.md",
          "frontmatter": {
            "type": { "value": "draft/research" }
          }
        },
        "notes": {
          "filename": "Notes.md",
          "frontmatter": {
            "type": { "value": "draft/notes" }
          }
        }
      }
    }
  }
}
```

### Key Concepts

#### Parent Type = Instance Field

For instance-grouped types, the **parent type is always the instance field** for subtypes. No need to specify `instance_field` in the schema.

When creating a subtype, the user specifies which parent instance it belongs to:

```bash
bwrb new draft/version --set draft="Q1 Blog Post"
```

#### Parent Note (Index File)

Each instance has a **parent note** that:
- Has the same filename as the folder
- Contains project-level metadata (status, deadline, etc.)
- Serves as the canonical link target

This pattern works beautifully with the **Folder Notes** Obsidian plugin, which makes the parent note "become" the folder when clicked.

#### Folder = Entity

For instance-grouped types, the **folder IS the entity**. The parent note is metadata for that entity.

```bash
bwrb list draft
# Lists all draft instances (folders):
#   Q1 Blog Post
#   Technical Guide
#   Annual Report

bwrb list draft/version
# Lists all version files across all drafts
```

### CLI Behavior

#### Creating a Parent Instance

```bash
bwrb new draft
# Title: Q1 Blog Post
# Status: in-progress
# → Creates: Drafts/Q1 Blog Post/Q1 Blog Post.md
```

#### Creating a Subtype

```bash
bwrb new draft/version
# No draft specified. Select or create a draft:
#   1. Q1 Blog Post
#   2. Technical Guide
#   3. [Create new draft]
# > 1
# → Creates: Drafts/Q1 Blog Post/Draft v2.md

bwrb new draft/version --set draft="Q1 Blog Post"
# → Creates: Drafts/Q1 Blog Post/Draft v3.md
```

#### Listing Instances

```bash
bwrb list draft
# TYPE   NAME              STATUS        FILES
# draft  Q1 Blog Post      in-progress   4
# draft  Technical Guide   planning      2
# draft  Annual Report     done          5

bwrb list draft --instances
# Just instance names (for scripting)
```

#### Listing Subtypes

```bash
bwrb list draft/version
# DRAFT            FILENAME        CANONICAL
# Q1 Blog Post     Draft v1.md     false
# Q1 Blog Post     Draft v2.md     true
# Technical Guide  Draft v1.md     true
```

### Use Cases

- **Writing projects** — Draft, research, notes, resources together
- **Music/art projects** — Versions, references, exports
- **Recurring projects** — Weekly reviews, monthly reports
- Anything where **related files should live together**

---

## Schema Properties

### Type-Level Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `output_dir` | string | required | Base directory for this type |
| `dir_mode` | `"pooled"` \| `"instance-grouped"` | `"pooled"` | Organization pattern |
| `frontmatter` | object | `{}` | Fields for this type |
| `frontmatter_order` | string[] | field order | Display order for fields |
| `subtypes` | object | `{}` | Subtype definitions |

### Subtype-Level Properties (Pooled)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `output_dir` | string | parent's dir | Subdirectory for this subtype |
| `frontmatter` | object | `{}` | Additional fields |
| `frontmatter_order` | string[] | merged | Field order |

### Subtype-Level Properties (Instance-Grouped)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `filename` | string | `"{title}.md"` | Filename pattern for this subtype |
| `frontmatter` | object | `{}` | Fields for this subtype |
| `frontmatter_order` | string[] | merged | Field order |

---

## Filename Patterns

For instance-grouped subtypes, filenames can use patterns:

| Pattern | Description | Example |
|---------|-------------|---------|
| `{title}` | Note title | `My Research.md` |
| `{n}` | Auto-incrementing number | `Draft v3.md` |
| `{date}` | Today's date (YYYY-MM-DD) | `2025-01-15.md` |
| `{date:format}` | Formatted date | `2025-01.md` |
| Static | Literal filename | `Research.md` |

### Example

```json
{
  "subtypes": {
    "version": {
      "filename": "Draft v{n}.md"
    },
    "research": {
      "filename": "Research.md"
    },
    "log": {
      "filename": "{date} Log.md"
    }
  }
}
```

---

## Parent Note Structure

The parent note for an instance-grouped type contains:

1. **Type field** — Identifies this as the parent type
2. **Project metadata** — Status, deadline, tags, etc.
3. **Links to subtypes** — Optional, can be auto-generated
4. **Project overview** — Description, goals, etc.

### Example Parent Note

```markdown
---
type: draft
status: in-progress
deadline: 2025-02-15
tags:
  - builder-blog
  - technical
canonical-version: "[[Draft v2]]"
---

# Q1 Blog Post

## Overview

Technical blog post about new feature X for Builder.io.

## Subtypes

- [[Draft v2]] (current)
- [[SEO Research]]
- [[Feedback]]

## Notes

- Target audience: developers
- Word count goal: 2000
```

---

## Hybrid Scenarios

Some types might have both pooled and instance-grouped elements:

### Example: Projects with Tasks

```json
{
  "types": {
    "project": {
      "output_dir": "Projects",
      "dir_mode": "instance-grouped",
      "subtypes": {
        "plan": { "filename": "Plan.md" },
        "log": { "filename": "Log.md" }
      }
    },
    "objective": {
      "output_dir": "Objectives",
      "dir_mode": "pooled",
      "subtypes": {
        "task": {
          "output_dir": "Tasks",
          "frontmatter": {
            "project": {
              "prompt": "dynamic",
              "source": "projects"
            }
          }
        }
      }
    }
  }
}
```

Here:
- **Projects** are instance-grouped (each project is a folder)
- **Tasks** are pooled (all tasks in one folder)
- Tasks **link to** projects via the `project` field

This gives you the best of both worlds — project-specific files together, but tasks browsable as a collection.

---

## Directory Creation

### Pooled Mode

Directories are created based on schema `output_dir`:

```bash
bwrb new objective/task
# Creates Objectives/Tasks/ if it doesn't exist
# Creates Objectives/Tasks/My Task.md
```

### Instance-Grouped Mode

Instance directories are created when needed:

```bash
bwrb new draft --title "Q1 Blog Post"
# Creates Drafts/ if it doesn't exist
# Creates Drafts/Q1 Blog Post/ if it doesn't exist
# Creates Drafts/Q1 Blog Post/Q1 Blog Post.md

bwrb new draft/version --set draft="Q1 Blog Post"
# Drafts/Q1 Blog Post/ already exists
# Creates Drafts/Q1 Blog Post/Draft v1.md
```

---

## Audit Considerations

Audit should handle both modes:

### Pooled Mode Checks

- File is in correct directory for its type
- No files in type directory without proper `type` field

### Instance-Grouped Mode Checks

- Parent note exists for each instance folder
- Subtype files have correct `type` field
- No orphan folders (folders without parent note)
- Subtype files reference the correct parent

---

## Migration Path

If you're moving from pooled to instance-grouped (or vice versa):

```bash
# 1. Update schema
bwrb schema edit-type draft --dir-mode instance-grouped

# 2. Check what needs to change
bwrb audit draft

# 3. Bulk move files (future feature)
bwrb bulk draft/version --reorg
```

The `--reorg` flag would restructure files to match the new directory mode.

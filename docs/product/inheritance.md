# Pika Inheritance Model

> Single inheritance + context relationships + colocation

---

## Overview

Pika uses a simple, consistent model for organizing notes:

1. **Inheritance** — What a note IS (determines fields)
2. **Context** — What a note SUPPORTS (determines relationships)
3. **Colocation** — Where a note LIVES (determined by context fields)

These three concepts are orthogonal and compose cleanly.

---

## Inheritance ("Is A")

Every type extends exactly one parent. All types ultimately inherit from `meta`.

```
meta
├── reflection
│   ├── daily-note
│   ├── idea
│   └── learning
├── objective
│   ├── goal
│   ├── project
│   ├── milestone
│   └── task
├── draft
│   ├── chapter
│   ├── scene
│   └── research
└── entity
    ├── person
    ├── place
    └── software
```

### Rules

1. **Single inheritance only** — No multiple parents, no mixins
2. **No cycles** — A type cannot extend its own descendant
3. **`meta` is the root** — Implicitly created, cannot be deleted
4. **`meta` cannot extend anything** — It's the top
5. **Unique type names** — No two types can share a name, regardless of position in tree
6. **Implicit extension** — Types without `extends` implicitly extend `meta`

### Field Inheritance

Child types inherit all fields from ancestors:

```json
{
  "meta": {
    "fields": {
      "status": { "prompt": "select", "enum": "status", "default": "raw" },
      "created": { "value": "$NOW" }
    }
  },
  "objective": {
    "extends": "meta",
    "fields": {
      "deadline": { "prompt": "input", "required": false }
    }
  },
  "task": {
    "extends": "objective",
    "fields": {
      "status": { "default": "inbox" },  // Override default only
      "assignee": { "prompt": "dynamic", "source": "person" }
    }
  }
}
```

A `task` note has:
- `status` (from meta, default overridden to "inbox")
- `created` (from meta)
- `deadline` (from objective)
- `assignee` (from task)

### Field Override Rules

Child types can only override **default values**, not field structure:

| Can Override | Cannot Override |
|--------------|-----------------|
| `default` value | `prompt` type |
| | `enum` reference |
| | `required` status |
| | `format` |

If you need fundamentally different behavior, define a new field.

### Type Field in Frontmatter

Notes use the **leaf type name** (not full path):

```yaml
type: task
```

Full path is never needed because type names are unique.

### Type Input in CLI

CLI accepts the type name, validates uniqueness:

```bash
pika new task           # Works (unique name)
pika new daily-note     # Works (unique name)
```

If somehow a name collision existed (schema validation should prevent this), CLI would error with suggestions.

---

## Context ("Supports")

Context fields link notes to what they support, without inheritance.

### Examples

**Task → Milestone:**
```yaml
type: task
milestone: "[[Q1 Launch]]"
```

**Research → Draft:**
```yaml
type: research
for: "[[My Novel]]"
```

**Scene → Chapter:**
```yaml
type: scene
parent: "[[Chapter 1]]"
```

### Context Field Definition

Any wikilink field can be a context relationship:

```json
{
  "task": {
    "extends": "objective",
    "fields": {
      "milestone": {
        "prompt": "dynamic",
        "source": "milestone",
        "format": "wikilink",
        "required": false
      }
    }
  }
}
```

### Source Types

The `source` property controls what notes can be linked:

```json
// Specific type only
"source": "milestone"

// Any type in a branch (includes all descendants)
"source": "objective"  // Accepts goal, project, milestone, task

// Any note in the vault
"source": "any"
```

Using a parent type (like `objective`) automatically includes all its descendants. No need to enumerate subtypes.

### Single vs. Multiple

Context fields can accept one or many values:

```json
// Single value (default)
"milestone": {
  "source": "milestone",
  "multiple": false
}

// Multiple values
"tags": {
  "source": "any",
  "multiple": true
}
```

---

## Colocation ("Lives With")

Colocation determines folder structure based on context relationships.

### The `colocate` Property

When a context field has `colocate: true`, the note lives in the same folder as its context:

```json
{
  "research": {
    "extends": "draft",
    "fields": {
      "for": {
        "prompt": "dynamic",
        "source": "draft",
        "format": "wikilink",
        "colocate": true
      }
    }
  }
}
```

```yaml
type: research
for: "[[My Novel]]"
```

Lives at: `drafts/My Novel/research/Research Note.md`

### Colocation Rules

1. **`colocate: true` requires single value** — Can't colocate with multiple parents
2. **Creates subfolder by type** — Research goes in `parent-folder/research/`
3. **Falls back to default** — If context field is empty, uses type's default folder
4. **Nested colocation** — A colocated note can itself have colocated children

### Folder Structure Examples

**Without colocation (flat by type):**
```
objectives/
└── tasks/
    ├── Fix login bug.md
    ├── Update docs.md
    └── Ship feature.md
```

**With colocation (grouped by context):**
```
drafts/
├── Quick Thought.md                    # No children
└── My Novel/                           # Has colocated children
    ├── My Novel.md
    ├── research/
    │   ├── Character Research.md
    │   └── World Building.md
    └── chapters/
        ├── Chapter 1/
        │   ├── Chapter 1.md
        │   └── scenes/
        │       ├── Opening.md
        │       └── Climax.md
        └── Chapter 2.md
```

### Default Folder Computation

When a note is NOT colocated, its folder is computed from the type hierarchy:

```
type: task
extends: objective
extends: meta

Default folder: objectives/tasks/
```

The path uses pluralized type names from the inheritance chain (excluding meta).

---

## Recursion ("Self-Nesting")

Some types can contain instances of themselves.

### Enabling Recursion

```json
{
  "task": {
    "extends": "objective",
    "recursive": true
  }
}
```

When `recursive: true`:
- A `parent` field is implied (or can be explicitly defined)
- `parent` accepts the same type (task → task)
- Enables hierarchical queries

### Parent Field

The parent field for recursive types:

```json
{
  "task": {
    "extends": "objective",
    "recursive": true,
    "fields": {
      "parent": {
        "prompt": "dynamic",
        "source": "task",      // Same type
        "format": "wikilink",
        "required": false,
        "colocate": true       // Subtasks live with parent
      }
    }
  }
}
```

### Mixed Parent Types

Some types can have a parent of a different type OR self-recurse:

```json
{
  "scene": {
    "extends": "draft",
    "recursive": true,
    "fields": {
      "parent": {
        "source": "chapter",   // Primary parent type
        "colocate": true
      }
    }
  }
}
```

This means:
- A scene's parent can be a `chapter` (the defined source)
- OR a scene's parent can be another `scene` (because recursive: true)

### Hierarchical Queries

Recursion enables tree-based queries:

```bash
pika list task --tree              # Render as hierarchy
pika list task --roots             # Only tasks with no parent
pika list task --children-of "[[Epic]]"  # Direct children
pika list task --descendants-of "[[Epic]]"  # All nested
pika list task --depth 2           # Top 2 levels only
```

---

## Abstract vs. Concrete Types

Types can be abstract (no direct instances) or concrete (has instances).

### Inference Rules

Pika infers this from usage:

1. **Has colocating children** → Concrete (the parent instances exist)
2. **Has notes with this exact type** → Concrete
3. **Neither of the above** → Abstract

### Query Behavior

```bash
# Abstract type: recursive by default
pika list objective          # Returns tasks, milestones, goals, projects

# Concrete type: exact by default  
pika list task               # Returns only tasks

# Override with flags
pika list objective --exact      # Only type: objective (probably none)
pika list task --recursive       # Tasks and any task subtypes
```

### Output Clarity

When listing an abstract type, output shows actual types:

```
$ pika list objective

TYPE       NAME                 STATUS
task       Fix login bug        in-flight
task       Update docs          planned
milestone  Q1 Launch            on-deck
goal       Ship v1.0            raw
```

---

## Schema Structure

### Full Example

```json
{
  "enums": {
    "status": ["raw", "inbox", "planned", "in-flight", "blocked", "done", "dropped"],
    "draft-status": ["idea", "outlining", "drafting", "revising", "done"]
  },
  
  "types": {
    "meta": {
      "fields": {
        "status": { "prompt": "select", "enum": "status", "default": "raw" },
        "created": { "value": "$NOW" },
        "modified": { "value": "$NOW" }
      }
    },
    
    "reflection": {
      "fields": {
        "date": { "value": "$TODAY" }
      }
    },
    
    "daily-note": {
      "extends": "reflection"
    },
    
    "idea": {
      "extends": "reflection"
    },
    
    "objective": {
      "fields": {
        "deadline": { "prompt": "input", "required": false }
      }
    },
    
    "goal": {
      "extends": "objective"
    },
    
    "project": {
      "extends": "objective",
      "fields": {
        "goal": {
          "prompt": "dynamic",
          "source": "goal",
          "format": "wikilink"
        }
      }
    },
    
    "milestone": {
      "extends": "objective",
      "fields": {
        "project": {
          "prompt": "dynamic",
          "source": "project",
          "format": "wikilink"
        }
      }
    },
    
    "task": {
      "extends": "objective",
      "recursive": true,
      "fields": {
        "status": { "default": "inbox" },
        "milestone": {
          "prompt": "dynamic",
          "source": "milestone",
          "format": "wikilink"
        },
        "parent": {
          "prompt": "dynamic",
          "source": "task",
          "format": "wikilink",
          "colocate": true
        }
      }
    },
    
    "draft": {
      "fields": {
        "draft-status": { "prompt": "select", "enum": "draft-status", "default": "idea" }
      }
    },
    
    "chapter": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "parent": {
          "prompt": "dynamic",
          "source": "draft",
          "format": "wikilink",
          "colocate": true
        }
      }
    },
    
    "scene": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "parent": {
          "prompt": "dynamic",
          "source": "chapter",
          "format": "wikilink",
          "colocate": true
        }
      }
    },
    
    "research": {
      "extends": "draft",
      "fields": {
        "for": {
          "prompt": "dynamic",
          "source": "draft",
          "format": "wikilink",
          "colocate": true
        }
      }
    },
    
    "entity": {},
    
    "person": {
      "extends": "entity",
      "fields": {
        "email": { "prompt": "input" }
      }
    },
    
    "place": {
      "extends": "entity",
      "fields": {
        "location": { "prompt": "input" }
      }
    },
    
    "software": {
      "extends": "entity",
      "fields": {
        "url": { "prompt": "input" }
      }
    }
  }
}
```

### Validation Rules

Pika validates schemas on load:

1. **No duplicate type names** — Error if two types share a name
2. **No circular extends** — Error if A extends B extends A
3. **Valid extends targets** — Referenced parent must exist
4. **Valid source targets** — Referenced types in `source` must exist
5. **Colocate requires single** — Error if `colocate: true` with `multiple: true`
6. **Recursive implies parent** — Warning if `recursive: true` but no parent-like field

---

## Migration from ovault

### Old Model (ovault)

```json
{
  "types": {
    "objective": {
      "subtypes": {
        "task": {
          "output_dir": "Objectives/Tasks",
          "frontmatter": { ... }
        }
      }
    }
  }
}
```

### New Model (Pika)

```json
{
  "types": {
    "objective": { },
    "task": {
      "extends": "objective",
      "fields": { ... }
    }
  }
}
```

### Key Changes

| ovault | Pika |
|--------|------|
| Nested `subtypes` | Flat types with `extends` |
| `output_dir` explicit | Computed from hierarchy + colocation |
| `frontmatter` object | `fields` object |
| `type` + `{type}-type` fields | Single `type` field |

### Migration Steps

1. Flatten nested subtypes into top-level types with `extends`
2. Remove `output_dir` (let Pika compute, or use colocation)
3. Rename `frontmatter` to `fields`
4. Update notes: remove `{type}-type` field, keep only `type` with leaf name

---

## Summary

| Concept | Purpose | Mechanism |
|---------|---------|-----------|
| **Inheritance** | What a note IS | `extends` property, single parent |
| **Context** | What a note SUPPORTS | Wikilink fields with `source` |
| **Colocation** | Where a note LIVES | `colocate: true` on context fields |
| **Recursion** | Self-nesting | `recursive: true` on type |
| **Abstract/Concrete** | Query defaults | Inferred from usage |

The model is simple: inherit fields from one parent, link to context via fields, optionally live with your context. Everything else composes from these primitives.

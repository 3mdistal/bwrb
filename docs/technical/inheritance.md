# Bowerbird Inheritance Model

> Single inheritance + context relationships + ownership

---

## Overview

Bowerbird uses a simple, consistent model for organizing notes:

1. **Inheritance** — What a note IS (determines fields)
2. **Context** — What a note SUPPORTS (determines relationships)
3. **Ownership** — Whether a note is PRIVATE to its context (determines folder structure)

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
bwrb new task           # Works (unique name)
bwrb new daily-note     # Works (unique name)
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

## Ownership ("Belongs To")

Ownership determines whether notes are private to their context and where they live.

### The `owned` Property

The **parent** declares ownership of its children using `owned: true` on a context field:

```json
{
  "draft": {
    "extends": "meta",
    "fields": {
      "research": {
        "prompt": "dynamic",
        "source": "research",
        "format": "wikilink",
        "multiple": true,
        "owned": true
      },
      "related-research": {
        "prompt": "dynamic",
        "source": "research", 
        "format": "wikilink",
        "multiple": true,
        "owned": false
      }
    }
  }
}
```

```yaml
# My Novel.md
type: draft
research: ["[[Character Research]]", "[[World Building]]"]
related-research: ["[[General Fantasy Tropes]]"]
```

- `Character Research` and `World Building` are **owned** by My Novel
  - They live in `drafts/My Novel/research/`
  - No other note can reference them in any schema field
- `General Fantasy Tropes` is **not owned**
  - It lives in `research/` (its default location)
  - Other drafts can also reference it

### Ownership Rules

1. **Ownership is declared by the parent** — The field with `owned: true` is on the parent, not the child
2. **Owned notes are exclusive** — An owned note cannot be referenced by ANY schema field on any other note
3. **Owned notes colocate automatically** — They live in the owner's folder, in a subfolder by type
4. **`owned: true` works with `multiple: true`** — A parent can own multiple children
5. **Body wikilinks are unrestricted** — You can always link to any note in body text

### Folder Structure Examples

**Without ownership (flat by type):**
```
objectives/
└── tasks/
    ├── Fix login bug.md
    ├── Update docs.md
    └── Ship feature.md

research/
├── Character Research.md
├── World Building.md
└── General Fantasy Tropes.md
```

**With ownership (grouped by owner):**
```
drafts/
├── Quick Thought.md                    # No owned children
└── My Novel/                           # Has owned children
    ├── My Novel.md
    ├── research/
    │   ├── Character Research.md       # Owned by My Novel
    │   └── World Building.md           # Owned by My Novel
    └── chapters/
        ├── Chapter 1/
        │   ├── Chapter 1.md
        │   └── scenes/
        │       ├── Opening.md
        │       └── Climax.md
        └── Chapter 2.md

research/
└── General Fantasy Tropes.md           # Shared, not owned
```

### Ownership vs. Shared References

Choose based on your use case:

| Use Case | Ownership | Field Config |
|----------|-----------|--------------|
| "This research is ONLY for this novel" | Owned | `owned: true` |
| "This research is useful across drafts" | Shared | `owned: false` (or omit) |
| "Link to related context without ownership" | Reference | Any field without `owned` |

### Default Folder Computation

When a note is NOT owned, its folder is computed from the type hierarchy:

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

The parent field for recursive types. Note that for recursion, the **child** declares its parent (inverse of ownership):

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
        "required": false
      }
    }
  }
}
```

For subtasks to live with their parent, the **parent task** would have an `owned: true` field pointing to child tasks. But in practice, recursive types often just use the parent reference for hierarchy without strict ownership.

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
        "format": "wikilink"
      }
    }
  }
}
```

This means:
- A scene's parent can be a `chapter` (the defined source)
- OR a scene's parent can be another `scene` (because recursive: true)

### Cycle Detection

Bowerbird prevents parent cycles that would create infinite loops:

```yaml
# Task A
type: task
parent: "[[Task B]]"

# Task B  
type: task
parent: "[[Task A]]"   # ERROR: Would create cycle A → B → A
```

**Behavior:**
- `bwrb new` and `bwrb edit` check for cycles before saving
- Self-references are blocked (a note cannot be its own parent)
- Error message shows the full cycle path for debugging
- `bwrb audit` also detects cycles in existing notes

### Hierarchical Queries

Recursion enables tree-based queries:

```bash
bwrb list task --tree              # Render as hierarchy
bwrb list task --roots             # Only tasks with no parent
bwrb list task --children-of "[[Epic]]"  # Direct children
bwrb list task --descendants-of "[[Epic]]"  # All nested
bwrb list task --depth 2           # Top 2 levels only
```

---

## Abstract vs. Concrete Types

Types can be abstract (no direct instances) or concrete (has instances).

### Inference Rules

Bowerbird infers this from usage:

1. **Has owned children** → Concrete (the parent instances exist)
2. **Has notes with this exact type** → Concrete
3. **Neither of the above** → Abstract

### Query Behavior

```bash
# Abstract type: recursive by default
bwrb list objective          # Returns tasks, milestones, goals, projects

# Concrete type: exact by default  
bwrb list task               # Returns only tasks

# Override with flags
bwrb list objective --exact      # Only type: objective (probably none)
bwrb list task --recursive       # Tasks and any task subtypes
```

### Output Clarity

When listing an abstract type, output shows actual types:

```
$ bwrb list objective

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
        "subtasks": {
          "prompt": "dynamic",
          "source": "task",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "draft": {
      "fields": {
        "draft-status": { "prompt": "select", "enum": "draft-status", "default": "idea" },
        "chapters": {
          "prompt": "dynamic",
          "source": "chapter",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        },
        "research": {
          "prompt": "dynamic",
          "source": "research",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "chapter": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "scenes": {
          "prompt": "dynamic",
          "source": "scene",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        },
        "subchapters": {
          "prompt": "dynamic",
          "source": "chapter",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "scene": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "subscenes": {
          "prompt": "dynamic",
          "source": "scene",
          "format": "wikilink",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "research": {
      "extends": "draft"
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

Bowerbird validates schemas on load:

1. **No duplicate type names** — Error if two types share a name
2. **No circular extends** — Error if A extends B extends A
3. **Valid extends targets** — Referenced parent must exist
4. **Valid source targets** — Referenced types in `source` must exist
5. **Owned notes are exclusive** — Error if a note is referenced by multiple `owned: true` fields
6. **Recursive implies ownership or parent** — Warning if `recursive: true` but no ownership field or parent-like field

---

## Migration from Legacy Schema

### Old Model (Legacy)

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

### New Model (Bowerbird)

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

| Legacy | New |
|--------|------|
| Nested `subtypes` | Flat types with `extends` |
| `output_dir` explicit | Computed from hierarchy + ownership |
| `frontmatter` object | `fields` object |
| `type` + `{type}-type` fields | Single `type` field |
| Instance-grouped types | `owned: true` on parent's field |

### Migration Steps

1. Flatten nested subtypes into top-level types with `extends`
2. Remove `output_dir` (let Bowerbird compute, or use colocation)
3. Rename `frontmatter` to `fields`
4. Update notes: remove `{type}-type` field, keep only `type` with leaf name

---

## Summary

| Concept | Purpose | Mechanism |
|---------|---------|-----------|
| **Inheritance** | What a note IS | `extends` property, single parent |
| **Context** | What a note SUPPORTS | Wikilink fields with `source` |
| **Ownership** | Whether a note is PRIVATE | `owned: true` on parent's field |
| **Recursion** | Self-nesting | `recursive: true` on type |
| **Abstract/Concrete** | Query defaults | Inferred from usage |

The model is simple: 
- Inherit fields from one parent
- Link to context via fields  
- Optionally own your children (they become private and colocate with you)
- Body wikilinks are always unrestricted

Everything else composes from these primitives.

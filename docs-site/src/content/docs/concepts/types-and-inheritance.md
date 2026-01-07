---
title: Types and Inheritance
description: Hierarchical type definitions and field inheritance
---

Bowerbird uses strict type inheritance to reduce duplication and ensure consistency.

## Type Hierarchy

Types form a single-inheritance tree. Every type extends exactly one parent, and all types ultimately inherit from `meta`:

```
meta (global fields)
├── reflection
│   ├── daily-note
│   └── idea
├── objective
│   ├── task
│   └── milestone
└── entity
    ├── person
    └── place
```

## Defining Types

Types are defined with the `extends` property linking to their parent:

```json
{
  "types": {
    "meta": {
      "fields": {
        "status": { "prompt": "select", "options": ["raw", "active", "done"] },
        "created": { "value": "$NOW" }
      }
    },
    "objective": {
      "fields": {
        "deadline": { "prompt": "date" }
      }
    },
    "task": {
      "extends": "objective",
      "fields": {
        "priority": { "prompt": "select", "options": ["low", "medium", "high"] }
      }
    }
  }
}
```

A `task` note gets:
- `status` and `created` from `meta`
- `deadline` from `objective`  
- `priority` from itself

## Inheritance Rules

1. **Single inheritance** — Each type has exactly one parent
2. **Unique names** — Type names must be unique across the entire schema
3. **No cycles** — A type cannot extend its own descendant
4. **Override defaults only** — Child types can override `default` values, but not field structure

## Field Types

Fields define what data each note type collects:

- **Static** — Fixed value: `{ "value": "$NOW" }`
- **Text** — Free input: `{ "prompt": "text" }`
- **Select** — Choose from options: `{ "prompt": "select", "options": [...] }`
- **Relation** — Link to other notes: `{ "prompt": "relation", "source": "milestone" }`
- **Number**, **Boolean**, **Date**, **List** — Other prompt types

## Next Steps

- [Schema Reference](/reference/schema/) — Complete property reference
- [Migrations](/concepts/migrations/) — Evolving your type system

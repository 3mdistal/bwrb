---
title: Types and Inheritance
description: Hierarchical type definitions and field inheritance
---

Bowerbird uses strict type inheritance to reduce duplication and ensure consistency.

## Type Hierarchy

Types can be nested to create hierarchies:

```json
{
  "types": {
    "objective": {
      "subtypes": {
        "task": { ... },
        "milestone": { ... },
        "project": { ... }
      }
    },
    "idea": { ... }
  }
}
```

Reference types with slash notation: `objective/task`, `objective/milestone`.

## Inheritance

Child types inherit all fields from their parent types.

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

## Field Definitions

Each type needs:

- `output_dir` — Where notes are saved
- `frontmatter` — Field definitions

Fields can be:
- **Static** — Fixed value: `{ "value": "task" }`
- **Select** — Choose from options: `{ "prompt": "select", "options": [...] }`
- **Text** — Free input: `{ "prompt": "text" }`
- **Relation** — Link to other notes: `{ "prompt": "relation", "source": "objective/milestone" }`

## Next Steps

- [Schema reference](/concepts/schema/) — Full schema documentation
- [Migrations](/concepts/migrations/) — Evolving your type system

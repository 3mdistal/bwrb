# Pika Type System

> PM-friendly overview of how types work in Pika

For technical implementation details, see `docs/technical/inheritance.md`.

---

## Core Concepts

### 1. Types Have Parents (Inheritance)

Every type extends exactly one parent. All types ultimately inherit from `meta`.

```
meta (global fields: status, created)
├── reflection (date)
│   ├── daily-note
│   └── idea
├── objective (deadline)
│   ├── task
│   └── milestone
└── draft (draft-status)
    ├── chapter
    └── research
```

**What this means:**
- A `task` automatically has all `objective` fields AND all `meta` fields
- Add a field to `meta` → every note gets it
- No duplicate field definitions

### 2. Types Link to Context (Relationships)

Notes can link to other notes via context fields:

- Task → Milestone ("this task is part of Q1 Launch")
- Research → Draft ("this research supports My Novel")
- Scene → Chapter ("this scene belongs to Chapter 1")

**What this means:**
- Relationships are typed — a task's `milestone` field only accepts milestones
- Broken links are caught by audit
- You can query by relationship

### 3. Parents Can Own Children (Ownership)

A parent can declare that it "owns" its children:

- Draft owns its research → research lives in draft's folder
- Draft owns its chapters → chapters live in draft's folder
- Owned notes can't be referenced by other notes

**What this means:**
- `drafts/My Novel/research/Character Notes.md` — owned, private to this draft
- `research/General Fantasy Tropes.md` — shared, any draft can reference it
- Choose based on use case: private vs. shared

### 4. Some Types Self-Nest (Recursion)

Tasks can contain subtasks. Chapters can contain subchapters.

**What this means:**
- Tree queries: "show me all subtasks of Epic X"
- Hierarchical organization without new types

---

## Design Principles

### Unique Type Names
No two types can share a name. `type: task` is always unambiguous.

### Single Inheritance
A type has exactly one parent. No mixins, no multiple inheritance. Simple.

### Ownership is Optional
Not everything needs to be owned. Use ownership for private/internal notes, skip it for shared resources.

### Body Links Are Free
Schema fields are typed and validated. Body text wikilinks are unrestricted — link to anything.

---

## User Decisions

When creating a type, the user decides:

1. **What does it extend?** (determines inherited fields)
2. **What fields does it add?** (its unique data)
3. **Does it own children?** (private notes that live with it)
4. **Is it recursive?** (can contain instances of itself)

---

## Out of Scope

The type system does NOT handle:
- Sync (use Git)
- Version control (use Git)
- Note content/body (just frontmatter)
- Publishing (separate tools)

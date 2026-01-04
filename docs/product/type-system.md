# Bowerbird Type System

> PM-friendly overview of how types work in Bowerbird

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

**Validation behavior:**
- **CLI commands** (`bwrb new`, `bwrb edit`): Interactive pickers show only valid targets. In JSON mode, invalid references are rejected with clear error messages.
- **External edits**: Files can drift (e.g., target note renamed). `bwrb audit` catches broken links and type mismatches; `bwrb audit --fix` offers guided remediation.

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

#### Recursion + Inheritance (Mixed Hierarchies)

A type can be both recursive AND extend a parent type. When this happens, the auto-generated `parent` field accepts either:

- The extended type (inheritance relationship)
- The same type (recursive nesting)

This is single inheritance with optional self-nesting — not multiple inheritance.

**Example:** A `scene` type with `extends: "chapter"` and `recursive: true`:

```
chapter: "Act One"          ← scene's parent can be a chapter
  └── scene: "Opening"
        └── scene: "Flashback"  ← or another scene
```

| Valid parent for `scene` | Reason |
|--------------------------|--------|
| `[[Act One]]` (chapter)  | Inheritance: scene extends chapter |
| `[[Opening]]` (scene)    | Recursion: scene is recursive |
| `[[Some Task]]` (task)   | Invalid: not chapter or scene |
| `[[Self]]` (itself)      | Invalid: would create a cycle |

**Common patterns:**
- `task` extends `objective`, but tasks can have subtasks
- `scene` extends `chapter`, but scenes can have sub-scenes

**Cycle prevention:** Circular parent references are blocked at creation time.
- `bwrb new` and `bwrb edit` reject changes that would create cycles
- `bwrb audit` detects cycles introduced by external edits
- Self-references (A → A) are also blocked

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

## Ownership Visibility

Owned notes have special visibility rules:

| Command | Owned Notes | Rationale |
|---------|-------------|-----------|
| `bwrb list` | **Included** | Discovery — nothing feels lost |
| `bwrb search` | **Included** | Discovery — find any note by content |
| Field prompts | **Excluded** | Can't reference owned notes in frontmatter |
| `bwrb open` | **Included** | Can open any note directly |

**Why exclude from field prompts?**

When selecting a value for a field (e.g., "which research note?"), owned notes don't appear because they can't be referenced by other notes' frontmatter. This enforces the ownership boundary — if you need to reference something across notes, it should be shared (in the type's folder), not owned.

**Body wikilinks are unrestricted.** You can manually type `[[Owned Note]]` in the body — the schema doesn't validate body content.

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

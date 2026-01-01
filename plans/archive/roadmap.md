# pika Roadmap

> Schema-driven management for Obsidian vaults — evolving into a comprehensive CLI for structured note management, auditing, and agentic workflows.

---

## Vision

pika is a CLI tool that brings structure, consistency, and automation to Obsidian vaults. It provides:

1. **Schema-driven note creation** — Types, subtypes, and fields defined in a central schema
2. **Flexible organization** — Both pooled and instance-grouped directory structures
3. **Vault health** — Audit, lint, and bulk operations for consistency
4. **Query power** — Obsidian Bases-compatible filtering and querying
5. **Automation** — Templates, recurrence, and agentic workflows

---

## Current State (v1 — Shell)

**Implemented:**
- `pika new [type]` — Interactive note creation with schema-driven frontmatter
- `pika edit <file>` — Edit existing frontmatter fields
- `pika list [options] <type>` — List/filter objects with table output
- `pika help` — Usage documentation
- Hierarchical type/subtype navigation
- Dynamic sources for field queries (e.g., active milestones)
- Multi-vault support via `--vault` flag and `OVAULT_VAULT` env var
- Schema validation (`validate_schema.sh`)

**Limitations:**
- Shell scripting limits testing, types, and complex logic
- No shared fields across types
- Limited query operators
- No audit or bulk operations
- No template system

---

## Phase 0: TypeScript Migration

**Priority: Critical — All other work depends on this**

Before adding new features, migrate the entire codebase from Bash to TypeScript. This provides:

- **Type safety** — Catch bugs at compile time
- **Testing** — Vitest for comprehensive test coverage
- **Maintainability** — Easier to refactor and extend
- **Agentic readiness** — Async/await, API calls, streaming
- **Expression parsing** — For Bases-compatible queries

See: [features/typescript-migration.md](features/typescript-migration.md)

---

## Phase 1: Core CLI Polish

### 1.1 Shared Fields

Define fields that apply to all note types (e.g., `status`, `scopes`). Types can opt-in to shared fields and override defaults.

See: [features/shared-fields.md](features/shared-fields.md)

### 1.2 Directory Modes

Support two organizational patterns:

- **Pooled** (default): All notes of a type in one folder (e.g., `Objectives/Tasks/`)
- **Instance-grouped**: Notes grouped under parent instances (e.g., `Drafts/Q1 Blog Post/`)

See: [features/directory-modes.md](features/directory-modes.md)

### 1.3 Open in Obsidian

```bash
pika open <file>                    # Open file in Obsidian
pika new idea --open                # Create and open
pika edit Tasks/My\ Task.md --open  # Edit and open
```

Uses Obsidian's URI scheme: `obsidian://open?vault=NAME&file=PATH`

### 1.4 Query System (Bases Parity)

Full expression-based filtering compatible with Obsidian Bases:

```bash
pika list task --where "status == 'in-progress'"
pika list task --where "priority < 3 && !isEmpty(deadline)"
pika list task --where "deadline < today() + '7d'"
```

See: [features/query-system.md](features/query-system.md)

### 1.5 Schema Show Command

```bash
pika schema show                    # Tree view of all types
pika schema show objective/task     # Show specific type definition
pika schema validate                # Validate schema structure
```

---

## Phase 2: Audit & Bulk Operations

### 2.1 Audit Command

Validate files against schema and surface mismatches:

```bash
pika audit                      # Check all files (report only)
pika audit objective/task       # Check specific type
pika audit --fix                # Interactive repair mode
pika audit --fix --auto         # Automatic fixes where unambiguous
pika audit --strict             # Error on unknown fields
```

See: [features/audit-command.md](features/audit-command.md)

### 2.2 Bulk Operations

Mass changes across filtered file sets:

```bash
pika bulk task --set status=done --where "status == 'in-progress'"
pika bulk idea --move Archive/Ideas --where "status == 'settled'"
pika bulk objective --rename old-field=new-field
```

Features:
- Dry-run by default, `--execute` to apply
- Optional `--backup` for safety
- Git status warnings
- Wikilink auto-update on file moves

See: [features/bulk-operations.md](features/bulk-operations.md)

---

## Phase 3: Template System

### 3.1 Basic Templates

Markdown-based templates with defaults and body structure:

```bash
pika new task                           # Prompts for template if multiple
pika new task --template bug-report     # Use specific template
pika new task --default                 # Use default template
```

Templates live in `Templates/{type}/{subtype}/{name}.md`.

### 3.2 Template Constraints

Templates can narrow schema requirements:

```yaml
---
type: template
template-for: objective/task
constraints:
  deadline:
    required: true
    validate: "this < today() + '5d'"
    error: "Deadline must be within 5 days for urgent tasks"
defaults:
  priority: critical
---
```

### 3.3 Parent Templates (Instance Scaffolding)

Templates for instance-grouped types can scaffold entire project structures:

```yaml
---
type: template
template-for: draft
instances:
  - subtype: version
    filename: "Draft v1.md"
  - subtype: research
    template: Templates/draft/research/seo.md
    filename: "SEO Research.md"
  - subtype: notes
    filename: "Feedback.md"
---
```

See: [features/template-system.md](features/template-system.md)

---

## Phase 4: Schema Management CLI

Full CLI for schema manipulation — never touch JSON directly:

```bash
# Type management
pika schema add-type writing
pika schema edit-type writing
pika schema remove-type writing

# Field management
pika schema add-field deadline task
pika schema edit-field deadline task

# Enum management
pika schema add-enum priority
pika schema edit-enum status --add archived
pika schema edit-enum status --rename wip=in-progress

# Migration
pika schema diff                # Show pending changes
pika schema apply               # Apply migrations to files
```

See: [features/schema-management.md](features/schema-management.md)

---

## Phase 5: Recurrence & Advanced Templates

### 5.1 Recurrence Rules

Define recurring task/project creation:

```json
{
  "name": "weekly-review",
  "template": "weekly-review",
  "schedule": "0 9 * * 1",
  "title_pattern": "Weekly Review - {date:YYYY-MM-DD}"
}
```

```bash
pika recur list                 # Show configured recurrences
pika recur spawn                # Create due instances
pika recur spawn --dry-run      # Preview
```

### 5.2 Output Formats

```bash
pika list task --format=json
pika list task --format=csv
pika list task --format=dataview
```

---

## Phase 6: Agentic Workflows

### 6.1 Prompt & Agent Storage

Schema types for managing AI assets:

```bash
pika new prompt --set model=claude-sonnet
pika new agent --set tools="web-search,summarize"
```

### 6.2 Workflow Execution

```bash
pika run Workflows/blog-research.md --topic="AI agents"
pika run --status  # Show running/completed workflows
```

### 6.3 Cost Tracking

```bash
pika costs                      # Spending summary
pika costs --period=week        # This week's usage
pika costs --workflow=research  # By workflow type
```

See: [features/agentic-workflows.md](features/agentic-workflows.md)

---

## Phase 7: Future Considerations

### 7.1 Lint Command

Broader markdown hygiene (separate from schema audit):

```bash
pika lint                   # Check all files
pika lint --fix             # Auto-fix where possible
```

Checks: broken wikilinks, orphan files, duplicate filenames, heading hierarchy

### 7.2 Base Generation

Generate Obsidian Bases queries from CLI filters:

```bash
pika base task --where "status == 'in-progress'" --where "scope == 'week'"
# Outputs .base file or dataview query
```

---

## Implementation Priority

| Phase | Features | Priority |
|-------|----------|----------|
| 0 | TypeScript Migration | P0 — Blocking |
| 1.1 | Shared Fields | P1 |
| 1.2 | Directory Modes | P1 |
| 1.3 | Open in Obsidian | P1 |
| 1.4 | Query System | P1 |
| 1.5 | Schema Show | P2 |
| 2.1 | Audit Command | P1 |
| 2.2 | Bulk Operations | P2 |
| 3.x | Template System | P2 |
| 4.x | Schema Management CLI | P2 |
| 5.x | Recurrence | P3 |
| 6.x | Agentic Workflows | P4 |
| 7.x | Lint, Base Generation | P4 |

---

## Technical Architecture

### Language: TypeScript

- **Runtime:** Node.js (or Bun for faster startup)
- **CLI Framework:** Commander or Oclif
- **Testing:** Vitest
- **Schema Validation:** Zod (runtime + compile-time)
- **Frontmatter:** gray-matter
- **Expression Parsing:** jsep or expr-eval
- **File Operations:** fast-glob, fs-extra

### Schema Location

`.pika/schema.json` in vault root

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Type field is authoritative | Never infer type from directory |
| Parent type = instance field | For instance-grouped, parent type names the instance |
| Parent note for instances | Folder name matches parent note name (Folder Notes plugin compatible) |
| Templates are markdown | Manage templates in Obsidian like any other note |
| User manages git | pika warns about dirty state but doesn't auto-commit |
| Auto-apply deterministic migrations | Enum renames, field additions with defaults |
| Prompt for non-deterministic | Field removal, type changes |

---

## Feature Documentation

Detailed specifications for each feature:

- [TypeScript Migration](features/typescript-migration.md)
- [Shared Fields](features/shared-fields.md)
- [Directory Modes](features/directory-modes.md)
- [Query System](features/query-system.md)
- [Audit Command](features/audit-command.md)
- [Bulk Operations](features/bulk-operations.md)
- [Template System](features/template-system.md)
- [Schema Management](features/schema-management.md)
- [Agentic Workflows](features/agentic-workflows.md)

---

## Dependencies & Considerations

**External dependencies to consider:**
- `yq` for robust YAML parsing/writing (alternative to gray-matter)
- `rg` (ripgrep) for fast wikilink searching

**Cross-platform considerations:**
- Obsidian URI scheme has macOS/Linux/Windows quirks
- Path separators and case sensitivity

**Performance at scale:**
- TypeScript with V8 is sufficient for 10K+ files
- Add caching/indexing if needed (SQLite like Obsidian does)

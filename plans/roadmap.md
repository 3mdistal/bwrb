# ovault Roadmap

> Schema-driven management for Obsidian vaults — evolving into a comprehensive CLI for structured note management, auditing, and agentic workflows.

---

## Vision

ovault is a CLI tool that brings structure, consistency, and automation to Obsidian vaults. It provides:

1. **Schema-driven note creation** — Types, subtypes, and fields defined in a central schema
2. **Flexible organization** — Both pooled and instance-grouped directory structures
3. **Vault health** — Audit, lint, and bulk operations for consistency
4. **Query power** — Obsidian Bases-compatible filtering and querying
5. **Automation** — Templates, recurrence, and agentic workflows

---

## Current State (v1 — Shell)

**Implemented:**
- `ovault new [type]` — Interactive note creation with schema-driven frontmatter
- `ovault edit <file>` — Edit existing frontmatter fields
- `ovault list [options] <type>` — List/filter objects with table output
- `ovault help` — Usage documentation
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
ovault open <file>                    # Open file in Obsidian
ovault new idea --open                # Create and open
ovault edit Tasks/My\ Task.md --open  # Edit and open
```

Uses Obsidian's URI scheme: `obsidian://open?vault=NAME&file=PATH`

### 1.4 Query System (Bases Parity)

Full expression-based filtering compatible with Obsidian Bases:

```bash
ovault list task --where "status == 'in-progress'"
ovault list task --where "priority < 3 && !isEmpty(deadline)"
ovault list task --where "deadline < today() + '7d'"
```

See: [features/query-system.md](features/query-system.md)

### 1.5 Schema Show Command

```bash
ovault schema show                    # Tree view of all types
ovault schema show objective/task     # Show specific type definition
ovault schema validate                # Validate schema structure
```

---

## Phase 2: Audit & Bulk Operations

### 2.1 Audit Command

Validate files against schema and surface mismatches:

```bash
ovault audit                      # Check all files (report only)
ovault audit objective/task       # Check specific type
ovault audit --fix                # Interactive repair mode
ovault audit --fix --auto         # Automatic fixes where unambiguous
ovault audit --strict             # Error on unknown fields
```

See: [features/audit-command.md](features/audit-command.md)

### 2.2 Bulk Operations

Mass changes across filtered file sets:

```bash
ovault bulk task --set status=done --where "status == 'in-progress'"
ovault bulk idea --move Archive/Ideas --where "status == 'settled'"
ovault bulk objective --rename old-field=new-field
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
ovault new task                           # Prompts for template if multiple
ovault new task --template bug-report     # Use specific template
ovault new task --default                 # Use default template
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
ovault schema add-type writing
ovault schema edit-type writing
ovault schema remove-type writing

# Field management
ovault schema add-field deadline task
ovault schema edit-field deadline task

# Enum management
ovault schema add-enum priority
ovault schema edit-enum status --add archived
ovault schema edit-enum status --rename wip=in-progress

# Migration
ovault schema diff                # Show pending changes
ovault schema apply               # Apply migrations to files
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
ovault recur list                 # Show configured recurrences
ovault recur spawn                # Create due instances
ovault recur spawn --dry-run      # Preview
```

### 5.2 Output Formats

```bash
ovault list task --format=json
ovault list task --format=csv
ovault list task --format=dataview
```

---

## Phase 6: Agentic Workflows

### 6.1 Prompt & Agent Storage

Schema types for managing AI assets:

```bash
ovault new prompt --set model=claude-sonnet
ovault new agent --set tools="web-search,summarize"
```

### 6.2 Workflow Execution

```bash
ovault run Workflows/blog-research.md --topic="AI agents"
ovault run --status  # Show running/completed workflows
```

### 6.3 Cost Tracking

```bash
ovault costs                      # Spending summary
ovault costs --period=week        # This week's usage
ovault costs --workflow=research  # By workflow type
```

See: [features/agentic-workflows.md](features/agentic-workflows.md)

---

## Phase 7: Future Considerations

### 7.1 Lint Command

Broader markdown hygiene (separate from schema audit):

```bash
ovault lint                   # Check all files
ovault lint --fix             # Auto-fix where possible
```

Checks: broken wikilinks, orphan files, duplicate filenames, heading hierarchy

### 7.2 Base Generation

Generate Obsidian Bases queries from CLI filters:

```bash
ovault base task --where "status == 'in-progress'" --where "scope == 'week'"
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

`.ovault/schema.json` in vault root

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Type field is authoritative | Never infer type from directory |
| Parent type = instance field | For instance-grouped, parent type names the instance |
| Parent note for instances | Folder name matches parent note name (Folder Notes plugin compatible) |
| Templates are markdown | Manage templates in Obsidian like any other note |
| User manages git | ovault warns about dirty state but doesn't auto-commit |
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

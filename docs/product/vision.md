# Bowerbird Product Vision

> Schema enforcement for Markdown. Type-safe personal knowledge management.

---

## What is Bowerbird?

Bowerbird is a CLI tool that enforces strict schemas on Markdown/YAML files. It brings TypeScript-style type safety to personal knowledge management—your notes can't violate the schema, your queries always return valid data, and migrations are explicit.

**One-liner:** Bowerbird is the type system for your notes.

---

## The Three Circles

Bowerbird's functionality exists in concentric layers of priority:

```
┌─────────────────────────────────────────┐
│                                         │
│   ┌─────────────────────────────────┐   │
│   │                                 │   │
│   │   ┌─────────────────────────┐   │   │
│   │   │                         │   │   │
│   │   │        SCHEMA           │   │   │
│   │   │   Type enforcement      │   │   │
│   │   │   Validation            │   │   │
│   │   │   Migration             │   │   │
│   │   │                         │   │   │
│   │   └─────────────────────────┘   │   │
│   │              PKM                │   │
│   │   Queries, organization,        │   │
│   │   knowledge discovery           │   │
│   │                                 │   │
│   └─────────────────────────────────┘   │
│                  AI                     │
│   Optional automation, ingest,          │
│   processing helpers                    │
│                                         │
└─────────────────────────────────────────┘
```

**Priority order:**
1. **Schema** (core) — If this doesn't work, nothing works
2. **PKM** (middle) — Makes the schema useful for knowledge work
3. **AI** (outer) — Nice-to-have automation, never required

---

## Primary User

**Bowerbird is built for one person first: the author.**

- Power user, developer, creative
- Writes in Markdown, lives in the terminal
- Uses Neovim (or similar) as primary editor
- Wants to publish writing to the web
- Tired of migrating between PKM tools
- Needs strict organization without manual discipline

If Bowerbird works for this user, it will work for others. But it must work for this user first.

**Secondary audiences (stretch goals):**
- Neovim enthusiasts who want Obsidian-like PKM
- Developers who want schema-enforced Markdown as CMS
- Obsidian users who want CLI automation

---

## Core Philosophy

### 1. Schema is King

The schema is the source of truth. Notes must conform.

- **Hard enforcement on CLI** — `bwrb new` refuses to create invalid notes
- **Soft enforcement on external edits** — Files can drift, but `bwrb audit` catches it
- **TypeScript analogy** — Like `tsc`, you can use Bowerbird to fail builds on schema violations

> "You won't be able to create notes that go off the schema."

### 2. Composable, Not Monolithic

Bowerbird does one thing well: schema enforcement. It uses the existing ecosystem for everything else.

- **Git** for version control (Bowerbird doesn't manage commits)
- **yq/yaql** for raw YAML queries (Bowerbird provides schema-aware queries)
- **ripgrep** for content search (Bowerbird wraps it with type awareness)
- **Neovim** for editing (Bowerbird provides a plugin, not an editor)
- **GitHub Actions** for automation (Bowerbird is scriptable, not a scheduler)

### 3. Portable and Offline

Bowerbird works anywhere, on anything.

- No internet required for core functionality
- Works on any folder of Markdown files (Git-backed or not)
- No account, no cloud, no lock-in
- Install and point at a folder—that's it

### 4. Incrementally Adoptable

You don't need a complete schema upfront. Start minimal, grow as needed.

- Minimal viable schema: a single `meta` type
- Audit existing files to discover what you have
- Add types as patterns emerge
- Bulk migrate when ready

> "Like TypeScript, you can adopt it incrementally."

### 5. Consistency Above All

The CLI should be predictable and learnable.

- Small command surface (target: <15 top-level commands)
- Consistent flags across commands
- JSON mode for every command (AI/scripting friendly)
- No hidden modes or surprising behavior
- Selection prompts use consistent input rules: number keys (1-9, 0) select and submit, arrow keys move selection, Enter submits the highlighted option

---

## What Bowerbird Is

- A schema enforcement layer for Markdown/YAML
- A CLI-first tool with JSON mode for automation
- A query engine for typed notes
- A validator and auditor for note hygiene
- A migration tool for schema evolution
- A Neovim plugin for in-editor PKM (secondary)

## What Bowerbird Is NOT

- **Not a note-taking app** — Use Neovim, Obsidian, whatever you want
- **Not a database** — Markdown files are the source of truth
- **Not a sync service** — Use Git, iCloud, Syncthing
- **Not version control** — Use Git
- **Not a web app** — CLI only
- **Not a TUI** — Minimal terminal UI, just prompts
- **Not a CMS** — But it makes Markdown-as-CMS safer

---

## Success Criteria

Bowerbird succeeds when:

1. **You stop thinking about it** — The schema holds, notes are valid, queries work
2. **You stop switching PKMs** — This is the last migration
3. **Daily notes get processed effortlessly** — Write freely, organize later
4. **Nothing feels lost** — Every note is discoverable, every idea tracked
5. **You write more than you tweak** — The tool serves the work, not vice versa

Bowerbird fails if:

1. **Schema isn't enforced** — The core promise is broken
2. **Schema is hard to migrate** — Types should evolve easily
3. **Audit drift lasts** — Mismatches should be caught and fixed quickly
4. **Codebase becomes unwieldy** — Simple internals, maintainable code
5. **CLI is inconsistent** — Commands should be intuitive and predictable
6. **It over-scopes** — Don't reinvent Git, yq, or ripgrep

---

## Inheritance Model

Bowerbird uses strict type inheritance (design in progress).

**Principles:**
- All types inherit from `meta` (global fields)
- Inheritance is explicit and on by default
- Child types inherit all parent fields
- No hybrid/optional inheritance (learned from TANA's confusion)
- Folder structure may mirror type hierarchy

**Example hierarchy:**
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
├── entity
│   ├── person
│   ├── place
│   └── software
└── draft
    ├── chapter
    └── scene
```

> "If we commit to inheritance, we go all in. Consistency above all."

---

## CLI Design

### Command Surface

Target: <15 top-level commands that cover all use cases.

**Current commands:**
- `bwrb new` — Create notes with schema-driven prompts
- `bwrb edit` — Modify existing note frontmatter
- `bwrb list` — Query notes by type and fields
- `bwrb search` — Find notes by name or content
- `bwrb open` — Open notes in editor/Obsidian
- `bwrb delete` — Remove notes with backlink warnings
- `bwrb audit` — Validate notes against schema
- `bwrb bulk` — Batch frontmatter operations
- `bwrb schema` — Inspect and manage schema
- `bwrb template` — Manage note templates

**Schema and Template use unified verbs:**

The same verbs that work on notes also work on schema and templates, reducing learning burden:

```bash
# Schema management
bwrb schema new [type|field|enum]    # Create (prompts if noun omitted)
bwrb schema edit [type|field|enum]   # Edit with picker
bwrb schema delete [type|field|enum] # Delete (dry-run default)
bwrb schema list [types|fields|enums] # List/show

# Template management (uses two separate args like schema commands)
bwrb template new [type]           # Create template (prompts for type if omitted)
bwrb template edit [type] [name]   # Edit with picker
bwrb template delete [type] [name] # Delete with picker
bwrb template list [type] [name]   # List all, or show details if both provided
```

**Decisions made:**
- `open` is an alias for `search --open`
- `edit` is an alias for `search --edit`
- `list` remains separate (structured query output vs search/action)
- AI commands deferred to post-V1.0

### Design Principles

1. **Consistent flags** — Same flag means same thing everywhere
2. **Unified verbs** — `new`, `edit`, `delete`, `list`, `search` work everywhere
3. **JSON mode everywhere** — `--output json` on all commands (see `docs/product/cli-output-contract.md`)
4. **Dry-run default for destructive ops** — `--execute` to apply (exception: `audit --fix` writes by default; use `--dry-run` to preview)
5. **Discoverable prompts** — Missing required info prompts, doesn't error

### Documentation Canon

The docs-site (`https://bwrb.dev`) is the canonical source for user-facing CLI documentation.

The `docs/product/` folder is for product rationale, decisions, and internal design notes that may link to canonical docs-site pages.

**Documentation note:** The docs-site (`docs-site/`) is the canonical source for user-facing CLI documentation. `docs/product/` is for product rationale and internal notes; when it describes CLI behavior, it should link to the docs-site page.

### Help Output Ordering

Commands in `bwrb --help` are ordered to reflect the product's priority model and guide users through a logical workflow:

1. **CRUD operations** — `new`, `edit`, `delete` (core note actions)
2. **Query operations** — `list`, `open`, `search` (discovery and navigation)
3. **Schema and management** — `schema`, `audit`, `bulk`, `template` (schema enforcement and maintenance)
4. **Saved queries** — `dashboard` (saved configurations, follows template conceptually)
5. **Meta/utility** — `init`, `config`, `completion`, `help` (one-time setup and operational commands)

This ordering presents commands as a guided path: create notes → find notes → maintain schema → automate → configure. Utility commands appear last to keep the core workflow prominent.

---

## Neovim Plugin

`bwrb.nvim` brings full CLI functionality to Neovim.

**Philosophy:**
- Feature parity with CLI (for human-usable operations)
- Lean on existing plugins (Telescope, nvim-cmp, Treesitter)
- Minimal custom UI
- CLI is source of truth (plugin wraps `--json` mode)

**Future: LSP**
- Real-time schema validation in editor
- Wikilink completion
- Frontmatter field suggestions
- Diagnostic integration for type errors

---

## Roadmap Priorities

### V1.0 (Core)

1. **Schema enforcement** — Hard on CLI, soft audit on drift
2. **Inheritance model** — Full, consistent type inheritance
3. **Core commands** — new, edit, list, search, audit, bulk, schema, template
4. **JSON mode** — Every command scriptable
5. **Migration tooling** — Rename fields, change enums, refactor types
6. **Neovim plugin (basic)** — Search, create, edit via CLI wrapper

### Post-V1.0

- LSP for real-time validation
- AI ingest command
- Schema discovery from existing files
- Obsidian plugin
- Cost tracking for AI operations

---

## Naming

- **CLI command:** `bwrb`
- **Product name:** Bowerbird
- **Config directory:** `.bwrb/`
- **Neovim plugin:** `bwrb.nvim`
- **Schema file:** `.bwrb/schema.json`

---

## The Meta-Goal

Bowerbird exists so you can stop thinking about PKM tools and start thinking about what you're writing.

The schema holds. The notes are valid. The queries work. You write.

That's it.

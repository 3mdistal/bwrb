---
title: Introduction
description: What is Bowerbird and why it exists
---

Bowerbird (`bwrb`) is a CLI tool that enforces strict schemas on Markdown/YAML files. It brings TypeScript-style type safety to personal knowledge management.

## The Core Promise

**Your notes can't violate the schema.**

When you create a note with `bwrb new`, it's guaranteed to have valid frontmatter. When you query notes with `bwrb list`, the data is always structured. When your schema evolves, `bwrb audit` catches drift.

Think of it like TypeScript for your notes: the schema is checked at creation time, and any violations are caught before they become problems.

## Who is Bowerbird For?

Bowerbird is built for power users who:

- Write in Markdown and live in the terminal
- Use Neovim, Obsidian, or similar editors
- Want strict organization without manual discipline
- Are tired of migrating between PKM tools
- Want to automate note workflows with scripts or AI

If you've ever wished your PKM had a type system, Bowerbird is for you.

## The Three Circles

Bowerbird's functionality exists in concentric layers:

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

1. **Schema** (core) — Type enforcement, validation, migration
2. **PKM** (middle) — Queries, organization, knowledge discovery
3. **AI** (outer) — Optional automation, never required

If the schema layer doesn't work, nothing works. Everything else builds on that foundation.

## Key Features

### Schema Enforcement

Define types with required fields, select options, and relationships. Bowerbird ensures every note conforms:

```bash
bwrb new task       # Prompts for required fields
bwrb audit          # Finds notes that don't match schema
bwrb audit --path "Ideas/**" --fix    # Guided repair (requires targeting)
```

### Structured Queries

Filter notes by type and frontmatter values:

```bash
bwrb list task --where "status = 'active'"
bwrb list idea --fields=status,priority
```

### JSON Mode for Automation

Every command supports `--output json` for scripting and AI integration:

```bash
bwrb list task --output json | jq '.[] | select(.status == "active")'
bwrb new task --json '{"name": "Fix bug", "status": "active"}'
```

### Templates

Reusable note structures with defaults and body content:

```bash
bwrb new task --template bug-report
bwrb template list
```

## What Bowerbird Is NOT

- **Not a note-taking app** — Use Neovim, Obsidian, whatever you want
- **Not a database** — Markdown files are the source of truth
- **Not a sync service** — Use Git, iCloud, Syncthing
- **Not a web app** — CLI only

Bowerbird does one thing well: schema enforcement for Markdown. It uses the existing ecosystem for everything else.

## Next Steps

- [Installation](/getting-started/installation/) — Get bwrb running
- [Quick Start](/getting-started/quick-start/) — Create your first schema-validated note

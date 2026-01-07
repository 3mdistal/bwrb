---
title: Introduction
description: What is Bowerbird and why it exists
---

Bowerbird (`bwrb`) is a CLI tool that enforces strict schemas on Markdown/YAML files. It brings TypeScript-style type safety to personal knowledge management.

## The Core Promise

**Your notes can't violate the schema.**

When you create a note with `bwrb new`, it's guaranteed to have valid frontmatter. When you query notes with `bwrb list`, the data is always structured. When your schema evolves, `bwrb audit` catches drift.

## Who is Bowerbird For?

Bowerbird is built for power users who:

- Write in Markdown and live in the terminal
- Use Neovim, Obsidian, or similar editors
- Want strict organization without manual discipline
- Are tired of migrating between PKM tools

## The Three Circles

Bowerbird's functionality exists in concentric layers:

1. **Schema** (core) — Type enforcement, validation, migration
2. **PKM** (middle) — Queries, organization, knowledge discovery
3. **AI** (outer) — Optional automation, never required

If the schema layer doesn't work, nothing works. Everything else builds on that foundation.

## What Bowerbird Is NOT

- **Not a note-taking app** — Use Neovim, Obsidian, whatever you want
- **Not a database** — Markdown files are the source of truth
- **Not a sync service** — Use Git, iCloud, Syncthing
- **Not a web app** — CLI only

## Next Steps

- [Installation](/getting-started/installation/) — Get bwrb running
- [Quick Start](/getting-started/quick-start/) — Create your first schema-validated note

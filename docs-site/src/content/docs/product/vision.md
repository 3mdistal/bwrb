---
title: Product Vision
description: Bowerbird's philosophy and direction
---

> Schema enforcement for Markdown. Type-safe personal knowledge management.

## What is Bowerbird?

Bowerbird is a CLI tool that enforces strict schemas on Markdown/YAML files. It brings TypeScript-style type safety to personal knowledge management.

**One-liner:** Bowerbird is the type system for your notes.

## The Three Circles

Bowerbird's functionality exists in concentric layers:

1. **Schema** (core) — Type enforcement, validation, migration
2. **PKM** (middle) — Queries, organization, knowledge discovery
3. **AI safety net** (outer) — Deterministic guarantees *under* the AI agent, never an LLM caller

If the schema layer doesn't work, nothing works.

## Core Philosophy

### Schema is King

The schema is the source of truth. Notes must conform.

### Composable, Not Monolithic

Bowerbird does one thing well. Use Git for version control, ripgrep for search, AI agents for authoring.

### Portable and Offline

No internet required. Works on any folder of Markdown files. No account, no cloud, no lock-in.

### Incrementally Adoptable

Start minimal. Add types as patterns emerge. Migrate when ready.

### Consistency Above All

Small command surface. Consistent flags. JSON mode everywhere.

## What Bowerbird Is NOT

- Not a note-taking app
- Not a database
- Not a sync service
- Not a web app
- Not an LLM caller — the AI agent drives bwrb, not the other way around

## Success Criteria

Bowerbird succeeds when you stop thinking about it—the schema holds, notes are valid, queries work, and you write.

---

*For the full vision document, see [docs/product/vision.md](https://github.com/3mdistal/bwrb/blob/main/docs/product/vision.md) in the repository.*

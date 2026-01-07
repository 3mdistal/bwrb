---
title: Migrations
description: Evolving your schema over time
---

Schemas evolve. Bowerbird provides tools to migrate your notes when the schema changes.

## Why Migrations?

When you:
- Rename a field
- Change enum values
- Add required fields
- Restructure types

Your existing notes need to update too.

## Migration Workflow

1. **Modify schema** — Update `.bwrb/schema.json`
2. **Run audit** — See what's broken: `bwrb audit`
3. **Plan migration** — Preview changes: `bwrb schema migrate --dry-run`
4. **Execute** — Apply changes: `bwrb schema migrate --execute`

## Migration Types

- **Field rename** — `old_name` → `new_name`
- **Value mapping** — `"in-progress"` → `"active"`
- **Default injection** — Add missing required fields with defaults

## Safety

Migrations are safe by default:

- **Dry-run first** — See changes before applying
- **Backup** — Original files preserved
- **Atomic** — All-or-nothing application

## Next Steps

- [Schema commands](/reference/commands/schema/) — Managing your schema
- [Bulk operations](/reference/commands/bulk/) — Batch changes

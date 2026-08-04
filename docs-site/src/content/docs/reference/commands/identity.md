---
title: bwrb identity
description: Safely migrate stable note identity storage
---

`identity migrate` switches a vault between the legacy shared ID registry and
distributed note-owned identity. It is dry-run by default and validates the
whole discoverable note set before any write.

## Synopsis

```bash
bwrb identity migrate --to <frontmatter-v1|registry-v1> [--dry-run | --execute] [--output text|json]
```

## Governing model

In `frontmatter-v1`, the reserved UUID `id` in each note's frontmatter is
authoritative. It survives a rename or move because it travels with the note.
There is no authoritative global index: discovery reads note frontmatter, and
any future index must be disposable and rebuildable.

In legacy `registry-v1`, `.bwrb/ids.jsonl` remains part of completed creation
and deletion writes. A schema with no `config.identity_store` uses this legacy
mode, preserving existing vault behavior until migration is explicit. New
vaults created by `bwrb init` explicitly use `frontmatter-v1`.

## Guarded migration

```bash
# Preview; writes nothing
bwrb identity migrate --to frontmatter-v1 --output json

# Apply after reviewing blockers and planned changes
bwrb identity migrate --to frontmatter-v1 --execute --output json

# Rebuild the legacy registry and switch back
bwrb identity migrate --to registry-v1 --execute --output json
```

Both directions fail closed when a discovered note is unreadable, lacks `id`,
has a non-UUID `id`, or shares an ID with another note. Repair is deliberately
manual: for a copied note, decide whether it is the same logical note or a new
one before changing identity. Bowerbird will not crown a winner merely because
one path sorts first.

Forward migration changes only `.bwrb/schema.json`; it leaves an existing or
dirty `.bwrb/ids.jsonl` byte-for-byte untouched. Reverse migration first
atomically rebuilds `.bwrb/ids.jsonl` from current note frontmatter, preserving
known `createdAt` values where possible, then switches the schema mode. If the
schema mode changes concurrently, migration stops and asks for a retry.

## Git workflow

With `frontmatter-v1`, unrelated note creates modify unrelated Markdown files,
so separate branches or autonomous transactions do not contend on a shared
registry. Normal Git rename detection is sufficient: no registry path needs to
be updated. A copied note preserves its source ID and is therefore reported by
`bwrb audit --only duplicate-note-id`; resolve that conflict before merging.

Use audit after external-editor or merge activity:

```bash
bwrb audit --only missing-note-id --output json
bwrb audit --only invalid-note-id --output json
bwrb audit --only duplicate-note-id --output json
```

## JSON output

JSON reports `from`, `to`, note counts, exact blockers, and planned or applied
changes. A blocked execute exits non-zero and writes neither schema nor
registry. Dry-run may return blockers with a successful command so automation
can inspect the complete plan before deciding whether repair is required.

## See also

- [bwrb audit](/reference/commands/audit/)
- [bwrb init](/reference/commands/init/)
- [Schema configuration](/reference/schema/#config)

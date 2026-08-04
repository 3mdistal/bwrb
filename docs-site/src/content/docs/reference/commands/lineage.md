---
title: bwrb lineage
description: Safely adopt existing notes into document lineage
---

`lineage adopt` records one known immediate-source edge between two existing
Markdown notes. It is the only supported in-place way to add `forked-from`
provenance; ordinary creation, editing, templates, schema defaults, and audit
fixes remain unable to set or change that reserved field.

## Synopsis

```bash
bwrb lineage adopt <child> --from <parent> [--dry-run | --execute] [--output text|json]
```

## Options

| Option | Description |
| --- | --- |
| `--from <parent>` | Required exact immediate-source target |
| `--dry-run` | Preview only (also the default when neither mode flag is present) |
| `-x, --execute` | Revalidate under mutation locks and apply one edge |
| `--output <text\|json>` | Output format (default: `text`) |

There is deliberately no bulk or force mode. Adopt one edge at a time, inspect
the preview, then execute it explicitly.

## Target resolution

Both targets use exact Bowerbird identity surfaces: a vault-relative or
absolute managed path (with or without `.md`), basename, frontmatter `name`, a
schema-declared alias, or a case-insensitive UUID. Fuzzy substitution is never
used. Ambiguous targets are rejected with their candidate paths.

The child and parent must resolve to the same valid note type, but they do not
need to live in the same directory.

## Guardrails

Before previewing or writing, adoption refuses:

- a note adopted under itself;
- an existing `forked-from` key on the child (including malformed provenance);
- a missing or invalid resolved type on either note, or a type mismatch;
- a malformed existing ID on either note or a duplicate stable ID in the vault;
- malformed, dangling, duplicate, or cyclic existing lineage;
- a proposed edge that would create a cycle.

Valid existing IDs are preserved. If either target is an older note without an
ID, execute mode assigns a fresh UUID. Legacy `registry-v1` vaults also record
that UUID in `.bwrb/ids.jsonl`; `frontmatter-v1` vaults do not. Parent and child
paths are locked together, and the notes and graph are re-read under those
locks. Concurrent fork, non-force delete, and adoption operations therefore
serialize only on paths they share in `frontmatter-v1`; legacy vaults retain
their vault-wide ID-assignment lock. Ordinary `bwrb edit`
now joins those path locks for its short commit phase and replays a stale JSON
patch from fresh bytes, preventing an edit from erasing a newly assigned ID or
provenance edge.

Only the missing `id` fields and the child's new `forked-from` field may change.
The writer inserts plain scalars without reserializing YAML, and verifies that
the parsed bodies and all ordinary frontmatter remain unchanged. Filenames,
aliases, provider metadata, bodies, and other frontmatter are not rewritten.
If the two-note write or any required legacy registry update fails, changed note bytes are rolled
back before the command reports failure. Rollback restores a note only when it
still contains adoption's own write; bytes from a newer writer are left intact.
A pre-write byte conflict is retryable and uses numeric JSON `code: 2` with
`data.reason: "note-modified-concurrently"`.

## Examples

```bash
# Preview is the default
bwrb lineage adopt "Child note" --from "Parent note" --output json

# An explicit preview can make an automation's intent clearer
bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json

# Apply after reviewing the plan
bwrb lineage adopt "Child note" --from "Parent note" --execute --output json

# Inspect the resulting family
bwrb list --lineage "Child note" --output tree
```

## JSON output

Success uses one stable envelope. `changes[].status` is `planned` in dry-run
mode and `applied` in execute mode:

```json
{
  "success": true,
  "mode": "dry-run",
  "child": { "path": "Drafts/Child note.md", "id": "...", "id_generated": true },
  "parent": { "path": "Briefs/Parent note.md", "id": "...", "id_generated": false },
  "changes": [
    { "path": "Drafts/Child note.md", "field": "id", "value": "...", "status": "planned" },
    { "path": "Drafts/Child note.md", "field": "forked-from", "value": "...", "status": "planned" }
  ],
  "warnings": [
    "Generated IDs in a dry run are provisional; execute revalidates and assigns fresh UUIDs."
  ],
  "body_invariance": {
    "child": { "before_sha256": "...", "after_sha256": "...", "unchanged": true },
    "parent": { "before_sha256": "...", "after_sha256": "...", "unchanged": true }
  }
}
```

A dry-run-generated ID is evidence for the planned field, not a reservation;
execute mode assigns a fresh UUID after locked revalidation. Existing IDs are
stable across preview and execution.

## See also

- [bwrb new](/reference/commands/new/#document-forks) — create a new child from an existing document
- [bwrb list](/reference/commands/list/#fork-lineage) — inspect a complete lineage family
- [bwrb audit](/reference/commands/audit/) — validate lineage integrity
- [bwrb delete](/reference/commands/delete/#fork-lineage-safety) — lineage-aware deletion guards

# System Frontmatter Fields

This document defines bwrb-managed frontmatter fields that are not required to be declared in schema.

## System-managed fields

These fields are recognized by bwrb and are always allowed in frontmatter:

- `id` (written by ordinary creation and forks)
- `name` (written by ordinary interactive and JSON creation; preserves the
  note identity even when its filename is normalized or pattern-derived)
- `forked-from` (immediate source note UUID, written by `bwrb new --fork` or the
  guarded `bwrb lineage adopt` operation)

Audit/validation behavior:

- These fields never produce `unknown-field` issues in `bwrb audit` or validation.
- `forked-from` cannot be declared as a type or trait schema field. Schema load,
  validation, and field creation reject the reserved name.
- Existing `id` schema declarations retain their current behavior.
- In `frontmatter-v1`, each parseable discovered note must have one valid,
  vault-unique UUID `id`. The note is authoritative; any global index is a
  rebuildable cache, never identity state.

## Reserved (immutable) fields

These fields are system-managed and must not be mutated by automated fixes:

- `id`
- `forked-from`

Reserved fields cannot be supplied through ordinary JSON creation, JSON or
interactive edit, or template defaults/prompt fields. Audit fixes also leave
them untouched. Schema defaults and static values cannot author
`forked-from`; `bwrb new --fork` injects it after ordinary defaults are resolved.
The only in-place exception is `bwrb lineage adopt`, which revalidates two exact
existing notes under lineage locks, refuses reparenting, cycles, and unsafe
graph state, and can add only missing `id` fields plus the child's
`forked-from` value.

## Identity storage modes

- `registry-v1` preserves the legacy `.bwrb/ids.jsonl` issuance registry and
  its registry/assignment locks. Omitted `config.identity_store` resolves to
  this mode for compatibility with existing vaults.
- `frontmatter-v1` derives identity from live note frontmatter. Creation,
  deletion, fork, template scaffolding, and lineage adoption never mutate
  `.bwrb/ids.jsonl` and take no vault-wide identity-assignment lock. Path-level
  mutation locks remain authoritative for writes to the same note.

`bwrb identity migrate` is the only supported mode switch. Forward migration
requires every discovered parseable note to have a valid unique UUID and then
changes only `schema.json`. Reverse migration atomically rebuilds the legacy
registry from live notes before changing the schema mode. Both directions fail
closed on unreadable, missing, invalid, or duplicate identity.

## Policy

- Keep the system-managed allowlist small and explicit.
- Adding new system-managed fields requires product approval and documentation updates.

Canonical user-facing docs live in `docs-site/` (audit/new reference pages).

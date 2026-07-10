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

## Policy

- Keep the system-managed allowlist small and explicit.
- Adding new system-managed fields requires product approval and documentation updates.

Canonical user-facing docs live in `docs-site/` (audit/new reference pages).

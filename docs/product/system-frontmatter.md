# System Frontmatter Fields

This document defines bwrb-managed frontmatter fields that are not required to be declared in schema.

## System-managed fields

These fields are written by bwrb and are always allowed in frontmatter:

- `id`
- `name`
- `forked-from` (immediate source note UUID, written by `bwrb new --fork`)

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

## Policy

- Keep the system-managed allowlist small and explicit.
- Adding new system-managed fields requires product approval and documentation updates.

Canonical user-facing docs live in `docs-site/` (audit/new reference pages).

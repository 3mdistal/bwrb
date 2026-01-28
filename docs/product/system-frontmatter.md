# System Frontmatter Fields

This document defines bwrb-managed frontmatter fields that are not required to be declared in schema.

## System-managed fields

These fields are written by bwrb and are always allowed in frontmatter:

- `id`
- `name`

Audit/validation behavior:

- These fields never produce `unknown-field` issues in `bwrb audit` or validation.
- If a schema defines them explicitly, schema validation still applies to the declared field.

## Reserved (immutable) fields

These fields are system-managed and must not be mutated by automated fixes:

- `id`

## Policy

- Keep the system-managed allowlist small and explicit.
- Adding new system-managed fields requires product approval and documentation updates.

Canonical user-facing docs live in `docs-site/` (audit/new reference pages).

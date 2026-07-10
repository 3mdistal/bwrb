# Bowerbird Roadmap

> Shipped foundation and remaining pre-1.0 priorities.

User-facing status is summarized on the docs-site
[Roadmap](../../docs-site/src/content/docs/product/roadmap.md). Feature behavior
is canonical in the relevant docs-site concepts and command references.

## Shipped foundation

The old v1/v2/v3 phase labels no longer describe product state. Their principal
features have shipped:

- **Schema and enforcement:** version 2 flat schemas, single inheritance,
  explicit-key inherited field overrides, traits, ownership, recursive types,
  schema CRUD, effective-schema migrations, validation, and audit repair
- **PKM/query surface:** dashboards and `list --save-as`, aliases, hierarchical
  scope and `under()`, partial dates, relative dates, custom calendars, and
  canonical `list` name/fuzzy/body/content/open modes
- **Deterministic safety net:** `unlinked-mention`,
  `frequent-unlinked-term`, daily-note coverage queries, `schema discover`, and
  event-driven recurrence with an audit backstop
- **Document history:** native forks, system `id` and `forked-from`, field
  `reset_on_fork`, lineage inspection, lineage integrity audits, and fork-safe
  deletion
- **Delivery:** live docs-site, generated JSON Schema, JSON-capable automation
  on the commands that advertise it, shell completion, and release packaging

The compatibility `search` and `open` commands remain callable for existing
scripts, but `list` is the canonical read surface and `edit` is the canonical
mutation surface.

## Current focus

1. **Pre-1.0 contract hardening** — Keep help, docs, agent guidance, generated
   schema, completion, and tests synchronized with shipped behavior.
2. **Safe automation** — Preserve command-specific JSON shapes, clean exits,
   non-interactive guarantees, and conservative destructive-operation gates.
3. **Schema evolution reliability** — Continue strengthening migration/audit
   behavior as field and calendar expressiveness grows.
4. **Known parity gaps** — Resolve schema/config command coverage
   ([#809](https://github.com/3mdistal/bwrb/issues/809)).

## Future boundary

Bowerbird stays the deterministic layer under an AI agent. It does not call
models, host notes, sync vaults, or become a writing application. Future work is
tracked in GitHub issues and `plans/features/`; a proposal remains a proposal
until merged. Evergreen docs must describe shipped behavior, while historical
release notes preserve when it arrived.

## References

- [Product Vision](vision.md)
- [Canonical documentation policy](canonical-docs-policy.md)
- [Type System](type-system.md)
- [Inheritance technical note](../technical/inheritance.md)
- [Issue tracker](https://github.com/3mdistal/bwrb/issues)

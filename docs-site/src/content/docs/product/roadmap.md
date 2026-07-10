---
title: Roadmap
description: Bowerbird shipped foundation and current development priorities
---

## Shipped foundation

Bowerbird remains pre-1.0, but the major product layers described in the older
roadmap are implemented:

- Version 2 flat schemas with inheritance, traits, ownership, recursive types,
  schema management, effective-schema migrations, and audit enforcement
- Dashboards, `list --save-as`, aliases, hierarchical scope with `under()`,
  partial and relative dates, and custom calendars
- Canonical `list` discovery with name, fuzzy, body-match, content, open, and
  lineage modes; hidden `search` and `open` remain compatibility commands
- Deterministic agent safety nets: unlinked mentions, frequent unlinked terms,
  daily-note coverage queries, `schema discover`, and event-driven recurrence
- Native document forks, immutable lineage metadata, lineage inspection, and
  fork-safe deletion
- A live documentation site and generated public schema

## Current pre-1.0 focus

The remaining work is hardening rather than waiting for those foundations to
exist:

- Keep command help, completion, schemas, agent guidance, and docs generated or
  checked from the same contracts
- Stabilize machine-readable command-specific output shapes and exit behavior
- Keep migrations and audit fixes conservative as schemas grow more expressive
- Improve completion parity (including the current `init` omission, tracked in
  [#810](https://github.com/3mdistal/bwrb/issues/810))

## Genuinely future

Future work should deepen reliability and ergonomics without turning bwrb into
an LLM client, sync service, database, or writing application. Planned work is
tracked in GitHub issues and feature plans; an item belongs in evergreen docs
only after it ships.

---

*For rationale and issue links, see
[docs/product/roadmap.md](https://github.com/3mdistal/bwrb/blob/main/docs/product/roadmap.md).*

---
title: Roadmap
description: Bowerbird development priorities
---

## V1.0 (Current Focus)

### Core Features

- **Schema enforcement** — Hard on CLI, soft audit on drift
- **Inheritance model** — Full, consistent type inheritance
- **Core commands** — new, edit, list, search, audit, bulk, schema, template
- **JSON mode** — Every command scriptable
- **Migration tooling** — Rename fields, change select options, refactor types

### Exit Criteria

- [ ] Schema enforcement complete
- [ ] Type inheritance implemented
- [ ] All core commands stable
- [ ] Migration system working
- [ ] Documentation website live (you're reading it!)

## Post-V1.0

### Near Term — Schema Expressiveness

A richer schema so the AI agent uses it correctly:

- Aliases — first-class alias field role
- Traits — composition alongside inheritance
- Hierarchical scope — contexts as real notes + `under` join

### Future — AI Safety Net

bwrb is the deterministic safety net *under* the AI agent, never an LLM caller:

- `search --fuzzy` — scored candidate lookup before writing
- `audit: unlinked-mention` — flag known entities mentioned but not linked
- Daily-note sweep — coverage bookkeeping
- `schema discover` — deterministic field-usage facts over a folder
- Task recurrence — event-driven spawn + offset templating

---

*For the detailed roadmap, see [docs/product/roadmap.md](https://github.com/3mdistal/bwrb/blob/main/docs/product/roadmap.md) in the repository.*

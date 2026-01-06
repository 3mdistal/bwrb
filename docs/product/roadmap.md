# Bowerbird Roadmap

> Versioned milestones for Bowerbird development

---

## Version Philosophy

**v1: Schema** — Rock-solid schema enforcement, inheritance model, type safety
**v2: PKM** — Plugins, ecosystem, dashboards, visibility into your knowledge
**v3: AI** — Built-in AI features, ingest, automation

---

## v1.0: Schema (Current Focus)

The core promise: your notes can't violate the schema.

### Execution Order

Work should proceed in this order due to dependencies:

#### Phase 1: The Big Rename + Refactor
| Priority | Issue | Title | Blocked By |
|----------|-------|-------|------------|
| P0 | `bwrb-cr7` | Rename ovault to bwrb | — |
| P0 | `bwrb-wbz` | Implement inheritance model | `bwrb-cr7` |

#### Phase 2: Core Inheritance Features
After inheritance model is in place:
| Priority | Issue | Title |
|----------|-------|-------|
| P1 | `bwrb-9g9` | Implement ownership and folder computation |
| P1 | `bwrb-0k0` | Update tests for new schema format |
| P1 | `bwrb-taz` | Implement context field validation |
| P1 | `bwrb-ita` | Implement recursive type support |
| P1 | `bwrb-oa8` | Update audit for new type resolution |

#### Phase 3: Schema Management CLI
| Priority | Issue | Title |
|----------|-------|-------|
| P1 | `bwrb-tsh` | Schema Management CLI |
| P2 | `bwrb-w2a` | `bwrb schema new type` command |
| P2 | `bwrb-tev` | `bwrb schema new field` command |
| P1 | — | Field primitives (text, number, boolean, relation) |

#### Phase 4: Polish
| Priority | Issue | Title |
|----------|-------|-------|
| P2 | `bwrb-3nd` | Schema migration system |
| P2 | `bwrb-fkd` | Finalize command surface |
| P2 | `bwrb-oay` | Template spawning with ownership |
| P2 | `bwrb-xy1` | Remove name_field, standardize on 'name' |

### v1.0 Exit Criteria

- [ ] Renamed to Bowerbird (CLI, config, docs, repo)
- [ ] Inheritance model fully implemented
- [ ] Ownership/colocation working
- [ ] Context field validation in audit
- [ ] Schema management CLI (schema new/edit/delete/list)
- [ ] Field primitives: text, number, boolean, date, select, relation, list
- [ ] All tests passing with new schema format
- [ ] Documentation updated

---

## v2.0: PKM (Future)

Make the schema useful for knowledge work.

### Planned Features

| Feature | Issue | Description |
|---------|-------|-------------|
| Neovim plugin | `bwrb-tic` | Full CLI parity in Neovim |
| LSP | `bwrb-0wp` | Real-time schema validation in editors |
| Dashboards | `bwrb-f9u` | Saved queries, visibility into notes |
| Link validation | `bwrb-6f0` | Broken link detection in audit |
| Command consolidation | `bwrb-fkd` | Merge list/search/open |

### v2.0 Exit Criteria

- [ ] Neovim plugin with core functionality
- [ ] LSP server for schema validation
- [ ] Dashboard system for saved queries
- [ ] Comprehensive link validation
- [ ] Polished, consistent CLI surface

---

## v3.0: AI (Future)

Optional AI-powered features for automation.

### Planned Features

| Feature | Issue | Description |
|---------|-------|-------------|
| AI Ingest | `bwrb-acd` | Extract tasks/ideas/entities from notes |
| Entity matching | `bwrb-h9o` | Link mentions to existing notes |
| Agentic workflows | — | Run AI workflows from vault |
| Cost tracking | — | Monitor AI spend |

### v3.0 Exit Criteria

- [ ] `bwrb ingest` command working
- [ ] Interactive approval flow for AI suggestions
- [ ] Entity matching and auto-linking
- [ ] Optional—works without AI keys

---

## Deferred (Post-v3)

| Feature | Issue | Notes |
|---------|-------|-------|
| Recurrence | `bwrb-yuq` | Recurring task creation |
| Schema discovery | `bwrb-onp` | Suggest schema from existing files |
| Obsidian plugin | — | If there's demand |

---

## Reference

- **Product Vision:** `docs/product/vision.md`
- **Type System (overview):** `docs/product/type-system.md`
- **Type System (technical):** `docs/technical/inheritance.md`
- **Issue Tracker:** `.beads/` (use `bd list`, `bd show`)

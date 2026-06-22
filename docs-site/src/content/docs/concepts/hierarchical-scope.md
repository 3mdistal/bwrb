---
title: Hierarchical Scope (Contexts as Notes)
description: Model life domains and projects as a parent tree of context notes, carry only the leaf context, and query at any altitude with under()
---

Notes usually belong to both a broad **life domain** (career, software-dev, personal) and a specific **context** within it (Builder, Vercel, PKM). The naive way to record both is two fields:

```yaml
# A task — the redundant way
scope: career          # life domain
context: "[[Builder]]" # specific project
```

This is double-entry maintenance. The domain is *derivable* from the context — Builder is a career project — so `scope` repeats information the context already implies. Move PKM from `software-dev` to `personal` and you have to fix the PKM note **and** bulk-update every note that hard-coded `scope: software-dev`.

Bowerbird's answer needs **no new field type**. It reuses three things you already have: entity notes with a `parent` relation, the `under` operator (see [Targeting Model](/reference/targeting/#underfield-node-vs-isdescendantofnode)), and relation fields.

## The pattern

Model contexts and domains as **real entity notes** in a `parent` hierarchy. A domain is just a root node; a project is a child; a sub-project is a grandchild.

```yaml
# Contexts/career.md          → a root domain
type: context

# Contexts/Builder.md         → a project under career
type: context
parent: "[[career]]"

# Contexts/Vercel.md          → a sub-project under Builder
type: context
parent: "[[Builder]]"
```

A note then carries **only the leaf context** — never a separate scope:

```yaml
# A task
type: task
status: active
context: "[[Vercel]]"   # domain (career) is derivable by walking up
```

### Schema

A `context` type is an ordinary entity with a **self-referential `parent` relation**. Tasks get a `context` relation pointing at it.

```json
{
  "types": {
    "entity": {
      "output_dir": "Entities",
      "fields": {
        "type": { "value": "entity" }
      },
      "field_order": ["type"]
    },
    "context": {
      "extends": "entity",
      "output_dir": "Contexts",
      "recursive": true,
      "fields": {
        "type": { "value": "context" },
        "parent": { "prompt": "relation", "source": "context", "format": "quoted-wikilink" },
        "aliases": { "prompt": "list", "alias": true, "list_format": "yaml-array", "default": [] }
      },
      "field_order": ["type", "parent", "aliases"]
    },
    "task": {
      "output_dir": "Tasks",
      "fields": {
        "type": { "value": "task" },
        "status": { "prompt": "select", "options": ["backlog", "active", "done"], "default": "backlog", "required": true },
        "context": { "prompt": "relation", "source": "context", "format": "quoted-wikilink" }
      },
      "field_order": ["type", "status", "context"]
    }
  }
}
```

## Querying at any altitude

The leaf is exact; the domain is a subtree walk. Use the `under` operator (see [Targeting Model](/reference/targeting/#underfield-node-vs-isdescendantofnode)), which dereferences the `context` relation and walks **the target's** ancestor chain.

```bash
# Exact leaf context only
bwrb list --type task --where "context == '[[Vercel]]'"

# Everything in the Builder project (Builder + Vercel + anything deeper)
bwrb list --type task --where "under(context, '[[Builder]]')"

# The ENTIRE career domain, at any altitude
bwrb list --type task --where "under(context, '[[career]]')"
```

`under` is **inclusive of the direct target**: `under(context, '[[career]]')` matches a note tagged `[[career]]` directly as well as any descendant. This is exactly what lets you collapse two fields into one — you can still ask "everything in the career domain" without ever storing the domain on the note.

:::note[`under` vs `isDescendantOf`]
`isDescendantOf('[[X]]')` walks the **current note's own** `parent` chain. `under(field, '[[X]]')` first **dereferences a relation field**, then walks **that target's** chain. The context lives in a *field*, not the note's structural parent, so `under` is the operator you want here. See [Targeting Model](/reference/targeting/#underfield-node-vs-isdescendantofnode).
:::

## Why one field beats two

Collapsing `scope` + `context` into a single context tree removes the redundancy and unlocks transitive queries:

- **No double entry.** A note records one fact (its leaf context). The domain is computed, never stored.
- **Reorganize in one place.** Re-parent a context note (`PKM.parent` from `[[software-dev]]` to `[[personal]]`) and every dependent query updates automatically — no bulk rewrite of notes.
- **Transitive queries.** "Everything in the career domain" is a single `under(context, '[[career]]')`, not an OR over every leaf.
- **Contexts are first-class notes.** Because they're real notes, they get `unlinked-mention` audit coverage, backlinks, and graph presence for free, and aliases (see [Schema](/concepts/schema/)) help with all of those. Rich contexts (Builder, with its own content) and label-like contexts (PKM) cost the same.

:::caution[Use the canonical note name in `under()` targets and `context` relations]
Aliases help backlinks, unlinked-mention detection, and audit coverage on context notes, but they do **not** apply to `under()`. The `under` operator (and the `context` relation it dereferences) matches wikilink targets **literally** — it does not yet canonicalize aliases. So a task whose `context` points at an *alias* of a context note silently drops out of altitude queries.

Concretely, if `Builder` has an alias `BuilderProject`, then a task with `context: "[[BuilderProject]]"` will **not** be returned by `under(context, '[[Builder]]')` or `under(context, '[[career]]')` — the alias is never resolved back to `Builder`, so the tree walk never reaches it. Always reference context notes by their **canonical note name** in `under()` targets and in any leaf `context` relation.

This is a known limitation; a follow-up issue will track making `under()` alias-aware.
:::
- **Validation for free.** A task pointing at a non-existent context is flagged by the existing relation-source audit (see [Validation and Audit](/concepts/validation-and-audit/)), exactly like any other broken relation.

## Migration: collapse a redundant `scope` field

If your vault already has the redundant `scope` select alongside a `context` relation, migrate in three steps. Nothing is lost, because the domain is derivable from the context tree.

**1. Make sure your contexts form a tree.** Each context note's `parent` should point at its domain (or intermediate project):

```yaml
# Contexts/Builder.md
type: context
parent: "[[career]]"
```

**2. Confirm the domain is already derivable** before deleting anything. Pick a domain and verify the right notes come back through the tree alone:

```bash
bwrb list --type task --where "under(context, '[[career]]')"
```

**3. Drop the now-redundant field** with [`bulk`](/reference/commands/bulk/). Preview first (dry-run is the default), then execute:

```bash
# Preview — which notes still carry the redundant scope?
bwrb bulk --type task --where "!isEmpty(scope)" --delete scope

# Apply
bwrb bulk --type task --where "!isEmpty(scope)" --delete scope --execute
```

Finally, remove the `scope` field from your schema and run a schema migration (see [Migrations](/concepts/migrations/)) so the field is no longer declared:

```bash
bwrb schema diff
bwrb schema migrate --execute
```

After this, every note carries only its leaf `context`, and the life domain is a query away at any altitude.

## See Also

- [Targeting Model](/reference/targeting/) — the `under` operator and hierarchy functions
- [bwrb list](/reference/commands/list/) — `--where` queries and `--output tree`
- [bwrb bulk](/reference/commands/bulk/) — `--delete` for dropping fields
- [Migrations](/concepts/migrations/) — evolving the schema once `scope` is gone
- [Validation and Audit](/concepts/validation-and-audit/) — relation-source validation for context notes

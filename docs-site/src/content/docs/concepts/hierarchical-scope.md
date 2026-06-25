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
`isDescendantOf('[[X]]')` walks the **current note's own** literal `parent` chain. `under(field, '[[X]]')` first **dereferences a relation field**, then walks **that target's** chain. The context lives in a *field*, not the note's structural `parent`, so `under` is the operator you want here — `isDescendantOf` will **not** treat a relation field (like `context` or `milestone`) as a structural parent. See [Targeting Model](/reference/targeting/#how-the-three-operators-differ).
:::

## See the hierarchy as a tree

Querying tells you *which* notes are in a domain; rendering the tree tells you *how the domain is shaped*. Because contexts are real notes in a `parent` hierarchy, `bwrb list --output tree` draws that hierarchy directly:

```bash
bwrb list --type context --output tree
```

```text
└── career
    └── Builder
        └── Vercel
```

This is the fastest way to see — or onboard someone else to — the shape of your context tree. `--output tree` builds the parent hierarchy whenever the matched notes carry `parent` links, so it works for **any** entity type modelling a hierarchy this way, not only types marked `recursive`. (When the result set has no `parent` links, `--output tree` falls back to grouping notes by directory.)

Limit the depth with `-L`/`--depth`, and order siblings with `--sort`/`--desc`:

```bash
# Just the top two levels (domains and their immediate projects)
bwrb list --type context --output tree -L 2

# Order siblings by name, descending
bwrb list --type context --output tree --sort name --desc
```

You can also narrow the tree to a single subtree first, then render it:

```bash
bwrb list --type context --where "isDescendantOf('[[career]]')" --output tree
```

See [bwrb list](/reference/commands/list/) for the full `--output tree` reference.

## Why one field beats two

Collapsing `scope` + `context` into a single context tree removes the redundancy and unlocks transitive queries:

- **No double entry.** A note records one fact (its leaf context). The domain is computed, never stored.
- **Reorganize in one place.** Re-parent a context note (`PKM.parent` from `[[software-dev]]` to `[[personal]]`) and every dependent query updates automatically — no bulk rewrite of notes.
- **Transitive queries.** "Everything in the career domain" is a single `under(context, '[[career]]')`, not an OR over every leaf.
- **Contexts are first-class notes.** Because they're real notes, they get `unlinked-mention` audit coverage, backlinks, and graph presence for free, and aliases (see [Schema](/concepts/schema/)) help with all of those. Rich contexts (Builder, with its own content) and label-like contexts (PKM) cost the same.

:::note[`under()` is alias-aware]
Aliases (see [Schema](/concepts/schema/)) work transparently with `under()`. The operator canonicalizes aliases on **both sides** before walking the tree — the same alias resolution that powers `bwrb open <alias>`.

Concretely, if `Builder` has an alias `BuilderProject`, then a task with `context: "[[BuilderProject]]"` **is** returned by `under(context, '[[Builder]]')` and `under(context, '[[career]]')` — the alias resolves back to `Builder`, so the tree walk reaches it. Passing the alias as the query node works too: `under(context, '[[BuilderProject]]')` resolves to `Builder` and walks its whole subtree. You can use either the canonical name or an alias in `under()` targets and in leaf `context` relations.

Ambiguous aliases (the same alias declared on more than one note) are the one exception: they are **not** auto-resolved, so they match nothing rather than silently picking a winner. Disambiguate by renaming the alias or referencing the canonical note name.

The structural operators `isChildOf` and `isDescendantOf` are alias-aware in the same way: if a context note writes its own `parent` as an alias of the real parent (`Vercel.parent = "[[BuilderProject]]"`), it is still matched by `isChildOf('[[Builder]]')` and `isDescendantOf('[[career]]')`, and an aliased query node resolves to the canonical note too. They resolve the `parent` chain over the **whole vault**, so a chain that climbs through a note of a different type (one filtered out by `--type`) is still followed to the true ancestor rather than stopping early.
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

---
title: Schema Reference
description: Complete reference for .bwrb/schema.json structure and properties
---

The schema file defines your vault's type system: what kinds of notes exist, what fields they have, and how they relate to each other.

For conceptual overview, see [Schema](/concepts/schema/) and [Types and Inheritance](/concepts/types-and-inheritance/).

## File Location

The schema lives at `.bwrb/schema.json` in your vault root:

```
my-vault/
├── .bwrb/
│   └── schema.json    # Your schema definition
├── Ideas/
├── Objectives/
└── ...
```

## Top-Level Structure

```json
{
  "$schema": "https://bwrb.dev/schema.json",
  "version": 2,
  "schemaVersion": "1.0.0",
  "traits": { ... },
  "types": { ... },
  "config": { ... },
  "audit": { ... }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `$schema` | string | No | JSON Schema URI for editor validation |
| `version` | integer | No | Schema format version (default: `2`) |
| `schemaVersion` | string | No | User-controlled version for migrations (semver) |
| `traits` | object | No | Reusable field bundles composed into types (see [Traits](#traits)) |
| `types` | object | **Yes** | Type definitions |
| `config` | object | No | Vault-wide settings |
| `audit` | object | No | Audit command configuration |

---

## Types

Types define categories of notes. Each type has a name (the object key) and a definition.

### Minimal Type

```json
{
  "types": {
    "idea": {
      "fields": {
        "status": { "prompt": "select", "options": ["raw", "developing", "mature"] }
      }
    }
  }
}
```

### Type Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `extends` | string | `"meta"` | Parent type name (single-inheritance) |
| `traits` | array | — | Trait names composed into this type (see [Traits](#traits)) |
| `description` | string | — | What this type is for and when to use it. Surfaced by `bwrb schema list` |
| `output_dir` | string | no | Vault-relative folder where this type's notes live (e.g., `"Objectives/Tasks"`). When omitted, creation uses the computed pluralized type hierarchy; see [Output directories](#output-directories) |
| `retention` | object | no | Type-local end-of-life policy evaluated by `bwrb audit`; it is not inherited by child types |
| `fields` | object | `{}` | Field definitions |
| `field_order` | array | — | Order of fields in frontmatter |
| `body_sections` | array | — | Body structure after frontmatter |
| `recursive` | boolean | `false` | Whether type can contain instances of itself |
| `calendar_default` | string | — | Default id from `config.calendars` for this type's `date` fields that do not declare `calendar` |
| `plural` | string | auto | Custom plural for folder naming (e.g., `"research"` instead of `"researchs"`) |

### Output directories

Each type's `output_dir` is the folder its notes live in. `bwrb new` creates notes
directly in `output_dir`, but discovery (`bwrb list`, including `list --fuzzy`)
treats `output_dir` as a **subtree**: notes filed in nested
subfolders are discovered and associated with that type too.

For a `people` type with `output_dir: "People"`, all of these are discovered as
`people` notes:

```
People/Ada Lovelace.md          # direct child
People/Historical/Ada Lovelace.md   # nested subdir
People/Historical/Mathematicians/Ada.md   # deeply nested
```

Boundaries are respected so notes are never misassigned:

- A nested folder that is itself another type's `output_dir` (e.g. `Objectives/Tasks`
  under `Objectives`) belongs to that more specific type, not the parent.
- Owned-note subfolders (see [Owned relations](#owned-relations)) keep their owned
  child type and ownership metadata.
- Hidden/system folders (`.bwrb`, anything starting with `.`) and paths excluded by
  `config.excluded_directories`, `.gitignore`, or `.bwrbignore` are never indexed.

A nested note whose declared `type` does not match the folder it sits in is still
discoverable, but `bwrb audit` reports it as `wrong-directory` — discovery and the
audit's directory check use the same subtree rule.

`schema validate` permits an omitted `output_dir` and reports its computed
hierarchy-based fallback as a warning. Ordinary `bwrb new` uses that same
resolved directory. Resolution prefers an explicit directory on the type, then
an explicit ancestor directory, and finally the pluralized type hierarchy.

### Inheritance

All types inherit from `meta` (implicitly created if not defined). Types form a single-inheritance tree:

```json
{
  "types": {
    "meta": {
      "fields": {
        "status": { "prompt": "select", "options": ["raw", "active", "done"] },
        "created": { "value": "$NOW" }
      }
    },
    "objective": {
      "extends": "meta",
      "fields": {
        "deadline": { "prompt": "date" }
      }
    },
    "task": {
      "extends": "objective",
      "fields": {
        "status": { "default": "inbox" },
        "assignee": { "prompt": "relation", "source": "person" }
      }
    }
  }
}
```

A `task` inherits:
- `status` and `created` from `meta`
- `deadline` from `objective`
- Adds `assignee`, overrides `status` default to `"inbox"`

**Inheritance rules:**
- Type names must be unique across the entire schema
- No cycles allowed (a type cannot extend its own descendant)
- A child re-declaration explicitly key-merges onto the inherited field. Every
  declared key wins, including `prompt`, `options`, `multiple`, `required`, and
  `source`; omitted keys keep their inherited values.

### Recursive Types

Types with `recursive: true` can have a `parent` field pointing to the same type:

```json
{
  "task": {
    "extends": "objective",
    "recursive": true,
    "fields": {
      "parent": {
        "prompt": "relation",
        "source": "task"
      }
    }
  }
}
```

This enables subtasks, nested chapters, etc. Cycles are prevented—a note cannot be its own ancestor.

---

## Traits

Traits are reusable field bundles a type can compose. Where `extends` models *is-a* inheritance (a `task` is an `objective`), traits model *also-has* composition (a `task` **also has** the `actionable` bundle). Cross-cutting field groups — status + due dates, scope, rating metadata — recur across unrelated type families, which is exactly what single inheritance models badly. Define the bundle once as a trait and mix it into any type.

Declare traits at the top level, then list them on a type with `traits`:

```json
{
  "traits": {
    "actionable": {
      "description": "Things that can be worked and completed.",
      "fields": {
        "status": { "prompt": "select", "options": ["inbox", "next", "done"] },
        "due": { "prompt": "date" }
      }
    }
  },
  "types": {
    "task": {
      "extends": "objective",
      "traits": ["actionable"]
    }
  }
}
```

A `task` now has every field from `objective` (and its ancestors) **plus** `status` and `due` from the `actionable` trait.

### Trait Properties

| Property | Type | Description |
|----------|------|-------------|
| `description` | string | What the trait bundles and when to use it. Surfaced by `bwrb schema list` |
| `fields` | object | Field definitions contributed by the trait |
| `recurrence` | object | Spawn-on-transition recurrence config (see [Recurrence](#recurrence)) |
| `transition_guards` | array | Direct relation-backed requirements checked when a field enters a value |
| `transition_effects` | array | Bounded patches applied to a direct related note when a field enters a value |

Traits are **flat**: a trait carries only `fields` (and an optional `description`, plus an optional `recurrence` block). A trait cannot `extends` a type or compose other traits. This keeps resolution simple and deterministic.

### Recurrence

A trait may carry a `recurrence` block. Any type that composes the trait then spawns a successor note when a field transitions into a value — the foundation of the [task system](/automation/task-system/). The trigger is a field transition, **not a clock** (no cron, no daemon).

```json
"traits": {
  "recurring": {
    "fields": {
      "next": { "prompt": "relation", "source": "task" }
    },
    "recurrence": {
      "on": "status = done",
      "template": "review-checklist",
      "set": { "deadline": "deadline + 7d" }
    }
  }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `on` | string | Yes | Trigger transition, `<field> = <value>` (e.g. `"status = done"`). The successor is spawned when the field transitions **into** this value |
| `template` | string | No | Template to spawn from. Defaults to the type's own default template (a task begets a task); a named template can spawn a different type |
| `name_template` | string | No | Name pattern for the successor (e.g. `"Review: {name}"`). Interpolated with the same tokens as filename patterns — `{name}` (predecessor's name), `{date}` / `{date:FORMAT}`, and any predecessor field `{field}` — then sanitized for a filename. Gives a cross-type successor a meaningful name instead of a numeric suffix; vault-global basename uniqueness is still enforced on the result. Defaults to carrying the predecessor's name forward |
| `set` | object | No | Field-offset assignments. Each value is `<dateField> + <duration>` (e.g. `"deadline + 7d"`); the base **must** be a date field |

The `next` relation field does triple duty: it is the **chain link** (history), the **idempotency guard** (a successor is spawned only when `next` is empty), and the basis for the audit **backstop** (`missing-successor`). See the [task system guide](/automation/task-system/) for the full two-path execution model and validation rules.

### Transition guards

A trait may require direct related notes to satisfy constrained predicates
before a field enters a value:

```json
"transition_guards": [{
  "on": "status = accepted",
  "requires": [{
    "relation": "requirements",
    "min": 1,
    "all": { "field": "status", "equals": "satisfied" },
    "failed_when": { "field": "status", "in": ["failed", "needs-revision"] },
    "stale_when": { "field": "status", "in": ["stale", "superseded"] }
  }]
}]
```

`relation` must name an effective relation field; its `source` constrains the
target type. Predicates inspect one target field using exactly one of `equals`
or `in`. `min` defaults to one. Every resolved target must satisfy `all`, and
missing, unresolved, stale, or failed evidence blocks the transition.

Guards are checked only when the source field enters the configured value.
Bowerbird locks the source and all resolved evidence notes together before the
final check and write. Use [`bwrb explain`](/reference/commands/explain/) to
inspect the same result without mutating the note.

### Transition effects

A trait may update one directly related note when a source field enters a value:

```json
"transition_effects": [{
  "on": "status = accepted",
  "relation": "task",
  "set": { "status": "done", "completed-at": "$TODAY" }
}]
```

The relation must be a scalar effective `relation` field; an empty relation is
a no-op. `set` is a flat literal patch. `$ACTOR`, `$NOW`, and `$TODAY` are the
only expanded values. Bowerbird prepares and validates both notes, locks them
in a stable shared order, rechecks their bytes, and writes the target directly.
Target writes never trigger further effects or recurrence. If a later write
fails, Bowerbird restores only its own earlier source bytes, never a newer
writer's change.

### Precedence

When the same field name comes from more than one source, resolution layers sources from least- to most-specific, so a more specific layer fully replaces a less specific one. Final precedence, **highest wins**:

```
own type fields  >  traits  >  inherited (parent chain)
```

- **Inherited** fields are applied first (root ancestor → parent). A closer ancestor's field fully replaces a farther one.
- **Traits** are composed next, in the order the type lists them. A trait field **fully replaces** an inherited field of the same name (all keys — `prompt`, `options`, `label`, everything), and a **later trait in the array fully replaces an earlier one** (last-wins).
- **Own fields** are applied last, and how they override depends on where the colliding field came from:
  - **vs a trait field** → own **fully replaces** it (all keys). This is the "own wins over traits" guarantee: own's `prompt`, `options`, and `label` all win, and validation uses own's options. Because a trait already fully replaced any inherited field of that name, a field that arrived through a trait is always full-overridden here — no trait values leak through.
  - **vs an inherited field** (parent chain, no trait involved) → the own field
    explicitly key-merges onto the inherited definition. Declared metadata and
    structural keys (`prompt`, `options`, `multiple`, `required`, `source`,
    `label`, and so on) win; omitted keys remain inherited.

Worked example — `status` defined in three places:

| Setup | Resolved `status` |
|-------|-------------------|
| `base.status` + `task` own `status` (no trait) | inherited definition with every explicitly declared own key merged over it |
| `actionable.status` (trait) + `task` own `status` | own definition, in full (trait's `options`/`label` dropped) |
| `base.status` + `actionable.status` (trait), no own | trait definition, in full (inherited dropped) |
| `base.status` + `actionable.status` (trait) + `task` own `status` | own definition, in full (the trait first fully replaced `base`, then own fully replaced the trait — no inherited or trait leak) |
| `first.status` + `second.status`, `traits: ["first","second"]` | `second`'s definition, in full (last trait wins) |

### Validation

- A type composing an **unknown trait** is a deterministic schema error (`bwrb` refuses to load the schema), the same way `extends` pointing at an unknown type fails.
- Because traits are flat, there is no trait→trait or trait→type resolution to validate.

### Seeing resolved fields

`bwrb schema list type <name>` groups a type's fields by origin — **own**, **trait** (one section per composed trait), and **inherited** (one section per ancestor) — so you can see exactly which trait contributed each field. The verbose tree (`bwrb schema list --verbose`) and JSON output (`--output json`, which adds a `trait_fields` block) carry the same provenance.

---

## Fields

Fields define the frontmatter properties of a note. Each field has a name (the object key) and a definition specifying how values are collected and stored.

### Field Types Overview

| Type | Prompt | Stored As | Use Case |
|------|--------|-----------|----------|
| Static | — | as defined | Fixed values, computed dates |
| `text` | Single-line input | `string` | Names, descriptions |
| `number` | Numeric input | `number` | Priority, counts |
| `boolean` | Y/n confirm | `true`/`false` | Flags, toggles |
| `date` | Date input | `string` (YYYY-MM-DD) | Deadlines, dates |
| `relative-date` | JSON/object input | object or object list | Query-time positions relative to another note |
| `select` | Picker from options | `string` or `string[]` | Status, category |
| `relation` | Picker from vault | `string` (wikilink) | Links to other notes |
| `list` | Comma-separated input | `string[]` | Tags, aliases |

### Static Fields

Fields with `value` are not prompted—they're computed automatically:

```json
{
  "type": { "value": "task" },
  "created": { "value": "$NOW" },
  "date": { "value": "$TODAY" },
  "actor": { "value": "$ACTOR" }
}
```

**Special values:**
- `$NOW` — Current datetime: `2025-01-07 14:30`
- `$TODAY` — Current date: `2025-01-07`
- `$ACTOR` — Logical runner identity resolved from root `--actor`, then
  `BWRB_ACTOR`, then `unknown`. This is provenance, not authentication.

### text

Free-form single-line input.

```json
{
  "description": {
    "prompt": "text",
    "label": "Brief description",
    "required": false
  }
}
```

### number

Numeric input with validation.

```json
{
  "priority": {
    "prompt": "number",
    "default": "3"
  }
}
```

### boolean

Yes/no confirmation prompt.

```json
{
  "archived": {
    "prompt": "boolean",
    "default": "false"
  }
}
```

Stored as `true` or `false` (YAML booleans).

### date

Date input. By default a full `YYYY-MM-DD` is required.

```json
{
  "deadline": {
    "prompt": "date",
    "required": false
  }
}
```

#### Partial dates and granularity

Many dates are legitimately approximate — you remember the month or year, not the
day. Set `granularity` on a date field to allow partial ISO dates. `granularity`
is the *coarsest* precision allowed; finer values are always accepted:

| `granularity` | Accepts |
| --- | --- |
| `day` (default) | `2026-05-12` |
| `month` | `2026-05`, `2026-05-12` |
| `year` | `2026`, `2026-05`, `2026-05-12` |

```json
{
  "last-contact": {
    "prompt": "date",
    "granularity": "month"
  }
}
```

Partial dates are stored verbatim (ISO partials still sort lexically). To relax
the default for *all* date fields at once, set [`date_granularity`](#config) in
config; a field's own `granularity` overrides that default.

### relative-date

Structured constraints that position a note relative to another note's date or
relative-date field. The raw constraint is stored in frontmatter; resolved
positions are computed at query time and are never written back to the note.

```json
{
  "position": {
    "prompt": "relative-date",
    "source": "event"
  }
}
```

Stored value:

```yaml
position:
  - kind: equal
    ref: "[[The Rending]]"
    field: start
    offset: 34h
```

`kind` is `equal`, `after`, or `before`. `ref` is the anchor note reference.
`field` is optional; when omitted, Bowerbird uses the anchor's date field, then
its relative-date field. `offset` is an optional signed duration using `min`,
`h`, `d`, or `w`.

`bwrb list --output json` expands the field to include `source`, `resolved`, and
`resolution`. `--sort <field>` and `--where` comparisons use the resolved value,
with unresolved values sorted last. Audit reports cycles, contradictions,
invalid anchor references, and after/before bound violations as warnings. See
[Relative Dates](/concepts/relative-dates/) for the full query-time behavior.

### select

Choose from predefined options.

```json
{
  "status": {
    "prompt": "select",
    "options": ["raw", "inbox", "in-flight", "done", "dropped"],
    "default": "raw",
    "required": true
  }
}
```

#### Documenting options

Any option can be written as a `{ value, description }` object instead of a bare
string. The description explains what the value means; it shows up as a hint in
the `bwrb new` picker and in `bwrb schema list` / its JSON output. Bare strings
and objects can be mixed freely in the same list:

```json
{
  "status": {
    "prompt": "select",
    "options": [
      { "value": "active", "description": "currently being worked on" },
      { "value": "waiting", "description": "blocked; trigger noted in the body" },
      "backlog"
    ]
  }
}
```

For multi-select (array output):

```json
{
  "tags": {
    "prompt": "select",
    "options": ["urgent", "blocked", "waiting", "review"],
    "multiple": true
  }
}
```

### relation

Link to other notes in the vault. Shows a picker filtered by type.

```json
{
  "milestone": {
    "prompt": "relation",
    "source": "milestone",
    "required": false
  }
}
```

**Source options:**
- Specific type: `"source": "milestone"` — only milestones
- Type branch: `"source": "objective"` — objectives and all descendants (task, milestone, project, etc.)
- Any note: `"source": "any"` — entire vault

**Name collisions:** relation fields resolve bare note names through the field's
`source` type when possible. If `context` has `"source": "context"`, then
`context: [[Poetry]]` resolves to the `context` note named `Poetry` even when a
different note type also has that name. If more than one matching source-type
note shares the name, path-qualify the link (for example `[[contexts/Betson]]`).
Path-qualified links keep exact path behavior. See the
[`list` command](/reference/commands/list/) for the full link-resolution
rule.

**Filtering results:**

```json
{
  "milestone": {
    "prompt": "relation",
    "source": "milestone",
    "filter": {
      "status": { "not_in": ["done", "dropped"] }
    }
  }
}
```

Filter conditions:
- `equals`: Field must equal value
- `not_equals`: Field must not equal value
- `in`: Field must be one of values
- `not_in`: Field must not be one of values

**Multiple relations:**

```json
{
  "related": {
    "prompt": "relation",
    "source": "any",
    "multiple": true
  }
}
```

**Owned relations:**

When `owned: true`, referenced notes are private to the parent and colocate in the parent's folder:

```json
{
  "chapters": {
    "prompt": "relation",
    "source": "chapter",
    "multiple": true,
    "owned": true
  }
}
```

Owned notes:
- Live in the owner's subfolder (e.g., `drafts/My Novel/chapters/`)
- Cannot be referenced by other notes' frontmatter fields
- Are still discoverable via `bwrb list`
- If moved out of that subfolder — **or** placed under a *different* owner's owned
  subfolder — `bwrb audit` flags them as
  [`owned-wrong-location`](/reference/commands/audit/#issue-codes) (resolved via the
  **declaring** owner's `owned` declaration, not the note's current folder) and
  `--fix` **restores them under the declaring owner** — `<owner-dir>/<field>/` —
  rather than filing them in the owned type's own `output_dir` or leaving them under
  the wrong owner
- If the **same note name is declared by two or more owners**, ownership is
  ambiguous: audit reports
  [`owned-ambiguous-owner`](/reference/commands/audit/#issue-codes) and **never**
  auto-restores the note under a guessed owner. Resolve it manually — remove the
  duplicate `owned` declaration, or rename the note so each owner's declaration is
  unique

### list

Comma-separated input stored as an array.

```json
{
  "aliases": {
    "prompt": "list",
    "label": "Aliases (comma-separated)"
  }
}
```

Output format controlled by `list_format`:
- `yaml-array` (default):
  ```yaml
  aliases:
    - one
    - two
    - three
  ```
- `comma-separated`: `"one, two, three"`

---

## Field Roles

A **field role** marks a field as something bwrb understands and acts on, beyond
just storing a value. Roles are declared with a boolean flag on the field and are
consulted uniformly wherever the behavior applies — so they are reliable, not a
loose naming convention.

### `owned`

Marks a `relation` field whose referenced notes are private to the parent and
colocate in the parent's folder. See [Owned relations](#owned-relations) above.

### `alias`

Marks a field as holding the entity's **aliases** — alternate names the entity is
also known by. bwrb consults aliases during name resolution and linking, so an
entity is **findable and linkable by its aliases wherever it is findable by its
name**:

- `bwrb list --name` and `bwrb edit` resolve a query to an entity when
  it matches one of the entity's aliases (a real note name always wins over an
  alias of the same string — **case-insensitively**, consistent with the rest of
  resolution, so a real note `steve` wins over an entity merely aliased `Steve`).
- Relation/link targets written as `[[An Alias]]` resolve to the aliased entity.

Declare the role with `alias: true` on a list field:

```json
{
  "aliases": {
    "prompt": "list",
    "alias": true,
    "list_format": "yaml-array"
  }
}
```

A note then declares its aliases like any Obsidian `aliases` field:

```yaml
---
type: person
aliases:
  - Steve
  - stevey
---
```

**Validation.** Because `aliases` is a recognized role, bwrb validates the value
as an array of **non-empty, unique strings** (the Obsidian `aliases` format).
The write path (`bwrb new`/`bwrb edit`) rejects a scalar value, empty/whitespace
entries, non-string entries, and duplicates as a hard error. `bwrb audit` reports
the **same** conditions at **error** severity (an [`illegal-aliases`](/reference/commands/audit/#alias-hygiene-illegal-aliases)
issue), so write and audit agree — a note hand-written with duplicate or blank
aliases is an error, not a warning.

**Auto-fix.** `bwrb audit --fix` cleans the safe, idempotent cases: it drops
empty/whitespace entries and de-duplicates (preserving the first occurrence). It
never merges distinct aliases. A **non-string** entry stays flag-only (bwrb can't
infer the intended text); a non-array value is reported as `wrong-scalar-type`.

**Back-compat.** The role is optional. Types that declare no alias field, and
notes without an `aliases` value, keep working unchanged.

**Ambiguity is never auto-resolved.** If two entities share an alias, the alias
resolves to multiple candidates and bwrb surfaces them rather than guessing.

:::note
At most one field per type should carry the `alias` role. The role is inherited,
so declaring it on a base type (e.g. `entity`) applies to all descendants.
:::

---

## Derived Fields

A derived field is a virtual scalar calculated at query time. Most expressions
read fields on the same note; boolean fields may also inspect one hop across a
declared relation with `all()` or `any()`. Declare its expression and result
type instead of a prompt:

```json
{
  "score": {
    "derived": {
      "expression": "importance * 4 + excitement",
      "type": "number"
    }
  }
}
```

Supported result types are `string`, `number`, `boolean`, and `date`. Date
results must be valid full `YYYY-MM-DD` values. Derived fields participate in
`list --output json`, `--fields`, `--where`, sorting, and dashboards, but are
never prompted for or written to Markdown. `new`, `edit`, and `bulk` reject
attempts to set them. If a note already stores a same-name value, query results
use the calculated value and `bwrb audit` reports `derived-field-persisted`.

Expressions use the ordinary Bowerbird expression language with a deliberately
bounded subset. They may reference concrete or earlier derived fields on the
effective inherited type and use pure scalar functions. A boolean derived field
may use `all(relation, target.predicate)` or `any(...)` over directly related
notes. Target predicates may read stored fields only; nested quantifiers and
additional graph traversal are not supported. Missing or `null` local inputs
produce `null` without evaluating the expression. Unknown fields,
self-references, dependency cycles, `file.*`, hierarchy functions, `now()`, and
relative-date dependencies are schema errors. Runtime evaluation, relation
resolution, or result-type errors fail the command and identify both the field
and note path.

For example, a task schema can own readiness without teaching Bowerbird any
workflow policy:

```json
{
  "depends-on": { "prompt": "relation", "source": "task", "multiple": true },
  "ready": {
    "derived": {
      "expression": "all(depends-on, target.status == 'done' || target.status == 'cancelled')",
      "type": "boolean"
    }
  }
}
```

The terminal statuses remain schema policy. Bowerbird supplies only typed,
read-only, one-hop quantification.

`today()` uses one query snapshot date. Pass `--as-of YYYY-MM-DD` to `list` or
`dashboard` for reproducible output; otherwise Bowerbird captures the local
calendar date once when the command starts. Saved dashboards do not persist an
as-of value.

---

## Field Properties Reference

Complete list of field properties:

| Property | Type | Applies To | Description |
|----------|------|------------|-------------|
| `derived` | object | virtual | `{ expression, type }` query-time scalar derivation. Mutually exclusive with stored/prompted field behavior |
| `value` | string | static | Fixed value (mutually exclusive with `prompt`) |
| `prompt` | string | prompted | Prompt type: `text`, `number`, `boolean`, `date`, `relative-date`, `select`, `relation`, `list` |
| `label` | string | prompted | Custom label shown during prompting (the imperative prompt text) |
| `description` | string | any | What this field is for and when to use it. Surfaced by `bwrb schema list`; distinct from `label` |
| `required` | boolean | prompted | Whether field must have a value (default: `false`) |
| `default` | string | prompted | Default value if user skips prompt. Date fields also accept creation-time expressions such as `@today` and `@today+7d` |
| `granularity` | string | `date` | Coarsest precision allowed: `day` (default), `month`, or `year`. Overrides `date_granularity` |
| `calendar` | string | `date` | Calendar id from `config.calendars`. Overrides the type's `calendar_default`; invalid on non-date fields |
| `options` | array | `select` | Allowed values: bare strings or `{ value, description }` objects |
| `multiple` | boolean | `select`, `relation` | Allow multiple values (default: `false`) |
| `source` | string | `relation`, `relative-date` | Type name to filter anchor/picker candidates, or `"any"` |
| `filter` | object | `relation` | Filter conditions for source query |
| `owned` | boolean | `relation` | Whether referenced notes are owned/colocated (default: `false`) |
| `alias` | boolean | `list` | Field role: marks this field as the entity's aliases. Value must be an array of non-empty, unique strings. Consulted by name resolution and linking (default: `false`) |
| `reset_on_fork` | boolean | any | When `true`, a fork copy omits this field so the new note can receive its schema default. The marker does not change ordinary `new` or `edit` behavior |
| `list_format` | string | `list` | Output format: `yaml-array` or `comma-separated` |

---

### Fork reset metadata

Set `reset_on_fork: true` on state that should not carry into a copied revision:

```json
{
  "status": {
    "prompt": "select",
    "options": ["draft", "published"],
    "default": "draft",
    "reset_on_fork": true
  }
}
```

The rule is deliberately mechanical: fork-aware copying omits the stored field,
then normal schema defaults may populate it. BWRB does not infer meaning from
names such as `status`, `published`, or `approved`. Ordinary note creation and
editing are unchanged by this marker.

For fields with `prompt: "date"`, schema defaults accept the same creation-time
date expressions as template defaults, including `@today`, `@today+7d`, and
`today() + '7d'`. They evaluate when the default is materialized by ordinary
creation, scoped blank-value restoration during `edit`, or `new --fork` after a
`reset_on_fork` field is omitted. Non-date fields keep these strings literally,
and malformed expressions fail before a note is written. Gregorian expressions
are not supported for custom-calendar fields because custom calendars do not
define a mapping from the current Gregorian date; use a literal date in that
calendar instead.

### Built-in lineage metadata

`forked-from` is a reserved built-in frontmatter field containing the UUID of a
note's immediate source. It is a UUID string, never a wikilink. Existing
lineage is audited, but normal JSON creation, edit, template input, schema
defaults, and audit fixes cannot set or modify this system-managed field. Use
`bwrb new --fork` for a newly created child or guarded
[`bwrb lineage adopt`](/reference/commands/lineage/) for two existing notes. Do not declare
`forked-from` in a type or trait's `fields`: schema loading and schema field
creation reject the reserved name, including declarations with `default` or
static `value` entries.

---

## Body Sections

Define document structure after frontmatter:

```json
{
  "body_sections": [
    {
      "title": "Description",
      "level": 2,
      "content_type": "paragraphs"
    },
    {
      "title": "Steps",
      "level": 2,
      "content_type": "checkboxes",
      "prompt": "list",
      "prompt_label": "Steps (comma-separated)"
    },
    {
      "title": "Notes",
      "level": 2,
      "content_type": "bullets",
      "children": [
        { "title": "Blockers", "level": 3 }
      ]
    }
  ]
}
```

### Section Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | string | **Yes** | Section heading text |
| `level` | integer | No | Heading level 2-6 (default: `2`) |
| `content_type` | string | No | Placeholder type: `none`, `paragraphs`, `bullets`, `checkboxes` |
| `prompt` | string | No | If `"list"`, prompts for initial content during creation |
| `prompt_label` | string | No | Label for the content prompt |
| `children` | array | No | Nested subsections |

---

## Config

Vault-wide settings:

```json
{
  "config": {
    "identity_store": "frontmatter-v1",
    "link_format": "wikilink",
    "open_with": "obsidian",
    "editor": "nvim",
    "visual": "code",
    "obsidian_vault": "My Vault",
    "default_dashboard": "inbox",
    "excluded_directories": ["Archive", "Templates"],
    "mention_link_once": true
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `identity_store` | string | `"registry-v1"` when omitted | Stable identity authority: legacy `registry-v1`, or distributed `frontmatter-v1`. New vaults explicitly use `frontmatter-v1`; change modes only with [`bwrb identity migrate`](/reference/commands/identity/) |
| `link_format` | string | `"wikilink"` | Link format for relations: `wikilink` (`[[Note]]`) or `markdown` (`[Note](Note.md)`) |
| `open_with` | string | `"system"` | Default for `--open`: `system`, `editor`, `visual`, or `obsidian` |
| `editor` | string | `$EDITOR` | Terminal editor command |
| `visual` | string | `$VISUAL` | GUI editor command |
| `obsidian_vault` | string | auto | Obsidian vault name for URI scheme |
| `default_dashboard` | string | — | Dashboard to run when `bwrb dashboard` has no name |
| `excluded_directories` | array | `[]` | Vault-relative directory prefixes excluded from discovery and targeting |
| `date_format` | string | `"YYYY-MM-DD"` | Generated full-date and parsing pattern (`YYYY`, `MM`, `DD` tokens); Gregorian date fields are stored canonically as ISO |
| `date_granularity` | string | `"day"` | Default coarsest date precision for all date fields: `day`, `month`, or `year`. Per-field [`granularity`](#partial-dates-and-granularity) overrides it |
| `calendars` | object | `{}` | Named custom-calendar definitions available to type `calendar_default` and field `calendar`; see [Custom Calendars](/concepts/custom-calendars/) |
| `mention_fuzzy_threshold` | integer | `2` | Maximum fuzzy edit distance after mention fuzzy analysis is explicitly selected (`0` disables fuzzy matching; range `0`–`5`; config alone does not opt in) |
| `mention_corpus_calibration` | boolean | `true` | Damp vault-common single-word mention targets using corpus casing statistics |
| `mention_corpus_min_notes` | integer | `3` | Minimum distinct non-self notes required before corpus damping can apply |
| `mention_corpus_noncanonical_ratio` | number | `0.5` | Strict non-canonical-case share threshold for corpus damping (`0`–`1`) |
| `mention_link_once` | boolean | `false` | During `audit --fix --auto`, write at most one new link per note/target pair; CLI flags can override per run |
| `mention_exclude_types` | array | `[]` | Type names excluded as mention targets; matching notes are still scanned as source documents |
| `mention_exclude_paths` | array | `[]` | Vault-relative globs excluded as mention targets; matching notes are still scanned as source documents |

`bwrb config list/edit` exposes the common scalar settings above, including
`date_format` and `date_granularity`. Calendar definitions and advanced
corpus/fuzzy tuning remain schema-only settings; edit `.bwrb/schema.json` and
validate it with `bwrb schema validate`. See
[bwrb config](/reference/commands/config/) for the exact editable subset and
[#790](https://github.com/3mdistal/bwrb/issues/790) for guided calendar
authoring.

---

## Audit Config

Configure the [`bwrb audit`](/reference/commands/audit/) command:

```json
{
  "audit": {
    "allowed_extra_fields": ["aliases", "cssclass", "publish"]
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `allowed_extra_fields` | array | Extra frontmatter fields that won't trigger warnings |

---

## IDE Integration

Add `$schema` to your schema file for editor autocomplete and validation:

```json
{
  "$schema": "https://bwrb.dev/schema.json",
  "types": { ... }
}
```

### VS Code

If the URL isn't reachable, configure the schema manually in `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/.bwrb/schema.json"],
      "url": "./node_modules/bwrb/schema.schema.json"
    }
  ]
}
```

Or reference a local copy of `schema.schema.json` (shipped with the `bwrb` package) from the bwrb repository.

### Neovim

With `nvim-lspconfig` and `jsonls`:

```lua
require('lspconfig').jsonls.setup({
  settings = {
    json = {
      schemas = {
        {
          fileMatch = { "*/.bwrb/schema.json" },
          url = "https://bwrb.dev/schema.json"
        }
      }
    }
  }
})
```

---

## Complete Example

A full schema demonstrating inheritance, relations, body sections, and config:

```json
{
  "$schema": "https://bwrb.dev/schema.json",
  "version": 2,
  "schemaVersion": "1.0.0",
  
  "config": {
    "link_format": "wikilink",
    "open_with": "obsidian"
  },
  
  "audit": {
    "allowed_extra_fields": ["aliases", "cssclass"]
  },
  
  "types": {
    "meta": {
      "fields": {
        "status": {
          "prompt": "select",
          "options": ["raw", "active", "settled", "dropped"],
          "default": "raw"
        },
        "created": { "value": "$NOW" }
      }
    },
    
    "idea": {
      "fields": {
        "tags": {
          "prompt": "select",
          "options": ["shower-thought", "research", "project-idea"],
          "multiple": true
        }
      },
      "body_sections": [
        { "title": "Description", "level": 2, "content_type": "paragraphs" }
      ]
    },
    
    "objective": {
      "fields": {
        "deadline": { "prompt": "date" }
      }
    },
    
    "task": {
      "extends": "objective",
      "recursive": true,
      "fields": {
        "status": { "default": "inbox" },
        "priority": {
          "prompt": "select",
          "options": ["low", "medium", "high"],
          "default": "medium"
        },
        "milestone": {
          "prompt": "relation",
          "source": "milestone",
          "filter": {
            "status": { "not_in": ["settled", "dropped"] }
          }
        },
        "parent": {
          "prompt": "relation",
          "source": "task"
        }
      },
      "body_sections": [
        {
          "title": "Steps",
          "level": 2,
          "content_type": "checkboxes",
          "prompt": "list",
          "prompt_label": "Steps (comma-separated)"
        },
        { "title": "Notes", "level": 2, "content_type": "bullets" }
      ]
    },
    
    "milestone": {
      "extends": "objective",
      "fields": {
        "project": {
          "prompt": "relation",
          "source": "project"
        }
      }
    },
    
    "project": {
      "extends": "objective"
    },
    
    "draft": {
      "fields": {
        "draft-status": {
          "prompt": "select",
          "options": ["idea", "outlining", "drafting", "revising", "done"],
          "default": "idea"
        },
        "chapters": {
          "prompt": "relation",
          "source": "chapter",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "chapter": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "word-count": { "prompt": "number" }
      }
    },
    
    "person": {
      "fields": {
        "email": { "prompt": "text" },
        "company": { "prompt": "text" }
      }
    }
  }
}
```

---

## See Also

- [Schema](/concepts/schema/) — Why schema matters
- [Types and Inheritance](/concepts/types-and-inheritance/) — Mental model for type hierarchies
- [Validation and Audit](/concepts/validation-and-audit/) — Keeping notes in sync
- [`bwrb schema`](/reference/commands/schema/) — Schema management commands
- [`bwrb audit`](/reference/commands/audit/) — Validate notes against schema

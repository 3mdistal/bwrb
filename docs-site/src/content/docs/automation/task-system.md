---
title: Task System (Recurrence & Multi-Spawn)
description: Declarative, event-driven task recurrence and staggered multi-spawn templating — no cron, no daemon, no LLM.
---

Bowerbird's task system is **declarative**: recurrence and templating together make a
real task system out of the schema itself. There is **no cron, no daemon, and no LLM** —
the schema is the system.

It has two mechanisms:

1. **Recurrence** — spawn a successor note when a field transitions (e.g. `status` enters
   `done`).
2. **Multi-spawn templating** — a parent template that scaffolds several staggered child
   notes on creation.

## Recurrence: spawn-on-transition

The trigger is a **field transition, not a clock**. Declaratively: "when `status` enters
`done`, spawn a successor from a template, with the successor's date field offset from a
predecessor date field."

Recurrence rides on a **trait** (see
[Types and Inheritance](/concepts/types-and-inheritance/)). Add a `recurrence` block to a
trait, and any type that composes that trait recurs.

```yaml
# .bwrb/schema.json (shown as YAML for readability)
traits:
  recurring:
    fields:
      next: { prompt: relation, source: task }   # the chain field (see below)
      prev: { prompt: relation, source: task }
    recurrence:
      on: "status = done"          # trigger transition
      template: <name>             # optional; defaults to the type's default template
      set:
        deadline: "deadline + 7d"  # FIELD-OFFSET ONLY; base must be a date field

types:
  task:
    output_dir: tasks
    traits: [recurring]
    fields:
      name: { prompt: text, required: true }
      status: { prompt: select, options: [todo, doing, done], default: todo }
      deadline: { prompt: date }
```

Completing a task now spawns its successor automatically.

### The date rule: field-offset only

The successor's date is computed as:

```
successor.<dateField> = <predecessor date field> + <offset>     e.g. deadline + 7d
```

- The referenced **base must be a date field.**
- **Transition-time offsets** (e.g. "a week after I actually finished") are **not
  supported** — they can only be exact on the immediate write, never reproducible by the
  audit backstop, so they would be inconsistent. Field-offset is computed identically on
  both paths.
- **Calendar-anchored bases** ("next Monday") are **deferred.**

Offsets accept `min`, `h`, `d`, `w`, `mon` (or `m`), and `y`. Day/week offsets are exact;
month/year offsets are calendar-aware (e.g. `deadline + 1mon` lands on the same day next
month).

### The template

The successor's template defaults to **the completed note's type default template** (a
task begets a task). Naming a template can spawn a **different type** — finish a `draft`,
spawn a `review`:

```yaml
    recurrence:
      on: "status = done"
      template: review-checklist   # a template whose template-for is `review`
```

The audit validates that the referenced template exists (a rule pointing at a deleted
template is a deterministic error — see below).

### The `next` field does three jobs

A single `next` relation field collapses three requirements into one mechanism:

1. **Graph chain / history** — the linked thread of recurring instances, for free. The
   spawned successor's `prev` links back to its predecessor.
2. **Idempotency** — a successor is spawned **only if `next` is empty.** Re-completing a
   task that already has a `next` is a **no-op**.
3. **Audit backstop check** — "missing successor" is literally _trigger satisfied + `next`
   empty + type recurs_.

## Two-path execution (reliability)

Recurrence integrity holds **regardless of how a task was completed.**

### Fast path

Completing a recurring note **through bwrb** spawns the successor immediately as a
deterministic side-effect of the write:

```sh
bwrb edit "tasks/Water plants.md" --json '{"status":"done"}'
# or
bwrb bulk --type task --where "status == 'doing'" --set status=done --execute
```

Either spawns one successor with the offset deadline and the `next`/`prev` chain links.

### Backstop (audit)

Completing a note **outside bwrb** (e.g. hand-editing frontmatter in Obsidian) is caught
on the next audit:

```sh
bwrb audit --path "tasks/**"            # flags: missing-successor
bwrb audit --path "tasks/**" --fix      # spawns the missing successor
bwrb audit --all --fix --auto --execute # headless: spawn all missing successors
```

The backstop uses the **same engine** as the fast path, so it produces an **identical**
successor (same offset date, same chain links). Both paths are idempotent: re-running
never spawns a duplicate.

> **Tip for AI/agent workflows:** always edit note fields **via bwrb**, never by writing
> frontmatter directly. That feeds the fast path and keeps the chain consistent in real
> time. The audit backstop is there for everything else.

### Config validation

A broken recurrence rule is a deterministic **config** error, surfaced by `bwrb audit` as
`invalid-recurrence` (never auto-fixed):

- a malformed `on` trigger,
- an offset whose base is not a date field,
- a `template` that does not exist in the vault.

## Multi-spawn templating

A parent template can scaffold several related child notes on creation, with staggered
deadlines computed from today via [date expressions](/templates/creating-templates/):

```yaml
# .bwrb/templates/project/write-an-article.md
---
type: template
template-for: project
instances:
  - { type: task, defaults: { title: "Outline", deadline: "@today+1d" } }
  - { type: task, defaults: { title: "Draft",   deadline: "@today+3d" } }
  - { type: task, defaults: { title: "Edit",    deadline: "@today+5d" } }
  - { type: task, defaults: { title: "Publish", deadline: "@today+7d" } }
---
```

```sh
bwrb new project --template write-an-article
```

This creates the project **and four staggered task notes**, each with a distinct,
meaningful filename derived from its `title` (no more collapsing into a single
`task.md`). Multiple instances of the same type are automatically disambiguated.

## Synthesis

- **Templates** define what work _looks like_ (the staggered plan).
- **Recurrence rules** define when work _regenerates_ (on completion).
- bwrb executes deterministically (fast path) and `audit` backstops it.

The whole system is declared in schema + templates, so an agent operates it natively. No
daemon, no cron, no LLM.

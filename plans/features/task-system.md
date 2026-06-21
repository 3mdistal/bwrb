# Task System: Recurrence + Templating

> Recurrence and templating together make a real, *declarative* task system —
> no daemon, no cron, no LLM. The schema is the system.
>
> Reframes issue #107 (was "cron recurrence", now "event-driven spawn + offset templating").
> Recurrence config rides on a trait — see `schema-expressiveness.md` (#442).

---

## Two mechanisms

### A. Recurrence = spawn-on-transition (event-driven)

The trigger is a **field transition, not a clock.** Declaratively: "when `status` enters `done`, spawn a successor from a template, with the successor's date field offset from a predecessor date field."

#### Two-path execution (the reliability model)
Same pattern as `audit: unlinked-mention` in `ingest-safety-net.md`:

- **Fast path** — completing via `bwrb edit` / `bulk --set status=done` spawns the successor immediately, as a deterministic side-effect of the write.
- **Backstop** — completing *in Obsidian* (bwrb never saw it) is caught on the next `bwrb audit`: "`status = done` AND `next` empty AND type has the `recurring` trait" → spawn the missing successor.

So recurrence integrity holds **regardless of how the task was completed**. The task system inherits the "nothing swept under the rug" guarantee.

> **Cross-repo dependency:** the **teenylilthoughts** `AGENTS.md` must instruct the agent to **always edit note fields via bwrb**, never directly. This feeds the fast path and dogfoods bwrb (surfacing issues naturally). (This is a vault-side directive — NOT for bwrb's own repo AGENTS.md, which is dev-focused.)

#### Date rule: field-offset ONLY (decided)
```
successor.<dateField> = <predecessor date field> + <offset>     e.g. deadline + 7d
```
- The referenced base **must be a date field.**
- **Transition-time offset (`completed + 7d`) was rejected.** It's only exact on the fast path; the Obsidian backstop can't know *when* the change happened (mtime is fuzzy), so it would be inconsistent. Field-offset is computed identically in both paths → fully robust. Robustness wins over the slightly nicer "a week after I actually finished" semantics.
- "next Monday" / calendar-anchored bases: **deferred.** Add later only if missed.

#### Config (rides on the `recurring` trait)
```yaml
traits:
  recurring:
    fields:
      next: { prompt: relation }          # see "one field, three jobs" below
    recurrence:
      on: "status = done"                  # trigger transition
      template: <name>                     # default: the type's own default template
      set:
        deadline: "deadline + 7d"          # field-offset; base must be a date field
```
- Template **defaults to the completed note's type default template** (a task begets a task); name one to spawn something different (finish "draft" → spawn "review").
- **Audit validates the referenced template exists** — a rule pointing at a deleted template is a deterministic error. Config gets the same safety net as data.

#### One field, three jobs
A single `next` (and/or `prev`) relation field collapses three requirements into one mechanism:
1. **Graph chain / history** — the linked thread of recurring instances, for free.
2. **Idempotency** — spawn only if `next` is empty; re-completing a task that already has a `next` is a no-op.
3. **Audit backstop check** — the "missing successor" detection is literally "done + `next` empty + `recurring` trait".

### B. Template multi-spawn with offset deadlines

The "write-an-article spawns its 10 predictable tasks, deadlines staggered from today" workflow.

- **`InstanceScaffold` already exists** (`src/types/schema.ts:393`): a parent template can spawn multiple related files on creation, each with its own template + defaults.
- **The gap is date-offset expressions in template values.** Today template interpolation is basic (`{date}`, `{date:FORMAT}`, `{title}`, `@today` in meta defaults — `src/lib/template.ts:643`). There's a `date-expression.ts` engine (used for constraints/queries) **not yet wired into template value generation.**

```yaml
# .bwrb/templates/project/write-an-article.md
instances:
  - { template: task, defaults: { title: "Outline", deadline: "@today+1d" } }
  - { template: task, defaults: { title: "Draft",   deadline: "@today+3d" } }
  - { template: task, defaults: { title: "Edit",    deadline: "@today+5d" } }
  - { template: task, defaults: { title: "Publish", deadline: "@today+7d" } }
```
`bwrb new project --template write-an-article` → ten staggered tasks. The only real work: teach template values to evaluate date expressions via the existing engine.

---

## Synthesis
- **Templates** define what work *looks like* (the staggered plan).
- **Recurrence rules** define when work *regenerates* (on completion).
- bwrb executes deterministically (fast path) and audit backstops it.
- The whole system is declared in schema + templates, so the agent operates it natively (schema-as-language). No daemon, no cron, no LLM.

## Build dependencies
- Recurrence config needs **traits** (#442) and a **date-expression-in-values** capability.
- Multi-spawn needs the same **date-expression-in-values** capability (shared with recurrence) on top of existing `instances`.
- Backstop needs a new **audit detection** (missing-successor), sibling to `unlinked-mention`.

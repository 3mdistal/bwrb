# bwrb new command flow

> Internal architecture note for how `bwrb new` branches between interactive/JSON and owned/pooled creation paths.

**Canonical docs:** User-facing behavior and flag semantics live in docs-site. See `docs-site/src/content/docs/reference/commands/new.md` (command reference), `docs-site/src/content/docs/templates/overview.md` (templates), and `docs-site/src/content/docs/concepts/schema.md` (schema). Source-of-truth policy: `docs/product/canonical-docs-policy.md`.

---

## Overview

`bwrb new` has four creation flows (interactive/JSON × owned/pooled). The command handler in `src/commands/new.ts` selects the path, delegates to the interactive or JSON module, resolves ownership, and finally writes the note + optional instances via `writeNotePlan`.

Key decisions:

- `--json` switches to non-interactive JSON mode.
- Template selection is controlled by `--template`, `--no-template`, or interactive selection when multiple templates exist.
- Ownership is controlled by `--owner`, `--standalone`, or interactive ownership prompts.
- Instance scaffolding is controlled by `--no-instances`.

---

## Decision flow

```mermaid
flowchart TD
  Start([bwrb new]) --> JsonMode{--json provided?}
  JsonMode -->|yes| RequireType[Type path required]
  JsonMode -->|no| ResolveType[Resolve type path
(positional/--type or prompt)]

  RequireType --> JsonTemplate{Template flags?}
  ResolveType --> InteractiveTemplate{Template flags?}

  JsonTemplate -->|--no-template| JsonOwnership[Resolve JSON ownership]
  JsonTemplate -->|--template| JsonTemplateLoad[Load template by name]
  JsonTemplate -->|none| JsonOwnership
  JsonTemplateLoad --> JsonOwnership

  InteractiveTemplate -->|--no-template| InteractiveOwnership[Resolve interactive ownership]
  InteractiveTemplate -->|--template| InteractiveTemplateLoad[Load template by name]
  InteractiveTemplate -->|prompt| InteractiveTemplatePrompt[Prompt for template]
  InteractiveTemplateLoad --> InteractiveOwnership
  InteractiveTemplatePrompt --> InteractiveOwnership

  JsonOwnership --> JsonContent[Build JSON content + validate]
  InteractiveOwnership --> InteractiveContent[Prompt fields + build content]

  JsonContent --> WritePlan[writeNotePlan]
  InteractiveContent --> WritePlan

  WritePlan --> Instances{Template has instances?}
  Instances -->|yes + !--no-instances| Scaffold[Handle instance scaffolding]
  Instances -->|no or --no-instances| Done[Return path (JSON includes instances when created)]
  Scaffold --> Done
```

---

## Flow details

### Interactive + owned

Use when `--json` is not provided and ownership resolves to owned.

- `newCommand` resolves the type and template resolution (`src/commands/new.ts`).
- `createNoteInteractive` prompts for ownership via `resolveInteractiveOwnership` and prompts for field values (`src/commands/new/interactive.ts`).
- Ownership prompts prefer `--owner`, then fall back to interactive selection when owners exist (`src/commands/new/ownership.ts`).
- `writeNotePlan` writes the note into the owner-specific directory and optionally scaffolds instances (`src/commands/new/write-plan.ts`).

Example:

```bash
bwrb new research --owner "[[My Novel]]"
```

### Interactive + pooled

Use when `--json` is not provided and ownership resolves to pooled/standalone.

- Same flow as interactive + owned, but `resolveInteractiveOwnership` returns `{ kind: 'pooled' }`.
- Output directory is resolved from the type’s `output_dir`.

Example:

```bash
bwrb new research --standalone
```

### JSON + owned

Use when `--json` is provided and ownership resolves to owned.

- `newCommand` requires a type path and optional template resolution (`src/commands/new.ts`).
- `createNoteFromJson` parses JSON, merges template defaults, validates frontmatter, and resolves ownership (`src/commands/new/json-mode.ts`).
- Ownership resolution enforces `--owner`/`--standalone` conflicts and validates owner existence (`src/commands/new/ownership.ts`).
- `writeNotePlan` writes the note and reports instances in JSON output when scaffolding occurs (`src/commands/new/write-plan.ts`).

Example:

```bash
bwrb new task --json '{"name": "Fix bug"}' --owner "[[My Novel]]"
```

### JSON + pooled

Use when `--json` is provided and ownership resolves to pooled/standalone.

- Same flow as JSON + owned, but ownership resolves to `{ kind: 'pooled' }`.
- Output directory is resolved from the type’s `output_dir`.

Example:

```bash
bwrb new task --json '{"name": "Fix bug"}' --standalone
```

---

## Integration points (cross-cutting features)

### Template resolution

- Interactive resolution happens in `resolveTemplateResolution` (`src/commands/new.ts`), which can prompt when multiple templates exist.
- JSON mode expects an explicit `--template` or uses schema-only defaults (`src/commands/new/json-mode.ts`).
- Template merging + validation happens through `resolveTemplateWithInheritance`, `validateConstraints`, and `processTemplateBody` in `src/lib/template.ts`.

### Ownership

- Interactive ownership prompts live in `resolveInteractiveOwnership` and its helper `resolveOwnership` (`src/commands/new/ownership.ts`).
- JSON mode uses `resolveJsonOwnership`, which enforces conflicts between `--owner` and `--standalone` and validates owner existence.

### Output + scaffolding

- All flows converge on `writeNotePlan` (`src/commands/new/write-plan.ts`).
- Ownership determines output directory: owned notes use `ensureOwnedOutputDir`, pooled notes use `output_dir` from schema.
- Instance scaffolding is triggered via `handleInstanceScaffolding` when a template defines instances and `--no-instances` is not set.

### JSON output

- JSON mode produces a `jsonSuccess` payload with the created path and optional `instances` data (`src/commands/new.ts`).
- JSON-mode errors are routed through `JsonCommandError` and `throwJsonError` to preserve structured output.

---

## Related canonical docs

- `docs-site/src/content/docs/reference/commands/new.md`
- `docs-site/src/content/docs/templates/overview.md`
- `docs-site/src/content/docs/concepts/schema.md`

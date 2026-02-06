# `bwrb new` command flow (developer)

This note maps the branching flow in `src/commands/new.ts` so contributors can add features without tracing the whole file.

## Scope and non-goals

- Scope: document current behavior and stable contracts for note creation.
- Non-goal: this doc does not change runtime behavior.
- Canonical command code: `src/commands/new.ts`.

## Contracts this command must honor

- JSON output contract (`docs/product/cli-output-contract.md`):
  - In `--output json`, emit exactly one JSON value to stdout.
  - Keep human logs/prompts off stdout.
  - JSON mode should be non-interactive; missing inputs become JSON errors.
- System frontmatter (`docs/product/system-frontmatter.md`):
  - `id` is reserved/system-managed and cannot be set in `--json` input.
  - `name` is system-allowed frontmatter.
- Type/ownership invariants (`docs/technical/inheritance.md`, `docs/product/type-system.md`):
  - Owned notes are created in owner-scoped paths.
  - Ownership and context validation must remain enforced.

## Terminology

- `interactive`: no `--json`; prompts are allowed.
- `json`: `--json <frontmatter>`; non-interactive creation path.
- `owned`: note created under an owner note path (`--owner` or interactive ownership selection).
- `pooled` (standalone/shared): note created in the type `output_dir`.

## Flow selector (4 core flows)

| Creation mode | Ownership mode | Trigger | Primary path |
|---|---|---|---|
| Interactive | Pooled | Type not owned, or `--standalone`, or choose standalone | `createNote` -> `resolveInteractiveOwnership` -> pooled `writeNotePlan` |
| Interactive | Owned | Type can be owned and owner selected/provided | `createNote` -> `resolveInteractiveOwnership` -> owned `writeNotePlan` |
| JSON | Pooled | `--json` with no valid `--owner` | `createNoteFromJson` -> `resolveJsonOwnership` -> pooled `writeNotePlan` |
| JSON | Owned | `--json --owner "[[Owner]]"` for ownable child type | `createNoteFromJson` -> `resolveJsonOwnership` -> owned `writeNotePlan` |

Supporting toggles (apply within these 4 flows):

- Template resolution: `--template <name>` or auto-discovery in interactive mode, disabled with `--no-template`.
- Instance scaffolding: enabled by default when template defines instances, disabled with `--no-instances`.
- Post-create open: `--open` triggers `openNote` after successful write.

## Decision flow (plain-text diagram)

```text
CLI action
  |
  +--> load vault + schema
        |
        +--> --json present?
              |
              +--> yes (JSON mode)
              |     |
              |     +--> resolve template (optional: --template, skip with --no-template)
              |     +--> createNoteFromJson(...)
              |           |
              |           +--> resolveJsonOwnership(...)
              |           +--> buildJsonNoteContent(...)
              |           |     - parse JSON (+ optional _body)
              |           |     - merge template defaults
              |           |     - validate frontmatter/context/constraints/cycle
              |           +--> writeNotePlan(...)
              |                 - resolve output dir (owned or pooled)
              |                 - sanitize filename
              |                 - inject id (+ owner field when owned)
              |                 - write note + optional instance scaffolding
              |     +--> print JsonSuccess / JsonError envelope
              |     +--> optional --open
              |
              +--> no (interactive mode)
                    |
                    +--> resolveTypePath(...) (type prompts/subtype navigation)
                    +--> resolve template with inheritance (or no-template)
                    +--> createNote(...)
                          |
                          +--> resolveInteractiveOwnership(...)
                          +--> buildInteractiveNoteContent(...)
                          |     - prompt fields/body as needed
                          |     - apply/validate template constraints
                          +--> writeNotePlan(...)
                          +--> print human success output
                    +--> optional --open
```

## Function-level integration points

Use these seams when adding cross-cutting features.

- Entry split (interactive vs JSON): command action handler in `newCommand`.
- Type selection: `resolveTypePath`.
- Ownership policy:
  - Interactive: `resolveInteractiveOwnership`, then `resolveOwnership`.
  - JSON: `resolveJsonOwnership` (flag validation + JSON errors).
- Content building:
  - Interactive: `buildInteractiveNoteContent` -> `buildNoteContent`.
  - JSON: `buildJsonNoteContent` -> `parseJsonNoteInput` + `mergeJsonTemplateDefaults` + `validateJsonFrontmatter`.
- Write path and shared side effects: `writeNotePlan` (path resolution, `id`, owner field, file write, id registration, instance scaffolding).
- Template/body behavior:
  - Interactive template resolution: `resolveTemplateWithInheritance`.
  - JSON template lookup: `findTemplateByName`.
  - Body generation: `generateBodyForJson`, `promptBodySections`.

## Concrete flag examples

- Interactive pooled: `bwrb new task --standalone`
- Interactive owned (prompt flow): `bwrb new research`
- Interactive owned (explicit owner): `bwrb new research --owner "[[My Novel]]"`
- JSON pooled: `bwrb new task --json '{"name":"Fix bug","status":"in-progress"}'`
- JSON owned: `bwrb new research --json '{"name":"Lore notes"}' --owner "[[My Novel]]"`
- JSON + template + body: `bwrb new task --template bug-report --json '{"name":"Login bug","_body":{"Steps":["Repro"]}}'`

## Contract vs implementation boundary

Treat these as stable behavior contracts:

- Mode split and ownership semantics (interactive/JSON, owned/pooled).
- Validation guarantees (frontmatter/context/template constraints/cycle checks).
- System field policy (`id` reserved, generated at write time).
- JSON envelope behavior for machine-readable output.

Treat helper shapes/call ordering as refactorable internals if contracts remain true:

- Exact helper names or decomposition inside `build*` and ownership helpers.
- Internal arrangement of template/body helper calls.

## Drift checklist (when changing `new` flow)

Update this doc if you change:

- Flag semantics (`--json`, `--owner`, `--standalone`, `--template`, `--no-template`, `--no-instances`, `--open`).
- Ownership resolution behavior or owner-field writing.
- Validation behavior or JSON error envelope shape in `new` command.
- Filename resolution/sanitization or write-path logic.
- Template resolution precedence or instance scaffolding behavior.

## Test map

- Core `new` behavior: `tests/ts/commands/new.test.ts`
- Ownership-specific behavior: `tests/ts/commands/new-ownership.test.ts`
- Interactive prompt/TTY behavior: `tests/ts/commands/new.pty.test.ts`

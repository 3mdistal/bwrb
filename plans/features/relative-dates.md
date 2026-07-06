# Relative Dates (PR 1 of the story-time pair)

Owner: Alice (design agreed 2026-07-05). Vault brief: teenylilthoughts `briefs/bwrb relative dates and custom calendars.md`. PR 2 (custom calendars) is out of scope here — but see "Forward compatibility."

## What

A new field prompt type `relative-date`: a structured constraint (or list of constraints) positioning this note in time relative to another note's date-bearing field. Resolution is computed at query time — never written back to frontmatter.

## Frontmatter shape

```yaml
position:
  - kind: equal        # equal | after | before
    ref: "[[The Rending]]"
    field: start       # optional; names which date-ish field on the anchor (default: the anchor's own relative-date/date field per resolution rules below)
    offset: 34h        # optional; default 0. parseDuration units: min/h/d/w (d=24h, w=7d). No mon/y in v1.
```

- `kind: equal` — this note sits exactly `offset` after the anchor (negative positioning is expressed by putting the constraint on the other note or with `before`+`equal` semantics? No: allow `offset: -12h` too; signed offsets are cheaper than a fourth kind).
- `kind: after` / `before` — inequality bound: at least `offset` after/before the anchor. Bounds do not produce a position by themselves; they validate and can clamp an unknown.
- Single-constraint scalar convenience: a bare object (not in a list) must also parse.
- `ref` is a real relation value: wiki-link, participates in link extraction, rename handling, and relation validation like any other relation field.

## Resolution semantics (query time)

- A note's **resolved position** is: its own absolute `date`-type anchor field if the schema declares one alongside, else the transitive resolution of its `equal` constraint chain until a note with an absolute date (or a dead end) is reached.
- Chains: memoize per index build. Cycle → both notes get `resolved: null` with a reported diagnostic (audit warning + a `resolution: "cycle"` marker in JSON), never a crash.
- Multiple `equal` constraints that disagree → contradiction diagnostic; resolve to the first, flag the rest.
- `after`/`before` bounds: checked when both sides resolve; violations are audit warnings. When a note has only bounds (no equal, no absolute), `resolved` is null but `bounds` are exposed in JSON.
- Anchors without any date anywhere in the chain: `resolved: null`, `resolution: "unanchored"` — this is normal, not an error.

## Query surface

- `bwrb list --output json`: relative-date fields emit `{ source: <raw constraints>, resolved: <ISO or null>, resolution: "ok"|"cycle"|"unanchored"|"contradiction" }`.
- `--sort` must accept the relative-date field name and order by resolved value (nulls last).
- `--where` comparisons against the field compare the resolved value.
- `bwrb audit` reports cycles, contradictions, and bound violations on affected notes.

## Offset representation (forward compatibility with PR 2)

Parse offsets into `{ amount, unit, mode }` structures and resolve to a linear timestamp **at the last moment**. Do not collapse to milliseconds inside the AST. PR 2 (custom calendars) will introduce calendar-scoped units and a non-Gregorian linear timestamp; keeping the AST unit-symbolic means that lands as a resolver swap, not a parser rewrite.

## Schema surface

- `prompt: "relative-date"` in field definitions (zod schema in src/types/schema.ts, docs strings included), `source:` like relation fields to constrain anchor types, `multiple` semantics come free from the list shape.
- `bwrb schema list <type>` renders the new prompt kind sensibly.
- `bwrb new`/`edit` interactive + `--json` paths accept the object/list shape with validation errors that state exactly which key is wrong.

## Non-goals (v1)

- No custom calendars, no calendar units (mon/y excluded on purpose).
- No writing resolved values into notes, ever.
- No cross-vault refs.

## Acceptance (will be tested by a fresh agent driving only the CLI)

1. Define a `relative-date` field on a type via `bwrb schema` commands (or direct schema.json edit + migrate).
2. Create three notes: A with absolute date, B `equal` A `+34h`, C `equal` B `-2h`; `bwrb list --sort <field>` orders A, C, B with correct resolved values in JSON.
3. Add D `after` A `+1w` with no equal — JSON shows null resolved + bounds; no crash anywhere.
4. Point B at C to create a cycle — `bwrb audit` and `list` both surface it comprehensibly; exit codes stay sane.
5. Full CI parity passes: `pnpm build && pnpm verify:pack && pnpm typecheck && pnpm lint && pnpm knip && pnpm test -- --exclude='**/*.pty.test.ts'`.
6. Docs: canonical behavior page in `docs-site/src/content/docs/` + `docs/skill/SKILL.md` updated per repo policy.

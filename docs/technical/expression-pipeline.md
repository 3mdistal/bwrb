# Expression Pipeline and Validation Responsibilities

> Developer reference for `--where` expressions and shared expression evaluation.

---

## Purpose

This document explains how expression input moves through the system, which module owns each validation step, and where user-facing behavior is decided.

Scope:
- `--where` expression handling for targeting/filtering.
- Shared expression engine usage in template constraints (`constraint.validate`).

Non-goals:
- This is not an end-user expression tutorial.
- This does not change runtime behavior.

---

## Canonical Product Contracts

The implementation here must stay aligned with these product docs:

- `docs/product/cli-targeting.md`
  - With `--type`: strict `--where` field validation.
  - Without `--type`: permissive behavior that supports migration workflows.
- `docs/product/cli-output-contract.md`
  - JSON mode writes exactly one JSON value to stdout.
  - Human diagnostics belong on stderr.

This page documents current behavior using those contracts as guardrails.

---

## Entrypoints

### 1) CLI `--where`

Primary call path:

1. `resolveTargets()` in `src/lib/targeting.ts`
2. optional early static validation via `validateWhereExpressions()` in `src/lib/expression-validation.ts` (only when `--type` is present)
3. runtime filtering via `applyFrontmatterFilters()` in `src/lib/query.ts`
4. expression parse/eval via `matchesExpression()` in `src/lib/expression.ts`

### 2) Template constraints (`constraint.validate`)

Call path:

1. `validateConstraints()` in `src/lib/template.ts`
2. `matchesExpression()` in `src/lib/expression.ts` with `this` bound to field value

This reuses the same parser/evaluator, but not targeting policy.

---

## Pipeline Stages (`--where`)

1. Input collection
   - Commands collect repeated `--where` flags as an array.

2. Normalization for hyphenated fields
   - `normalizeWhereExpression()` in `src/lib/where-normalize.ts` rewrites unquoted hyphenated field identifiers to `__frontmatter['field-name']`.
   - Marker constant lives in `src/lib/where-constants.ts`.

3. Parse to AST
   - `parseExpression()` in `src/lib/expression.ts` parses with `jsep`.
   - Parse failures throw `Error('Expression parse error: ...')`.

4. Optional static/type-aware validation
   - `validateWhereExpressions()` in `src/lib/expression-validation.ts` runs only when type context exists (`--type`).
   - It performs AST comparison extraction to validate field names and select-option literals.

5. Runtime context construction
   - `buildEvalContext()` in `src/lib/expression.ts` builds `frontmatter` + `file.*` values.
   - `query.ts` computes hierarchy maps once per filter pass when expressions use hierarchy functions.

6. Runtime evaluation
   - `matchesExpression()` parses + evaluates and coerces to boolean.
   - Built-ins and operators are implemented in `src/lib/expression.ts`.

7. Command-level rendering
   - Command handlers and output helpers decide how errors/warnings are surfaced in text vs JSON modes, using `src/lib/output.ts` contracts.

---

## Single Source of Truth

- Parsing + evaluation semantics
  - `src/lib/expression.ts`
- Expression-string normalization
  - `src/lib/where-normalize.ts`
- Static/type-aware validation findings
  - `src/lib/expression-validation.ts`
- Runtime filter application and hierarchy precompute
  - `src/lib/query.ts`
- Strict/permissive policy selection and command-facing error flow
  - `src/lib/targeting.ts` and command boundaries
- JSON envelope and exit-code contract
  - `src/lib/output.ts`

Rule: keep policy decisions at command/targeting boundaries. Keep lower-level helpers pure where possible (return findings or throw), without direct UX policy decisions.

---

## Responsibility Matrix

| Layer | Owns | Does Not Own |
|-------|------|--------------|
| `src/lib/expression.ts` | Parse/eval semantics, built-ins, operator behavior, context property lookup | CLI mode policy, warning formatting, command exits |
| `src/lib/where-normalize.ts` | String rewrite for hyphenated keys in expressions | Schema/type validation, output rendering |
| `src/lib/expression-validation.ts` | Static analysis for known type context; unknown-field/select-option findings | Runtime file filtering, printing, process exit |
| `src/lib/query.ts` | Apply expressions to file sets; hierarchy precomputation for hierarchy functions | Strict/permissive policy decisions; JSON envelope rendering |
| `src/lib/targeting.ts` + commands | Select strict/permissive path; route failures to text/JSON output flows | Low-level parse/eval semantics |
| `src/lib/output.ts` | JSON envelope helpers and exit-code constants | Expression semantics |

---

## Validation Scope and Modes

- With `--type`
  - Early type-aware validation runs in `expression-validation.ts`.
  - Unknown fields in comparisons are treated as hard errors.
  - Invalid select-option literals are treated as hard errors.

- Without `--type`
  - No type-aware field/option validation is possible up front.
  - Runtime evaluation in `query.ts` filters using available frontmatter context.
  - Command behavior stays permissive to support migration workflows described in product docs.

This mirrors current product policy; do not tighten permissive mode in docs-only changes.

---

## Error Classes and Surface Patterns (Current Behavior)

This table documents current behavior patterns by source layer.

| Error class | Origin | Text-mode surface (current pattern) | JSON-mode surface (current pattern) |
|-------------|--------|-------------------------------------|-------------------------------------|
| Parse failure | `parseExpression()` in `expression.ts` | Usually surfaced as `Expression error in "<expr>": Expression parse error: <details>` when not silenced by caller | Must be represented as `JsonError` envelope by command boundary; no non-JSON stdout |
| Unknown function/operator | Evaluator in `expression.ts` | Surfaced as expression evaluation error with details (`Unknown function`, `Unknown operator`) | Wrapped by command boundary into `JsonError` output contract |
| Unknown field with known type | `validateWhereExpressions()` in `expression-validation.ts` | Formatted by `formatWhereValidationErrors()` and returned via targeting/command flows | Emitted as `JsonError` from command flow with non-zero exit |
| Invalid select option with known type | `validateWhereExpressions()` in `expression-validation.ts` | Formatted validation error with valid options/suggestion when available | Emitted as `JsonError` from command flow with non-zero exit |

Authoring convention for new human-facing expression errors: prefer `Expression <class>: <details>`, but do not rewrite existing messages in this issue.

---

## Shared Engine Invariants (`--where` vs `constraint.validate`)

Shared:
- Both use `parseExpression()` and `matchesExpression()` from `src/lib/expression.ts`.
- Both rely on the same expression language semantics and built-in function set.

Intentionally different:
- `--where` path performs file-set filtering and command-level output handling.
- `constraint.validate` evaluates per-field constraints with `this` bound to field value in `src/lib/template.ts`.
- `constraint.validate` errors are template-validation concerns, not targeting concerns.

---

## Concrete Command Flow Examples

### Example A: Strict typed filtering

```bash
bwrb list --type task --where "status == 'in-progress'"
```

- `targeting.ts` runs early type-aware checks.
- If `status` is unknown for `task`, command fails before discovery/filtering.

### Example B: Permissive untyped filtering (migration-friendly)

```bash
bwrb list --where "legacy-status == 'active'"
```

- No type-aware pre-validation runs.
- Filtering evaluates against each note's frontmatter context.

### Example C: Hyphenated key normalization

```bash
bwrb list --where "creation-date == '2026-01-28'"
```

- `where-normalize.ts` rewrites field lookup so expression parsing/evaluation remains valid.

---

## No-Behavior-Drift Checklist

When touching expression behavior or docs that claim behavior:

1. Confirm product contracts still hold (`cli-targeting`, `cli-output-contract`).
2. Keep strict/permissive split unchanged unless issue explicitly changes policy.
3. Preserve JSON contract: single stdout JSON value, diagnostics on stderr.
4. Update/add tests that cover the changed contract statement.

Related tests:
- `tests/ts/lib/expression.test.ts`
- `tests/ts/lib/where-normalize.test.ts`
- `tests/ts/lib/expression-validation.test.ts`
- `tests/ts/lib/targeting.test.ts`

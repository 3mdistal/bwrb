# Audit Fix Policy

This document defines product policy for `bwrb audit --fix` behaviors. The goal is predictability: automated fixes should be safe and conservative, and interactive fixes should be explicit about what will change.

## Required Field Emptiness

Required fields are considered empty when the value is:

- `null` or `undefined`
- an empty string (`""`) or whitespace-only string
- an empty array (`[]`)

If the field is present but empty, report `empty-string-required`.
If the field is absent entirely, report `missing-required`.

## Optional Field Emptiness

An **optional** scalar field set to the literal empty string (`""`), `null`, or absent entirely is treated as "unset" — never an error. Audit and the write path agree here: `validateFrontmatter` computes emptiness with `value !== ''` (an exact check, **not** trimmed), so it accepts `''`, and audit must not flag what writing would have accepted.

In particular, an empty optional `number` (e.g. `count: ""`) is *not* reported as `wrong-scalar-type`; it is simply unset (#664, mirroring #614).

A **whitespace-only** value (e.g. `count: "   "`) is *not* unset. Because the check is exact rather than trimmed, audit skips only the literal empty string, so a whitespace-only optional `number` or `boolean` is flagged `wrong-scalar-type` — consistent with the write path, which rejects it. This write/audit parity is intentional. A genuinely non-numeric value (e.g. `count: "abc"`) is likewise flagged.

## Auto-Coercion Policy (Unambiguous Only)

`audit --fix --auto` may coerce scalars only when the conversion is unambiguous:

- **String → Boolean**: only `true` or `false` (case-insensitive, trimmed)
- **String → Number**: only strict numeric literals (no partial parsing)
- **Number/Boolean → String**: always safe
- **Scalar → List**: wrap scalar when schema has `multiple: true`
- **List → Scalar**: only when list length is `1` and value can be safely coerced

Disallowed examples for auto-coercion:

- Boolean: `yes`, `no`, `1`, `0`
- Number: `12abc`, `1_000`, or any non-literal representation

If coercion is not unambiguous, `audit --fix` prompts the user interactively for a valid value.

## Invalid Date Handling

- Date validation is driven by the field `prompt: "date"`.
- Invalid dates prompt the user for `YYYY-MM-DD`.
- A `Suggested: YYYY-MM-DD` hint is shown only when the input can be normalized unambiguously.
- Ambiguous inputs (e.g., `01/02/2026`) never receive a suggestion.

## Invalid List Elements

For list fields, `invalid-list-element` may auto-fix only when deterministic:

- Remove `null` / empty-string elements if the list remains valid
- Flatten a single nested list only when exactly one level deep and all elements are valid
- Coerce a wrong-typed scalar element (a bare `number` or `boolean`, e.g. `42` or `true`) to its string form in place, leaving the rest of the array intact. The coerced element is written as a **quoted** YAML string (`- "42"`, not bare `- 42`) and re-read as a string, so it survives the YAML round-trip and a re-audit finds nothing to fix — the coerce converges in one pass (idempotent, the #700 trap). The fix re-derives the element from the live array and only acts while it is still a number/boolean, so a re-applied or stale issue is a safe no-op.

A **valid numeric element of a `multiple` date field** (e.g. an unquoted `2026` at year granularity) is reported as `wrong-scalar-type` with a `listIndex` and is auto-fixable per-element (#673): the fix quotes that single element in place (`2026` → `"2026"`), preserving array order and all other elements — it never collapses the array to one scalar. Quoting is index-safe (each element is re-derived from the live array, like the #683 blank removal) and idempotent: the quoted string is written and re-read as a string, so the value survives the YAML round-trip and a second pass finds nothing (avoiding the #700 non-idempotency trap). An **invalid** numeric date element (not a valid date at the field's granularity) is left as `invalid-date-format` for manual correction and is never auto-quoted.

## Trailing Whitespace (Raw Frontmatter, Minimal Diff)

`trailing-whitespace` policy is intentionally narrow and deterministic:

- Applies to YAML frontmatter single-line key/value entries only.
- Quoted values: only whitespace after the closing quote is in scope.
- Block scalars (`|` or `>`) are excluded; content lines are ignored.
- Fix behavior is minimal-diff line trim only (no YAML reserialization).
- In auto-fix mode, writing requires `audit --fix --auto --execute`.

User-facing command behavior and examples are documented in `docs-site/src/content/docs/reference/commands/audit.md`.

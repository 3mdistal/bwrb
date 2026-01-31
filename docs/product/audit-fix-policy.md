# Audit Fix Policy

This document defines product policy for `bwrb audit --fix` behaviors. The goal is predictability: automated fixes should be safe and conservative, and interactive fixes should be explicit about what will change.

## Required Field Emptiness

Required fields are considered empty when the value is:

- `null` or `undefined`
- an empty string (`""`) or whitespace-only string
- an empty array (`[]`)

If the field is present but empty, report `empty-string-required`.
If the field is absent entirely, report `missing-required`.

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
- Apply safe scalar coercions per `wrong-scalar-type` when unambiguous

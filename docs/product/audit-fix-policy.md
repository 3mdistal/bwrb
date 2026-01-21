# Audit Fix Policy

This document defines product policy for `bwrb audit --fix` behaviors. The goal is predictability: automated fixes should be safe and conservative, and interactive fixes should be explicit about what will change.

## Required Field Emptiness

Required fields are considered missing when the value is:

- `null` or `undefined`
- an empty string (`""`) or whitespace-only string
- an empty array (`[]`)

These are reported as `missing-required`. There is no separate issue code for empty-required values.

## Auto-Coercion Policy (Unambiguous Only)

`audit --fix --auto` may coerce string scalars only when the conversion is unambiguous:

- **Boolean**: only `true` or `false` (case-insensitive, trimmed)
- **Number**: only strict numeric literals (no partial parsing)

Disallowed examples for auto-coercion:

- Boolean: `yes`, `no`, `1`, `0`
- Number: `12abc`, `1_000`, or any non-literal representation

If coercion is not unambiguous, `audit --fix` prompts the user interactively for a valid value.

## Invalid Date Handling

- Date validation is driven by the field `prompt: "date"`.
- Invalid dates prompt the user for `YYYY-MM-DD`.
- A `Suggested: YYYY-MM-DD` hint is shown only when the input can be normalized unambiguously.
- Ambiguous inputs (e.g., `01/02/2026`) never receive a suggestion.

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

## Explicit Delete Remediation (Interactive Only)

`bwrb audit --fix` may offer a per-note **delete note** option for risky/out-of-scope files.

Safety rules:

- Delete is never automatic. `--fix --auto` MUST NOT delete notes.
- Delete is never implicit. Users must explicitly choose delete for a specific note.
- Delete prompts MUST show why delete is being offered (the triggering issue context).
- Delete prompts SHOULD show backlink warnings before confirmation.
- Delete requires strong confirmation (explicit confirmation + typed confirmation).

Mode rules:

- `--dry-run` never deletes; it reports `would delete` only.
- `--output json` remains non-interactive for audit. In JSON audit output, commands may emit structured `delete-recommended` guidance only (no prompt, no delete).

Semantics:

- Delete from `audit --fix` uses the same semantics as `bwrb delete` (permanent filesystem deletion).
- This is intentionally explicit and high-friction to avoid surprising destructive behavior.

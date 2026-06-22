---
title: Validation and Audit
description: Keeping notes in sync with your schema
---

Bowerbird validates notes against your schema and helps fix violations.

## Hard vs Soft Enforcement

- **Hard enforcement** — `bwrb new` and `bwrb edit` refuse to create invalid notes
- **Soft enforcement** — Manual edits can break the schema; `bwrb audit` catches drift

## Running Audit

Check your entire vault:

```bash
bwrb audit
```

Check specific types:

```bash
bwrb audit --type task
```

## Common Issues

Audit catches:

- Missing required fields
- Invalid field values (not in enum options)
- Type mismatches
- Malformed frontmatter

System-managed fields written by bwrb (`id`, `name`) are always allowed and never reported as `unknown-field`.

## Fixing Issues

`bwrb audit --fix` applies fixes by default, but requires explicit targeting (use `--all` to target the full vault).

Preview fixes without writing:

```bash
bwrb audit --path "Ideas/**" --fix --dry-run
```

Apply fixes:

```bash
bwrb audit --path "Ideas/**" --fix
```

Apply fixes across the entire vault:

```bash
bwrb audit --all --fix
```

## Hygiene Warnings

Audit also reports low-risk hygiene warnings to keep frontmatter deterministic and reduce noisy diffs.

- Example: `trailing-whitespace` checks raw frontmatter `key: value` lines for trailing spaces/tabs.
- Scope is intentionally narrow: block scalar content (`|`/`>`) is ignored, and whitespace inside quoted values is allowed.
- Fix behavior is minimal-diff line trim only; it does not reserialize YAML.

Automation note:

```bash
# Preview auto-fixes
bwrb audit --fix --auto --all

# Apply execute-gated auto-fixes (including trailing-whitespace)
bwrb audit --fix --auto --execute --all
```

See the [bwrb audit command reference](/reference/commands/audit/) for exact issue semantics and fix gating details.

## CI Integration

Run audit in CI to catch schema violations:

```bash
bwrb audit --output json
# Exit code 1 if violations found
```

## Describe vs. enforce: `discover` vs. `audit`

`audit` is **prescriptive** — it reports what is *wrong* relative to the schema,
exits non-zero when it finds violations, and can `--fix` them.

[`bwrb schema discover`](/reference/commands/schema/#discover) is the
**descriptive** counterpart. It reports frontmatter *facts* over a folder — every
field, its frequency, the value-types it holds, which files diverge, and (when a
schema exists) drift such as used-but-undefined fields, defined-but-unused fields,
and values diverging from declared options. It never passes or fails and is safe
to run anytime.

Two ways to reach for it:

- **Before a schema exists** — point `discover` at a messy folder to gather raw
  material for designing types.
- **After a schema exists** — use it to *see* drift descriptively, then use
  `audit` to *enforce* the schema.

```bash
# Describe what's in a folder (no judgment)
bwrb schema discover ./notes

# Enforce the schema (pass/fail, fixable)
bwrb audit
```

## Next Steps

- [Migrations](/concepts/migrations/) — Evolving your schema over time
- [Bulk operations](/reference/commands/bulk/) — Batch fixes

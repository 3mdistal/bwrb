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

## CI Integration

Run audit in CI to catch schema violations:

```bash
bwrb audit --output json
# Exit code 1 if violations found
```

## Next Steps

- [Migrations](/concepts/migrations/) — Evolving your schema over time
- [Bulk operations](/reference/commands/bulk/) — Batch fixes

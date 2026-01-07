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

## Fixing Issues

Preview fixes:

```bash
bwrb audit --fix
```

Apply fixes:

```bash
bwrb audit --fix --execute
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

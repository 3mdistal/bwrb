---
title: Schema
description: Understanding the schema as the source of truth
---

The schema is the heart of Bowerbird. It defines what types of notes exist, what fields they have, and how they're validated.

## Schema Location

Each vault has a schema at `.bwrb/schema.json`.

```
my-vault/
└── .bwrb/
    └── schema.json
```

## Schema Structure

A schema defines:

- **Types** — Categories of notes (e.g., `task`, `idea`, `person`)
- **Fields** — Properties each type has (e.g., `status`, `priority`, `deadline`)
- **Enums** — Reusable option sets (e.g., status values)
- **Config** — Vault-wide settings

```json
{
  "types": { ... },
  "enums": { ... },
  "config": { ... }
}
```

## Schema is King

The schema is the source of truth. Notes must conform.

- **Hard enforcement on CLI** — `bwrb new` refuses to create invalid notes
- **Soft enforcement on edits** — Files can drift, but `bwrb audit` catches it
- **TypeScript analogy** — Like `tsc`, Bowerbird can fail builds on schema violations

## Next Steps

- [Types and Inheritance](/concepts/types-and-inheritance/) — How types relate to each other
- [Validation and Audit](/concepts/validation-and-audit/) — Keeping notes in sync with schema

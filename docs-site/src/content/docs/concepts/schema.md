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
- **Config** — Vault-wide settings (link format, default editor, etc.)
- **Audit** — Configuration for schema validation

```json
{
  "types": { ... },
  "config": { ... },
  "audit": { ... }
}
```

See the [Schema Reference](/reference/schema/) for complete property documentation.

## Schema is King

The schema is the source of truth. Notes must conform.

- **Hard enforcement on CLI** — `bwrb new` refuses to create invalid notes
- **Soft enforcement on edits** — Files can drift, but `bwrb audit` catches it
- **TypeScript analogy** — Like `tsc`, Bowerbird can fail builds on schema violations

## Next Steps

- [Schema Reference](/reference/schema/) — Complete property reference
- [Types and Inheritance](/concepts/types-and-inheritance/) — How types relate to each other
- [Validation and Audit](/concepts/validation-and-audit/) — Keeping notes in sync with schema

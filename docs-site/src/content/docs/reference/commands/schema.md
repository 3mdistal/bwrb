---
title: bwrb schema
description: Inspect and manage schema
---

Manage your vault's schema definition.

## Usage

```bash
bwrb schema <subcommand>
```

## Subcommands

### list

View schema contents:

```bash
bwrb schema list              # Overview
bwrb schema list types        # All types
bwrb schema list type task    # Specific type
bwrb schema list enums        # All enums
bwrb schema list fields       # All fields
```

### new

Create schema elements:

```bash
bwrb schema new type
bwrb schema new field
bwrb schema new enum
```

### edit

Modify schema elements:

```bash
bwrb schema edit type task
bwrb schema edit field status
bwrb schema edit enum priority
```

### delete

Remove schema elements:

```bash
bwrb schema delete type idea
bwrb schema delete field old-field --execute
```

### migrate

Apply schema changes to notes:

```bash
bwrb schema migrate           # Preview
bwrb schema migrate --execute # Apply
```

## See Also

- [Schema concepts](/concepts/schema/)
- [Migrations](/concepts/migrations/)

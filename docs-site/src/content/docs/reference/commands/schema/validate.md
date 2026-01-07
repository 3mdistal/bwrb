---
title: schema validate
description: Validate schema structure
---

Validate your schema.json file for structural correctness.

## Synopsis

```bash
bwrb schema validate [options]
```

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Description

Validates the schema.json file against the expected structure:

- Required fields are present
- Field types are valid
- Enum values are properly defined
- Type hierarchies are consistent
- Output directories are specified

## Examples

```bash
# Validate schema
bwrb schema validate

# JSON output for CI
bwrb schema validate --output json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Schema is valid |
| `1` | Validation errors found |

## See Also

- [bwrb schema](/reference/commands/schema/) — Schema command overview
- [bwrb audit](/reference/commands/audit/) — Validate notes against schema

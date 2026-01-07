---
title: template validate
description: Validate templates against schema
---

Validate templates to ensure they're compatible with the current schema.

## Synopsis

```bash
bwrb template validate [options] [type]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `type` | Validate templates for specific type only |

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Description

Checks templates for:

- Valid `template-for` type reference
- Default field values match schema types
- Default enum values are valid
- Prompt-fields reference existing fields
- No references to removed schema fields

## Examples

```bash
# Validate all templates
bwrb template validate

# Validate templates for specific type
bwrb template validate task
bwrb template validate objective/milestone

# JSON output for CI
bwrb template validate --output json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All templates valid |
| `1` | Validation errors found |

## See Also

- [bwrb template](/reference/commands/template/) — Template command overview
- [bwrb schema validate](/reference/commands/schema/validate/) — Validate schema

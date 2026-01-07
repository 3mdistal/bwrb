---
title: bwrb audit
description: Validate notes against schema
---

Check your vault for schema violations.

## Usage

```bash
bwrb audit [options]
```

## Examples

```bash
# Audit entire vault
bwrb audit

# Audit specific type
bwrb audit --type task

# Show and apply fixes
bwrb audit --fix
bwrb audit --fix --execute

# JSON output for CI
bwrb audit --output json
```

## Options

| Option | Description |
|--------|-------------|
| `--type <type>` | Audit specific type only |
| `--path <dir>` | Audit specific directory |
| `--fix` | Show available fixes |
| `-x, --execute` | Apply fixes |
| `--output json` | JSON output |

## Exit Codes

- `0` — No violations
- `1` — Violations found

## CI Integration

```bash
# Fail build on schema violations
bwrb audit --output json || exit 1
```

## See Also

- [Validation and Audit](/concepts/validation-and-audit/)
- [bwrb bulk](/reference/commands/bulk/)

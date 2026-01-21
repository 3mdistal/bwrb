---
title: bwrb audit
description: Validate notes against schema
---

Validate vault files against schema and report issues, with optional interactive repair.

## Synopsis

```bash
bwrb audit [options] [target]
```

The target argument is auto-detected as type, path (contains `/`), or where expression.

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type path |
| `-p, --path <glob>` | Filter by file path pattern |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <query>` | Filter by body content |

### Issue Filtering

| Option | Description |
|--------|-------------|
| `--only <issue-type>` | Only report specific issue type |
| `--ignore <issue-type>` | Ignore specific issue type |
| `--strict` | Treat unknown fields as errors instead of warnings |
| `--allow-field <fields>` | Allow additional fields beyond schema (repeatable) |

### Repair

| Option | Description |
|--------|-------------|
| `--fix` | Interactive repair mode |
| `--auto` | With `--fix`: automatically apply unambiguous fixes |

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `json` |

## Issue Types

| Type | Description |
|------|-------------|
| `orphan-file` | File in managed directory but no `type` field |
| `invalid-type` | Type field value not recognized in schema |
| `missing-required` | Required field is missing |
| `invalid-enum` | Field value not in allowed enum values |
| `unknown-field` | Field not defined in schema (warning by default) |
| `wrong-directory` | File location doesn't match its type's output_dir |
| `format-violation` | Field value doesn't match expected format (wikilink, etc.) |
| `stale-reference` | Wikilink points to non-existent file |

## Examples

### Basic Auditing

```bash
# Check all files (report only)
bwrb audit

# Check only tasks
bwrb audit --type objective/task

# Check specific directory
bwrb audit --path "Ideas/**"

# Check files with specific status
bwrb audit --where "status=active"

# Check files containing TODO
bwrb audit --body "TODO"
```

### Issue Filtering

```bash
# Only missing required fields
bwrb audit --only missing-required

# Ignore unknown fields
bwrb audit --ignore unknown-field

# Strict mode: unknown fields are errors
bwrb audit --strict

# Allow specific extra fields
bwrb audit --allow-field custom --allow-field legacy
```

### Repair Mode

```bash
# Interactive fix mode (requires explicit targeting)
bwrb audit --path "Ideas/**" --fix

# Preview fixes without writing
bwrb audit --path "Ideas/**" --fix --dry-run

# Auto-apply unambiguous fixes (requires --execute)
bwrb audit --path "Ideas/**" --fix --auto --execute

# Preview auto-fixes
bwrb audit --path "Ideas/**" --fix --auto
```

`bwrb audit --fix` refuses to run without a TTY when interactive fixes are needed (use `--fix --auto --execute` for non-interactive automation; use `--dry-run` to preview fixes).

### Non-interactive mode

```bash
# Safe automation (no prompts)
bwrb audit --fix --auto --execute --all
# Report-only JSON for CI/daemons
bwrb audit --output json
```

### Phase 5: Type coercion fixes

```bash
# Auto-coerce unambiguous string scalars
bwrb audit --only wrong-scalar-type --fix --auto --execute --all

# Fix invalid date formats interactively
bwrb audit --only invalid-date-format --fix --all
```

Empty required values ("", whitespace-only strings, or empty lists) are treated like missing required fields during fixes.


### CI Integration

```bash
# JSON output for CI
bwrb audit --output json

# Fail build on schema violations
bwrb audit --output json || exit 1
```

## Type Resolution

Audit resolves each file's type from its frontmatter `type` field:

- If `type` is missing: reports `orphan-file` and skips type-dependent checks
- If `type` is invalid: reports `invalid-type` and skips type-dependent checks
- Type-dependent checks (`missing-required`, `invalid-option`, `wrong-directory`) require valid type resolution

Use `--type` to filter by type; it does not fix missing type fields.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | No violations found, or `--fix --auto` completed (remaining issues are reported) |
| `1` | Violations found in report-only mode, or `--fix` (interactive) left remaining issues |

## See Also

- [Validation and Audit](/concepts/validation-and-audit/) — Audit concepts
- [bwrb bulk](/reference/commands/bulk/) — Batch fix operations
- [Targeting Model](/reference/targeting/) — Selector reference

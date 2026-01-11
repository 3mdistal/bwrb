---
title: CLI Safety and Flags
description: How --execute, --dry-run, and --force protect your vault from accidents
---

Bowerbird is designed to be safe by default, especially for destructive operations.

Three flags show up frequently in that safety model:

| Flag | Meaning | Typical usage |
|------|---------|---------------|
| `--dry-run` | **Preview** without writing changes | Commands that apply changes by default (e.g. `audit --fix`) |
| `-x, --execute` | **Apply changes** instead of preview/dry-run | Bulk/destructive operations that default to showing what would happen |
| `-f, --force` | **Skip an interactive confirmation** (or allow overwrite) | Commands that prompt before proceeding (or need an explicit overwrite escape hatch) |

The key idea is that these flags are **not interchangeable**:

- `--execute` is an *execution gate* (dry-run -> apply)
- `--dry-run` is a *preview mode* (apply -> preview)
- `--force` is a *prompt gate* (confirm -> skip)

## The Two-Gate Safety Model

Most destructive commands use two explicit gates:

1. **Targeting gate**: you must explicitly select files using selectors (`--type`, `--path`, `--where`, `--body`) or explicitly acknowledge vault-wide scope with `--all`.
2. **Execution gate**: even after targeting is specified, the command defaults to a **dry-run** until you pass `--execute`.

This prevents accidental vault-wide mutations.

### Example: `bulk`

```bash
# Dry-run (shows what would change)
bwrb bulk --type task --set status=done

# Apply changes
bwrb bulk --type task --set status=done --execute
```

### Example: bulk `delete`

```bash
# Dry-run (preview deletions)
bwrb delete --type task

# Actually delete
bwrb delete --type task --execute
```

### Exception: `audit --fix`

`bwrb audit --fix` is a remediation workflow. It still requires explicit targeting, but it **writes by default**.

```bash
# Apply guided fixes
bwrb audit --path "Ideas/**" --fix

# Preview fixes without writing
bwrb audit --path "Ideas/**" --fix --dry-run
```

## Confirmation Prompts and `--force`

Some commands prompt for confirmation because the operation is immediate and hard to undo. In those cases, `--force` is the opt-out.

### Example: single-file `delete`

```bash
# Prompts for confirmation
bwrb delete "My Note"

# Skip confirmation (useful for scripts)
bwrb delete "My Note" --force
```

## `--force` for overwrites

In addition to skipping confirmation prompts, `--force` can be used to explicitly allow overwriting an existing saved artifact.

### Example: overwriting a saved dashboard

```bash
# Save a query as a dashboard
bwrb list --type task --output tree --save-as "task-tree"

# Overwrite an existing dashboard of the same name
bwrb list --type task --output tree --save-as "task-tree" --force
```

## Mental Model

- Use `--execute` when the command supports **preview/dry-run by default** and you want to actually apply the changes.
- Use `--dry-run` when the command applies changes by default and you want a preview.
- Use `--force` when the command supports an **interactive confirmation** (or overwrite protection) and you want to skip it.

If you’re scripting, pair these with `--output json` and (when supported) `--picker none` to avoid interactive UI.

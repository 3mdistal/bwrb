# CLI Targeting Model

> How Pika commands select which notes to operate on.

---

## Overview

Pika uses a unified targeting model across all commands that operate on sets of notes. This provides a consistent, learnable interface: once you understand the four selectors, you can use any command.

**Core principle:** All targeting selectors compose via AND (intersection). Each selector narrows the set of matched files.

---

## The Four Selectors

### 1. Type (`--type <type>`)

Filter by schema type.

```bash
pika list --type task
pika bulk --type reflection --set reviewed=true
pika audit --type objective
```

**Behavior:**
- Accepts short names (`task`) or full paths (`objective/task`)
- Short names are unambiguous since types cannot share names
- When specified, enables strict validation of `--where` fields

**Positional shortcut:** Type can be provided as a positional argument:
```bash
pika list task              # Same as: pika list --type task
pika bulk task --set x=y    # Same as: pika bulk --type task --set x=y
```

### 2. Path (`--path <glob>`)

Filter by file location in the vault.

```bash
pika list --path "Ideas/"
pika bulk --path "Reflections/Daily Notes" --set status=reviewed
pika audit --path "Work/**"
```

**Behavior:**
- Accepts directory paths or glob patterns
- Paths are relative to vault root
- Supports glob syntax (`*`, `**`, `?`)

### 3. Query (`--where <expression>`)

Filter by frontmatter field values.

```bash
pika list --where "status == 'active'"
pika bulk --where "priority < 3 && !isEmpty(deadline)" --set urgent=true
pika audit --where "isEmpty(tags)"
```

**Behavior:**
- Supports comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`
- Supports boolean operators: `&&`, `||`, `!`
- Supports functions: `isEmpty()`, `contains()`, `startsWith()`, etc.
- Multiple `--where` flags are ANDed together

**Type-checking behavior:**
- With `--type`: strict validation (error on unknown fields)
- Without `--type`: permissive with warnings (supports migration workflows)

### 4. Text (`--text <query>`)

Filter by body content (full-text search via ripgrep).

```bash
pika list --text "TODO"
pika bulk --text "DEPRECATED" --delete deprecated_field
pika search --text "meeting notes" --type task
```

**Behavior:**
- Searches note body content (not frontmatter)
- Uses ripgrep under the hood for performance
- Case-insensitive by default

---

## Selector Composition

**All selectors compose via AND (intersection).** Each additional selector narrows the result set.

```bash
# Find tasks in Work/ folder with status=active containing "deadline"
pika list --type task --path "Work/" --where "status == 'active'" --text "deadline"
```

**Union (OR) is not implicit.** To express OR logic, use boolean operators within `--where`:
```bash
pika list --where "status == 'draft' || status == 'review'"
```

---

## Smart Positional Detection

For ergonomics, the first positional argument is auto-detected:

| Input | Detection | Equivalent |
|-------|-----------|------------|
| `pika list task` | Matches known type | `--type task` |
| `pika list "Ideas/"` | Contains `/`, matches path | `--path "Ideas/"` |
| `pika list "status == 'x'"` | Contains operators | `--where "status == 'x'"` |

**Ambiguity handling:** When detection is ambiguous, Pika errors with a helpful message:
```
Error: "idea" is ambiguous. Did you mean:
  --type idea    (schema type)
  --path Ideas/  (directory)

Use the explicit flag to clarify.
```

**Autocomplete:** Shell completion suggests valid types, paths, and field names as you type, making the detected interpretation visible.

---

## Command Support Matrix

All commands that operate on note sets support the same selectors:

| Command | `--type` | `--path` | `--where` | `--text` |
|---------|----------|----------|-----------|----------|
| list    | Y | Y | Y | Y |
| bulk    | Y | Y | Y | Y |
| audit   | Y | Y | Y | Y |
| search  | Y | Y | Y | Y (primary) |
| open    | Y | Y | Y | Y |
| delete  | Y | Y | Y | Y |

**Note:** `open` is an alias for `search --open`.

---

## Default Behavior

Default behavior depends on command destructiveness:

### Read-only commands (`list`, `audit` without `--fix`, `search`)

No selectors = implicit `--all` (operate on entire vault).

```bash
pika list           # Lists all notes
pika audit          # Audits all notes
```

### Interactive commands (`open`)

No selectors = prompt with picker.

### Destructive commands (`bulk`, `delete`, `audit --fix`)

**Two safety gates:**

1. **Targeting required:** No selectors = error. Must specify at least one selector OR explicit `--all`.
2. **Execution required:** Dry-run by default. Must use `--execute` to apply changes.

```bash
pika bulk --set status=done
# Error: No files selected. Use --type, --path, --where, --text, or --all.

pika bulk --type task --set status=done
# Dry-run: shows what would change, but doesn't apply

pika bulk --type task --set status=done --execute
# Actually applies the changes

pika bulk --all --set status=done --execute
# Works (explicit targeting + explicit execution)
```

This two-gate model prevents accidental vault-wide mutations. You must be explicit about *what* (targeting) and *that you mean it* (execution).

---

## Autocomplete

Shell completion is required for `--type` and `--path`:

```bash
pika list --type <TAB>
# Shows: task, idea, reflection, objective, ...

pika bulk --path <TAB>
# Shows: Ideas/, Reflections/, Work/, ...

pika audit --path Reflections/<TAB>
# Shows: Daily Notes/, Weekly/, ...
```

Autocomplete makes the targeting model discoverable and reduces errors.

---

## Deprecations

### Simple filter flags (e.g., `--status=active`)

**Deprecated.** Use `--where` instead.

```bash
# Old (deprecated):
pika list task --status=active

# New:
pika list task --where "status == 'active'"
```

**Rationale:** `--where` is more powerful, consistent, and reduces flag proliferation. Simple filters will emit deprecation warnings and be removed in a future version.

---

## Examples

### Onboarding/migration workflow

```bash
# Bulk-add type to existing files by location
pika bulk --path "Reflections/Daily Notes" --set type=daily-note --execute

# Find files with legacy frontmatter (not yet in schema)
pika list --where "!isEmpty(old_field)"
# Warning: 'old_field' not in schema

# Rename field across all notes of a type
pika bulk --type task --rename old_field=new_field --execute
```

### Daily workflows

```bash
# List active tasks in Work folder
pika list task --path "Work/" --where "status == 'active'"

# Find notes containing "TODO" that are drafts
pika list --text "TODO" --where "status == 'draft'"

# Open a task by searching
pika open --type task --text "quarterly review"
```

### Audit and maintenance

```bash
# Audit only tasks for missing required fields
pika audit task --only missing-required

# Fix issues in a specific directory
pika audit --path "Ideas/" --fix

# Delete notes containing specific text (with confirmation)
pika delete --text "DELETE ME"
```

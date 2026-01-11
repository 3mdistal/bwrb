---
title: Targeting Model
description: How Bowerbird commands select which notes to operate on
---

Bowerbird uses a unified targeting model across all commands that operate on sets of notes. Once you understand the four selectors, you can use any command.

**Core principle:** All targeting selectors compose via AND (intersection). Each selector narrows the set of matched files.

## The Four Selectors

### Type (`-t, --type <type>`)

Filter by schema type.

```bash
bwrb list --type task
bwrb bulk --type reflection --set reviewed=true
bwrb audit --type objective
```

**Behavior:**
- Accepts short names (`task`) or full paths (`objective/task`)
- Short names are unambiguous since types cannot share names
- When specified, enables strict validation of `--where` fields

**Positional shortcut:** Type can be provided as a positional argument:
```bash
bwrb list task              # Same as: bwrb list --type task
bwrb bulk task --set x=y    # Same as: bwrb bulk --type task --set x=y
```

### Path (`-p, --path <glob>`)

Filter by file location in the vault.

```bash
bwrb list --path "Ideas/"
bwrb bulk --path "Reflections/Daily Notes" --set status=reviewed
bwrb audit --path "Work/**"
```

**Behavior:**
- Accepts directory paths or glob patterns
- Paths are relative to vault root
- Supports glob syntax (`*`, `**`, `?`)

### Query (`-w, --where <expression>`)

Filter by frontmatter field values.

```bash
bwrb list --where "status == 'active'"
bwrb bulk --where "priority < 3 && !isEmpty(deadline)" --set urgent=true
bwrb audit --where "isEmpty(tags)"
```

**Behavior:**
- Supports comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`
- Supports boolean operators: `&&`, `||`, `!`
- Supports functions: `isEmpty()`, `contains()`, `startsWith()`
- Multiple `--where` flags are ANDed together

**Type-checking behavior:**
- With `--type`: strict validation (error on unknown fields)
- Without `--type`: permissive with warnings (supports migration workflows)

**Hierarchy functions** (for recursive types):
- `isRoot()` — note has no parent
- `isChildOf('[[Note]]')` — direct child of specified note
- `isDescendantOf('[[Note]]')` — any descendant of specified note

```bash
bwrb list --type task --where "isRoot()"
bwrb list --type task --where "isChildOf('[[Epic]]')"
bwrb list --type task --where "isDescendantOf('[[Q1 Goals]]')" --depth 2
```

### Body (`-b, --body <query>`)

Filter by body content (full-text search via ripgrep).

```bash
bwrb list --body "TODO"
bwrb bulk --body "DEPRECATED" --delete deprecated_field
bwrb search --body "meeting notes" --type task
```

**Behavior:**
- Searches note body content (not frontmatter)
- Uses ripgrep under the hood for performance
- Case-insensitive by default

## Selector Composition

**All selectors compose via AND (intersection).** Each additional selector narrows the result set.

```bash
# Find tasks in Work/ folder with status=active containing "deadline"
bwrb list --type task --path "Work/" --where "status == 'active'" --body "deadline"
```

**Union (OR) is not implicit.** To express OR logic, use boolean operators within `--where`:
```bash
bwrb list --where "status == 'draft' || status == 'review'"
```

## Smart Positional Detection

For ergonomics, the first positional argument is auto-detected:

| Input | Detection | Equivalent |
|-------|-----------|------------|
| `bwrb list task` | Matches known type | `--type task` |
| `bwrb list "Ideas/"` | Contains `/`, matches path | `--path "Ideas/"` |
| `bwrb list "status == 'x'"` | Contains operators | `--where "status == 'x'"` |

**Ambiguity handling:** When detection is ambiguous, Bowerbird errors with a helpful message suggesting explicit flags.

## Command Support Matrix

| Command | `--type` | `--path` | `--where` | `--body` | Picker |
|---------|----------|----------|-----------|----------|--------|
| [list](/reference/commands/list/)    | Y | Y | Y | Y | - |
| [bulk](/reference/commands/bulk/)    | Y | Y | Y | Y | - |
| [audit](/reference/commands/audit/)   | Y | Y | Y | Y | - |
| [search](/reference/commands/search/)  | Y | Y | Y | Y | Y |
| [open](/reference/commands/open/)    | Y | Y | Y | Y | Y |
| [edit](/reference/commands/edit/)    | Y | Y | Y | Y | Y |
| [delete](/reference/commands/delete/)  | Y | Y | Y | Y | - |

**Notes:**
- `open` is an alias for `search --open`
- `edit` is an alias for `search --edit`

## Default Behavior

Default behavior depends on command destructiveness:

### Read-only commands (`list`, `audit` without `--fix`, `search`)

No selectors = implicit `--all` (operate on entire vault).

```bash
bwrb list           # Lists all notes
bwrb audit          # Audits all notes
```

### Interactive commands (`open`, `edit`)

No selectors = prompt with picker.

### Destructive commands (`bulk`, `delete`)

**Two safety gates:**

1. **Targeting required:** No selectors = error. Must specify at least one selector OR explicit `--all`.
2. **Execution required:** Dry-run by default. Must use `--execute` to apply changes.

```bash
bwrb bulk --set status=done
# Error: No files selected. Use --type, --path, --where, --body, or --all.

bwrb bulk --type task --set status=done
# Dry-run: shows what would change, but doesn't apply

bwrb bulk --type task --set status=done --execute
# Actually applies the changes

bwrb bulk --all --set status=done --execute
# Works (explicit targeting + explicit execution)
```

This two-gate model prevents accidental vault-wide mutations.

### Exception: `audit --fix`

`bwrb audit --fix` is a remediation workflow. It still requires explicit targeting (at least one selector or `--all`), but **it writes by default**.

- **Targeting required:** No selectors = error. Must specify at least one selector OR explicit `--all`.
- **Execution:** Writes by default. Use `--dry-run` to preview fixes without writing.
- `--execute` is accepted for compatibility but is not required for audit fixes.

See also: [CLI Safety and Flags](/concepts/cli-safety-and-flags/)

## Output Formats

Use `--output <format>` (or `-o`) to control how results are displayed:

| Format | Description |
|--------|-------------|
| `text` | Default human-readable |
| `json` | Machine-readable JSON |
| `paths` | File paths only |
| `link` | Wikilinks (`[[Note Name]]`) |
| `tree` | Hierarchical tree view (list only) |
| `content` | Full file contents (search only) |

```bash
bwrb list --type task --output json
bwrb list --type task --output paths
bwrb list --type task --output link      # [[Task 1]], [[Task 2]], ...
bwrb list --type task --output tree      # Hierarchical display
bwrb search "TODO" --output content      # Full file with matches
```

## See Also

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — `--execute` vs `--force` semantics
- [Expression syntax](/concepts/schema/) — Query expression details
- [bwrb list](/reference/commands/list/) — List and filter notes
- [bwrb bulk](/reference/commands/bulk/) — Batch operations


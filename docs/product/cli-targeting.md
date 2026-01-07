# CLI Targeting Model

> How Bowerbird commands select which notes to operate on.

---

## Overview

Bowerbird uses a unified targeting model across all commands that operate on sets of notes. This provides a consistent, learnable interface: once you understand the four selectors, you can use any command.

**Core principle:** All targeting selectors compose via AND (intersection). Each selector narrows the set of matched files.

---

## The Four Selectors

### 1. Type (`--type <type>`)

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

### 2. Path (`--path <glob>`)

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

### 3. Query (`--where <expression>`)

Filter by frontmatter field values.

```bash
bwrb list --where "status == 'active'"
bwrb bulk --where "priority < 3 && !isEmpty(deadline)" --set urgent=true
bwrb audit --where "isEmpty(tags)"
```

**Behavior:**
- Supports comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`
- Supports boolean operators: `&&`, `||`, `!`
- Supports functions: `isEmpty()`, `contains()`, `startsWith()`, etc.
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

### 4. Body (`--body <query>`)

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

**Short flag:** `-b` (e.g., `bwrb list -b "TODO"`)

---

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

---

## Smart Positional Detection

For ergonomics, the first positional argument is auto-detected:

| Input | Detection | Equivalent |
|-------|-----------|------------|
| `bwrb list task` | Matches known type | `--type task` |
| `bwrb list "Ideas/"` | Contains `/`, matches path | `--path "Ideas/"` |
| `bwrb list "status == 'x'"` | Contains operators | `--where "status == 'x'"` |

**Ambiguity handling:** When detection is ambiguous, Bowerbird errors with a helpful message:
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

| Command | `--type` | `--path` | `--where` | `--body` | Picker |
|---------|----------|----------|-----------|----------|--------|
| list    | Y | Y | Y | Y | - |
| bulk    | Y | Y | Y | Y | - |
| audit   | Y | Y | Y | Y | - |
| search  | Y | Y | Y | Y | Y |
| open    | Y | Y | Y | Y | Y |
| edit    | Y | Y | Y | Y | Y |
| delete  | Y | Y | Y | Y | - |

**Short flags:** `-t` (type), `-p` (path), `-w` (where), `-b` (body)

**Notes:**
- `open` is an alias for `search --open`
- `edit` is an alias for `search --edit`
- Both aliases gain full targeting support automatically

---

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

### Destructive commands (`bulk`, `delete`, `audit --fix`)

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

This two-gate model prevents accidental vault-wide mutations. You must be explicit about *what* (targeting) and *that you mean it* (execution).

---

## Autocomplete

Shell completion is required for `--type` and `--path`:

```bash
bwrb list --type <TAB>
# Shows: task, idea, reflection, objective, ...

bwrb bulk --path <TAB>
# Shows: Ideas/, Reflections/, Work/, ...

bwrb audit --path Reflections/<TAB>
# Shows: Daily Notes/, Weekly/, ...
```

Autocomplete makes the targeting model discoverable and reduces errors.

---

## Output Formats

Use `--output <format>` to control how results are displayed:

| Format | `list` | `search` | Description |
|--------|--------|----------|-------------|
| `text` | ✓ | ✓ | Default human-readable |
| `json` | ✓ | ✓ | Machine-readable JSON |
| `paths` | ✓ | ✓ | File paths only |
| `link` | ✓ | ✓ | Wikilinks (`[[Note Name]]`) |
| `tree` | ✓ | - | Hierarchical tree view |
| `content` | - | ✓ | Full file contents |

```bash
bwrb list --type task --output json
bwrb list --type task --output paths
bwrb list --type task --output link      # [[Task 1]], [[Task 2]], ...
bwrb list --type task --output tree      # Hierarchical display
bwrb search "TODO" --output content      # Full file with matches
```

---

## Examples

### Onboarding/migration workflow

```bash
# Bulk-add type to existing files by location
bwrb bulk --path "Reflections/Daily Notes" --set type=daily-note --execute

# Find files with legacy frontmatter (not yet in schema)
bwrb list --where "!isEmpty(old_field)"
# Warning: 'old_field' not in schema

# Rename field across all notes of a type
bwrb bulk --type task --rename old_field=new_field --execute
```

### Daily workflows

```bash
# List active tasks in Work folder
bwrb list task --path "Work/" --where "status == 'active'"

# Find notes containing "TODO" that are drafts
bwrb list --body "TODO" --where "status == 'draft'"

# Open a task by searching
bwrb open --type task --body "quarterly review"
```

### Audit and maintenance

```bash
# Audit only tasks for missing required fields
bwrb audit task --only missing-required

# Fix issues in a specific directory
bwrb audit --path "Ideas/" --fix

# Delete notes containing specific text (with confirmation)
bwrb delete --body "DELETE ME"
```

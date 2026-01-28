# CLI Targeting Model

> How Bowerbird commands select which notes to operate on.

**Canonical docs:** This document is product rationale. The user-facing, canonical targeting reference lives on the docs-site at `/reference/targeting/`.

---

## Overview

Bowerbird uses a unified targeting model across all commands that operate on sets of notes. This provides a consistent, learnable interface: once you understand the core selectors, you can use any command.

**Core principle:** All targeting selectors compose via AND (intersection). Each selector narrows the set of matched files.

### Vault resolution (Phase 2)

When `--vault` is not provided and the CLI is not inside a vault, Bowerbird runs a bounded find-down to discover candidate vaults beneath the current directory.

**Order of precedence:**
- `--vault <path>` (explicit)
- Find-up nearest ancestor containing `.bwrb/schema.json`
- `BWRB_VAULT` environment variable
- Find-down under `cwd` (Phase 2)

**Find-down behavior:**
- A vault root is any directory containing `.bwrb/schema.json`
- Once a vault is found on a branch, traversal does not continue into that directory
- Discovery is bounded and deterministic (sorted traversal, capped depth/results)

**Selection rules:**
- One candidate → auto-select
- Multiple candidates → prompt in TTY; otherwise error and require `--vault`
- `--output json` always errors with a structured candidate list

---

## The Four Core Selectors

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
- Field names may include hyphens and are treated literally in `--where` (e.g., `creation-date == '2026-01-28'`).

**Type-checking behavior:**
- With `--type`: strict validation (error on unknown fields)
- Without `--type`: permissive with warnings (supports migration workflows)

**Audit type inference:**
When running `bwrb audit` without `--type`, each file's type is resolved from its frontmatter `type` field. Files with missing or invalid types report `orphan-file` or `invalid-type` errors and skip type-dependent checks (like `wrong-directory`, `missing-required`, `invalid-option`). This is by design: audit can't validate fields without knowing the type's schema.

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

## Direct Addressing

### Stable ID (`--id <uuid>`)

Some workflows (automation, orchestration, long-lived references) need a stable identifier that survives rename/move operations.

`--id` targets notes by the reserved, system-managed frontmatter field `id` (UUID). IDs are created by `bwrb new` and must never change.

**Behavior:**
- Composes via AND with the core selectors
- Counts as explicit targeting for destructive safety gates (where supported)
- Implemented by reading note frontmatter during discovery; `.bwrb/` remains excluded from candidate sets
- 0 matches → error
- >1 matches → hard error (no first-match), candidates listed in text and JSON output

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

Commands that operate on note sets support the core selectors. Some commands also support `--id` for stable lookup:

| Command | `--type` | `--path` | `--where` | `--body` | `--id` | Picker |
|---------|----------|----------|-----------|----------|--------|--------|
| list    | Y | Y | Y | Y | Y | - |
| bulk    | Y | Y | Y | Y | N | - |
| audit   | Y | Y | Y | Y | N | - |
| search  | Y | Y | Y | Y | N | Y |
| open    | Y | Y | Y | Y | Y | Y |
| edit    | Y | Y | Y | Y | Y | Y |
| delete  | Y | Y | Y | Y | Y | - |

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

This two-gate model prevents accidental vault-wide mutations. You must be explicit about *what* (targeting) and *that you mean it* (execution).

### Exception: `audit --fix`

`bwrb audit --fix` is a remediation workflow. Report-mode audit defaults to implicit `--all`, but fixes require explicit targeting (at least one selector or `--all`). Interactive fixes write by default; auto-fixes require `--execute` to apply.

- **Targeting required:** No selectors = error. Must specify at least one selector OR explicit `--all`.
- **Interactive preview:** Use `--dry-run` to preview guided fixes without writing.
- **Non-interactive:** Use `--fix --auto --execute` for safe auto-fixes when stdin is not a TTY; omit `--execute` to preview.

### `--execute` vs `--force`

Bowerbird uses two distinct safety flags:

- `--execute` (`-x`) means **apply changes** (many destructive commands default to dry-run).
- `--force` (`-f`) means **skip a confirmation prompt** (or explicitly allow overwriting an existing artifact like a saved dashboard).

These are intentionally not interchangeable: `--execute` is an execution gate; `--force` is a prompt/overwrite gate.

**Canonical documentation:** The docs-site is the canonical source for CLI documentation. See `https://bwrb.dev/concepts/cli-safety-and-flags/` for the user-facing explanation.

---

## Ignore Rules

While selectors narrow the candidate set, ignore rules determine what enters the candidate set in the first place. These two concepts are orthogonal: selectors filter *which* files match your query; ignore rules decide which files are *discoverable*.

### Exclusion Mechanisms

Bowerbird recognizes multiple exclusion mechanisms:

| Mechanism | Source | Example |
|-----------|--------|---------|
| `.gitignore` patterns | `.gitignore` file in vault root | `Archive/`, `*.tmp` |
| `.bwrbignore` patterns | `.bwrbignore` files (hierarchical) | `dist/`, `!dist/`, `!dist/**` |
| Exclusions (schema, canonical) | `schema.config.excluded_directories` | `["Templates", "Archive/Old"]` |
| Exclusions (schema, legacy alias) | `schema.audit.ignored_directories` | `["Templates", "Archive/Old"]` |
| Exclusions (env, canonical) | `BWRB_EXCLUDE` (comma-separated) | `BWRB_EXCLUDE=Archive,Drafts` |
| Exclusions (env, legacy alias) | `BWRB_AUDIT_EXCLUDE` (comma-separated) | `BWRB_AUDIT_EXCLUDE=Archive,Drafts` |
| Hidden directories | Any directory starting with `.` | `.obsidian/`, `.trash/` |
| Always excluded | `.bwrb/` | `.bwrb/` |

**Notes:**
- `.gitignore` is optional. Bowerbird works on any folder of Markdown files, Git-backed or not. Only the vault root `.gitignore` is consulted (not nested `.gitignore` files).
- `.bwrbignore` is optional. Patterns use `.gitignore`-style matching (including `!` negation) and are discovered hierarchically.
- `.bwrbignore` rules are applied after `.gitignore`, so they can override gitignored paths. Note: re-including a file under a gitignored directory requires unignoring the directory too (e.g. `!dist/` then `!dist/**`).
- `.bwrbignore` files inside a directory that is ignored (by `.gitignore` or a parent `.bwrbignore`) may not be discovered, because bwrb does not traverse into ignored directories just to look for more ignore rules. Put override rules in an ancestor directory (often the vault root).
- Hard exclusions (schema/env exclusions, hidden directories, and `.bwrb/`) are always excluded and are not overrideable via `.bwrbignore`.

### When Exclusion Rules Apply

Excluded directories apply to **all bwrb operations** consistently. If a file is excluded, it does not enter the candidate set for `list`, `search`/`open`/`edit`, or `audit`.

### Example

```bash
# Schema has: config.excluded_directories: ["Archive"]
# Archive/Tasks/ contains "Old Task.md" (a task type note)

bwrb list task            # Does NOT find it
bwrb search "Old Task"    # Does NOT find it
bwrb audit task           # Skips Archive/
```

---

## Autocomplete

Shell completion makes bwrb discoverable and reduces errors. Completion is offline (derived from local vault/config) and consistent across commands.

### Option Value Completion

```bash
bwrb list --type <TAB>
# Shows: task, idea, reflection, objective, ...

bwrb bulk --path <TAB>
# Shows: Ideas/, Reflections/, Work/, ...

bwrb audit --path Reflections/<TAB>
# Shows: Daily Notes/, Weekly/, ...
```

### Entity Name Completion

Commands that accept known entity names complete those names from local storage:

**Dashboard names:**
```bash
bwrb dashboard <TAB>
# Shows: list, new, edit, delete, my-tasks, active-ideas, ...

bwrb dashboard edit <TAB>
# Shows: my-tasks, active-ideas, ...

bwrb dashboard delete <TAB>
# Shows: my-tasks, active-ideas, ...
```

**Template names:**
```bash
bwrb template edit <TAB>
# Shows: task, idea, objective, ...  (type names first)

bwrb template edit task <TAB>
# Shows: default, weekly, standup, ...  (template names for that type)

bwrb template delete idea <TAB>
# Shows: research, brainstorm, ...
```

**Schema entities:**
```bash
bwrb schema edit <TAB>
# Shows: type, field

bwrb schema edit type <TAB>
# Shows: task, idea, objective, ...

bwrb schema delete type <TAB>
# Shows: task, idea, objective, ...
```

### Behavior Rules

1. **Names only, no descriptions.** Completion shows entity names without inline descriptions. This keeps output clean and predictable.

2. **Offline/local.** All completion data comes from `.bwrb/` (schema, dashboards, templates). No network calls.

3. **Scoped completion.** Multi-positional commands (like `template edit <type> <name>`) complete the second argument based on the first. The type constrains which template names appear.

4. **Subcommands before names.** For commands like `dashboard`, first-position completion shows subcommands AND entity names together, letting users either run a dashboard directly or navigate to a subcommand.

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

**JSON contract:** In `--output json`, stdout must be exactly one JSON value (newline-terminated) and contain no non-JSON text. See `docs/product/cli-output-contract.md`.

```bash
bwrb list --type task --output json
bwrb list --type task --output paths
bwrb list --type task --output link      # [[Task 1]], [[Task 2]], ...
bwrb list --type task --output tree      # Hierarchical display
bwrb search "TODO" --output content      # Full file with matches
```

---

## Pagination / Interactive Output

Pagination is currently implemented only for the numbered selection prompt (the in-terminal picker used when multiple results need a choice).

**Where it applies:**
- Picker mode `numbered` (and `auto` when it falls back to numbered).
- Picker mode `fzf` uses fzf's own controls; this contract does not apply.
- Picker mode `none` is non-interactive and errors on ambiguity.

**Page size:** 10 items per page. Pagination appears when there are more than 10 options.

**Keys:**
- `-`: previous page
- `+` / `=`: next page (`=` is supported because `+` is Shift-`=`)
- `1-9`: select item 1-9 on the current page
- `0`: select item 10 on the current page
- `Up/Down` (or `j/k`): move selection
- `Enter`: confirm selection
- `Ctrl+C` / `Escape`: cancel the operation

**JSON output:** `--output json` is never interactive and must not paginate or prompt.

### Planned: result output pagination (not yet implemented)

If/when Bowerbird adds interactive pagination for command output, it will:
- Apply only when stdout is a TTY and the output format is human-readable.
- Never apply to `--output json` (full output only).
- Use a 10-item increment per page.
- Define "append" per format:
  - `text`, `paths`, `link`: append next 10 items (line-based output)
  - `tree`: append next 10 top-level nodes with their full subtree
  - `content`: append next 10 note bodies

This section is a product contract for future work and is not implemented yet.

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

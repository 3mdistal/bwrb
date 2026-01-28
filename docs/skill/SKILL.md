---
name: bwrb
description: Schema-driven note management CLI for markdown vaults (bowerbird). Use for creating, querying, and editing structured notes programmatically.
---

# bwrb Agent Skill

bwrb (bowerbird) is a CLI for managing notes in Obsidian-style markdown vaults with schema-enforced frontmatter.

## When to Use This Skill

Use bwrb when you need to:
- Create structured notes with validated frontmatter
- Query and filter notes by type or field values
- Edit note frontmatter programmatically
- Generate wikilinks for Obsidian
- Validate notes against a schema

## Vault Resolution

bwrb finds the vault in this order:
1. `--vault <path>` flag
2. Find-up nearest ancestor containing `.bwrb/schema.json`
3. `BWRB_VAULT` environment variable
4. Current working directory (error if not a vault)

Always verify you're targeting the correct vault before operations.

## Initializing a Vault

Create a new bwrb vault with `init`:

```bash
# Initialize in current directory (non-interactive)
bwrb init --yes

# Initialize at specific path
bwrb init /path/to/vault --yes

# Reinitialize existing vault (destructive)
bwrb init --force --yes

# JSON output for scripting
bwrb init --yes --output json
```

The command creates `.bwrb/schema.json` with:
- Version 2 format
- Default `wikilink` link format
- Auto-detected Obsidian vault name (if `.obsidian/` exists)
- Empty `types: {}` (add types with `bwrb schema type new`)

## Schema Discovery

Before creating or querying notes, understand the vault's schema:

```bash
# List all types and their structure
bwrb schema list

# Show all types with fields inline (full overview)
bwrb schema list --verbose

# Show specific type definition with fields
bwrb schema list type task

# Get JSON output for parsing
bwrb schema list type task --output json
bwrb schema list --verbose --output json  # All types with fields as JSON
```

## Configuration

bwrb supports vault-wide configuration in `.bwrb/schema.json` under the `config` key:

```json
{
  "config": {
    "link_format": "wikilink",
    "date_format": "YYYY-MM-DD"
  }
}
```

### Available Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `link_format` | `wikilink`, `markdown` | `wikilink` | Format for relation field links |
| `date_format` | Pattern string | `YYYY-MM-DD` | Format for date fields |
| `open_with` | `system`, `editor`, `visual`, `obsidian` | `system` | Default --open behavior |
| `editor` | Command string | `$EDITOR` | Terminal editor command |
| `visual` | Command string | `$VISUAL` | GUI editor command |
| `excluded_directories` | `string[]` | `[]` | Directory prefixes to exclude from discovery/targeting |

### Date Format

The `date_format` option controls how dates are written to frontmatter:

- `YYYY-MM-DD` - ISO 8601 (default, recommended)
- `MM/DD/YYYY` - US format
- `DD/MM/YYYY` - EU format
- `DD-MM-YYYY` - EU format with dashes

**Validation is format-agnostic**: bwrb accepts any unambiguous date format during audit/validation.
Ambiguous dates like `01/02/2026` (where both parts are ≤12) are rejected.

```bash
# View current config
bwrb config list

# Edit config option
bwrb config edit date_format  # Interactive
bwrb config edit date_format --json '"MM/DD/YYYY"'  # Non-interactive

# Exclude directories globally
bwrb config edit excluded_directories --json '["Archive","Templates"]'
```

## Built-in Frontmatter Fields

Some fields are written by bwrb regardless of schema:

- `id`: reserved/system-managed UUID created by `bwrb new` and should not be edited.
- `name`: written by `bwrb new` as the note title; `bwrb audit` does not treat it as an unknown field even if the schema does not declare it.

## Core Commands for Agents

### Querying Notes

```bash
# List notes with JSON output (for parsing)
bwrb list idea --output json
bwrb list task --output json

# Filter by frontmatter fields
bwrb list task --where "status == 'active'" --output json
bwrb list task --where "priority == 'high' && status != 'done'" --output json

# Include specific fields in output
bwrb list task --fields status,priority --output json

# Target by stable id
bwrb list --id "<uuid>" --output json

# Full-text search in note content
bwrb list --body "search term" --output json
```

### Creating Notes

```bash
# Non-interactive creation with JSON frontmatter
bwrb new idea --json '{"name": "My Idea", "status": "raw"}'
bwrb new task --json '{"name": "Fix bug", "status": "backlog", "priority": "high"}'

# With template
bwrb new task --template bug-report --json '{"name": "Login fails"}'

# Skip template system entirely
bwrb new task --no-template --json '{"name": "Quick task"}'

# Include body sections
bwrb new task --json '{"name": "Task", "_body": {"Steps": ["Step 1", "Step 2"]}}'
```

Notes created via `bwrb new` always include a system-managed frontmatter `id` (UUIDv4). The `id` is reserved: you cannot set it in `bwrb new --json`, and you cannot modify it via `bwrb edit`.

### Editing Notes

```bash
# Patch frontmatter by query
bwrb edit "Note Name" --json '{"status": "done"}'

# Patch frontmatter by stable id
bwrb edit --id "<uuid>" --json '{"status": "done"}'

# Target specific type
bwrb edit --type task "Fix bug" --json '{"priority": "high"}'

# Filter then edit
bwrb edit --type task --where "status == 'active'" "Deploy" --json '{"status": "done"}'
```

### Finding Notes

```bash
# Get wikilink (avoid interactive picker)
bwrb search "Note Name" --wikilink --picker none

# JSON output for scripting
bwrb search "Note" --output json --picker none

# Open and get path
bwrb open "Note Name" --app print --picker none

# Open and get path by stable id
bwrb open --id "<uuid>" --app print --picker none
```

### Validation

```bash
# Audit all notes against schema
bwrb audit

# Audit specific type
bwrb audit --type task

# JSON output for parsing issues
bwrb audit --output json

# JSON issue metadata (for hygiene checks, under `issue.meta`)
# trailing-whitespace: line, before, after, trimmedCount
# unknown-enum-casing: suggested, matchedBy, before, after
# frontmatter-key-casing: fromKey, toKey, before, after (or conflictValue)
# duplicate-list-values: duplicates, removedCount, before, after
# invalid-boolean-coercion: coercedTo, before, after

# Fix issues (interactive writes by default; explicit targeting required)
# Apply guided fixes
bwrb audit --path "Ideas/**" --fix
# Preview fixes without writing
bwrb audit --path "Ideas/**" --fix --dry-run
# Auto-apply unambiguous fixes
bwrb audit --path "Ideas/**" --fix --auto --execute
# Preview auto-fixes
bwrb audit --path "Ideas/**" --fix --auto

# Fix a specific issue code (auto-fix; safe to script)
bwrb audit --path "Ideas/**" --only trailing-whitespace --fix --auto --execute
bwrb audit --path "Ideas/**" --only trailing-whitespace --fix --auto

# Non-interactive automation
bwrb audit --output json
bwrb audit --fix --auto --execute --all
# Refuse interactive audit fixes without a TTY
bwrb audit --fix --all
```

#### Type Inference and Check Dependencies

Audit resolves each file's type from its frontmatter `type` field. Understanding this is critical for automation:

- **Type resolution**: Each file's `type` field is read and matched to the schema by short name (e.g., `task`, not `objective/task`)
- **Early termination**: If `type` is missing or invalid, audit reports `orphan-file` or `invalid-type` and **skips all type-dependent checks**
- **Filtering vs fixing**: `--type` filters which files to audit; it does not fix missing type fields

**Check dependency table:**

| Check | Requires Type Resolution |
|-------|-------------------------|
| `orphan-file` | No (reports missing type) |
| `invalid-type` | No (reports unrecognized type) |
| `trailing-whitespace` | No (operates on raw frontmatter lines; schema/type not needed) |
| `missing-required` | Yes |
| `invalid-option` | Yes |
| `unknown-field` | Yes |
| `wrong-directory` | Yes |
| `format-violation` | Yes |
| `stale-reference` | Partial (body wikilinks always checked; frontmatter relation fields require type) |

**Workflow for files with type issues:**

```bash
# Step 1: Find files with type problems
bwrb audit --only orphan-file --output json
bwrb audit --only invalid-type --output json

# Step 1b: Find whitespace hygiene issues (warnings; auto-fixable)
bwrb audit --only trailing-whitespace --output json

# Step 2: Fix type field (bulk or individual)
bwrb bulk --path "SomeDir/" --set type=task --execute

# Step 3: Re-run full audit to catch type-dependent issues
bwrb audit
```

### Dashboards (Saved Queries)

Dashboards save common list queries for reuse:

```bash
# Create a dashboard with flags
bwrb dashboard new my-tasks --type task --where "status == 'active'"
bwrb dashboard new inbox --type task --where "status == 'inbox'" --default-output tree

# Create via JSON
bwrb dashboard new my-query --json '{"type":"task","where":["priority==high"]}'

# Run a saved dashboard
bwrb dashboard my-tasks
bwrb dashboard my-tasks --output json  # Override default output format

# List all dashboards
bwrb dashboard list
bwrb dashboard list --output json  # JSON output for scripting
```

## Best Practices

1. **Always use `--output json`** for list/search/audit when parsing output
2. **Always use `--picker none`** to prevent interactive prompts blocking automation
3. **Query schema first** before creating notes to understand required fields
4. **Use `--json` input** for `new` and `edit` to avoid interactive prompts
5. **Validate with audit** after bulk operations
6. **Use filter expressions** (`--where`) for targeted queries rather than fetching all notes

## Filter Expression Syntax

```bash
# Equality
--where "status == 'active'"

# Inequality
--where "status != 'done'"

# Logical operators
--where "priority == 'high' && status == 'active'"
--where "status == 'done' || status == 'cancelled'"

# Comparison (for dates/numbers)
--where "created > '2024-01-01'"
```

## Common Patterns

```bash
# Get all active tasks as JSON
bwrb list task --where "status == 'active'" --output json

# Create a task and capture the path
bwrb new task --json '{"name": "New Task", "status": "backlog"}' --output json

# Bulk update (edit works on single notes; loop for bulk)
for note in $(bwrb list task --where "status == 'in-progress'" --output paths); do
  bwrb edit "$note" --json '{"status": "done"}'
done

# Generate a wikilink for insertion
bwrb search "Target Note" --wikilink --picker none  # Output: [[Target Note]]
```

## Error Handling

bwrb exits with non-zero status on errors. JSON output includes error information:

```bash
bwrb list nonexistent --output json
# {"error": "Type not found: nonexistent"}
```

Check exit codes in scripts:
```bash
if ! bwrb audit --type task --output json; then
  echo "Validation failed"
fi
```

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
2. `BWRB_VAULT` environment variable
3. Current working directory

Always verify you're targeting the correct vault before operations.

## Schema Discovery

Before creating or querying notes, understand the vault's schema:

```bash
# List all types and their structure
bwrb schema list

# Show specific type definition
bwrb schema list task

# List available enums
bwrb schema list enums
```

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

### Editing Notes

```bash
# Patch frontmatter by query
bwrb edit "Note Name" --json '{"status": "done"}'

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
```

### Validation

```bash
# Audit all notes against schema
bwrb audit

# Audit specific type
bwrb audit --type task

# JSON output for parsing issues
bwrb audit --output json

# Auto-fix issues (interactive repair)
bwrb audit --fix
bwrb audit --fix --auto  # Auto-apply unambiguous fixes
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

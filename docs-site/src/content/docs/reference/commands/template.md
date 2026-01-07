---
title: bwrb template
description: Template management
---

Manage reusable templates for note creation.

## Synopsis

```bash
bwrb template <subcommand>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [list](#list) | List templates |
| [new](#new) | Create a new template |
| [edit](#edit) | Edit an existing template |
| [delete](#delete) | Delete a template |
| [validate](#validate) | Validate templates against schema |

## Quick Examples

```bash
# List all templates
bwrb template list

# List templates for a type
bwrb template list task

# Create a new template
bwrb template new task --name bug-report

# Edit a template
bwrb template edit task bug-report

# Validate all templates
bwrb template validate
```

## Template Location

Templates are stored in `.bwrb/templates/{type}/{subtype}/{name}.md`.

---

## list

List templates in your vault, optionally filtered by type.

### Synopsis

```bash
bwrb template list [options] [type] [name]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `type` | Filter to templates for this type (e.g., `task`, `objective/milestone`) |
| `name` | Show details for a specific template |

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

### Examples

```bash
# List all templates
bwrb template list

# List templates for a specific type
bwrb template list task
bwrb template list objective/task

# Show specific template details
bwrb template list task bug-report

# JSON output
bwrb template list --output json
```

---

## new

Create a new template for a specific note type.

### Synopsis

```bash
bwrb template new [options] [type]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type to create template for (prompts if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Template name (without .md extension) |
| `--description <desc>` | Template description |
| `--json <data>` | Create template non-interactively from JSON |

### Examples

#### Interactive Creation

```bash
# Create template with prompts
bwrb template new task

# Specify name
bwrb template new task --name bug-report

# With description
bwrb template new task --name bug-report --description "Bug report with repro steps"
```

#### Non-interactive (JSON) Mode

```bash
# Create from JSON
bwrb template new task --name quick --json '{"defaults": {"status": "raw"}}'

# Full template definition
bwrb template new idea --name research --json '{
  "description": "Research note template",
  "defaults": {"status": "raw", "priority": "medium"},
  "prompt-fields": ["deadline"]
}'
```

---

## edit

Edit an existing template interactively or via JSON patch.

### Synopsis

```bash
bwrb template edit [options] [type] [name]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type of template to edit |
| `name` | Template name (shows picker if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--json <data>` | Update template non-interactively (patch/merge semantics) |

### Examples

#### Interactive Editing

```bash
# Edit with picker
bwrb template edit

# Edit specific template
bwrb template edit task bug-report
bwrb template edit objective/task default
```

#### Non-interactive (JSON) Mode

```bash
# Update specific fields
bwrb template edit task bug-report --json '{"defaults": {"priority": "high"}}'

# Update description
bwrb template edit idea default --json '{"description": "Updated description"}'
```

---

## delete

Delete a template from your vault.

### Synopsis

```bash
bwrb template delete [options] [type] [name]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type of template to delete |
| `name` | Template name (shows picker if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |
| `-o, --output <format>` | Output format: `text`, `json` |

### Examples

```bash
# Delete with confirmation
bwrb template delete task bug-report

# Delete with picker
bwrb template delete

# Skip confirmation
bwrb template delete task bug-report --force

# Scripting mode
bwrb template delete task bug-report -f -o json
```

---

## validate

Validate templates to ensure they're compatible with the current schema.

### Synopsis

```bash
bwrb template validate [options] [type]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `type` | Validate templates for specific type only |

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

### Description

Checks templates for:

- Valid `template-for` type reference
- Default field values match schema types
- Default enum values are valid
- Prompt-fields reference existing fields
- No references to removed schema fields

### Examples

```bash
# Validate all templates
bwrb template validate

# Validate templates for specific type
bwrb template validate task
bwrb template validate objective/milestone

# JSON output for CI
bwrb template validate --output json
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All templates valid |
| `1` | Validation errors found |

---

## See Also

- [Templates Overview](/templates/overview/) — Template concepts
- [Creating Templates](/templates/creating-templates/) — Template authoring guide
- [bwrb schema validate](/reference/commands/schema/#validate) — Validate schema

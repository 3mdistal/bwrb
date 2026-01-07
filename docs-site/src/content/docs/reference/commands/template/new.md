---
title: template new
description: Create a new template
---

Create a new template for a specific note type.

## Synopsis

```bash
bwrb template new [options] [type]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type to create template for (prompts if omitted) |

## Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Template name (without .md extension) |
| `--description <desc>` | Template description |
| `--json <data>` | Create template non-interactively from JSON |

## Examples

### Interactive Creation

```bash
# Create template with prompts
bwrb template new task

# Specify name
bwrb template new task --name bug-report

# With description
bwrb template new task --name bug-report --description "Bug report with repro steps"
```

### Non-interactive (JSON) Mode

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

## Template Location

Templates are created in `.bwrb/templates/{type}/{subtype}/{name}.md`.

## See Also

- [bwrb template](/reference/commands/template/) — Template command overview
- [Creating Templates](/templates/creating-templates/) — Template authoring guide

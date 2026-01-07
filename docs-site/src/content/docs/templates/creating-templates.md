---
title: Creating Templates
description: How to create and customize templates
---

Templates let you define default values and body structure for note types.

## Template Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Must be `template` |
| `template-for` | Yes | Type path (e.g., `objective/task`) |
| `description` | No | Human-readable description |
| `defaults` | No | Default field values (skip prompting) |
| `prompt-fields` | No | Fields to always prompt for |
| `filename-pattern` | No | Override filename pattern |
| `instances` | No | Child notes to create with parent (see [Instance Scaffolding](#instance-scaffolding)) |

## Creating a Template

### Via CLI

```bash
bwrb template new task
bwrb template new task --name bug-report
```

### Manually

Create a file at `.bwrb/templates/<type>/<name>.md`:

```yaml
---
type: template
template-for: objective/task
description: Standard task template
defaults:
  status: backlog
---

## Notes

```

## Default Values

Template defaults skip prompting and pre-fill field values.

### Static Defaults

```yaml
defaults:
  status: backlog
  priority: medium
  tags: []
```

### Dynamic Defaults (Date Expressions)

Use date expressions for dynamic values that evaluate at note creation time:

| Expression | Result | Description |
|------------|--------|-------------|
| `today()` | `2026-01-07` | Current date |
| `today() + '7d'` | `2026-01-14` | 7 days from now |
| `today() - '1w'` | `2025-12-31` | 1 week ago |
| `now()` | `2026-01-07 14:30` | Current datetime |
| `now() + '2h'` | `2026-01-07 16:30` | 2 hours from now |

**Duration units:**
- `min` — minutes
- `h` — hours
- `d` — days
- `w` — weeks (7 days)
- `mon` — months (fixed 30 days, not calendar months)
- `y` — years (fixed 365 days, not calendar years)

**Example:** Weekly review template with auto-deadline:

```yaml
---
type: template
template-for: task
description: Weekly review with auto-deadline
defaults:
  status: backlog
  deadline: "today() + '7d'"
---
```

### Value Precedence

When creating a note, values are applied in this order (later values override earlier):

1. **Schema defaults** — Base values from type definition
2. **Template defaults** — Override schema defaults
3. **JSON/CLI input** — Override everything (for automation)

```bash
# Template sets status: backlog, but JSON input overrides it
bwrb new task --json '{"name": "My Task", "status": "in-flight"}'
# Result: status is "in-flight", not "backlog"
```

## Variable Substitution

Use variables in the template body:

| Variable | Description |
|----------|-------------|
| `{fieldName}` | Replaced with frontmatter value |
| `{date}` | Today's date (YYYY-MM-DD) |
| `{date:FORMAT}` | Custom date format |

**Example:**

```markdown
---
type: template
template-for: idea
defaults:
  status: raw
---

# {name}

Created: {date}

## Description
```

When `bwrb new idea --name "My Idea"` runs, `{name}` becomes "My Idea" and `{date}` becomes today's date.

## Prompt Fields

Use `prompt-fields` to always prompt for specific fields, even when they have defaults:

```yaml
defaults:
  status: backlog
  priority: medium
prompt-fields:
  - deadline
  - milestone
```

This pre-fills `status` and `priority` but always asks for `deadline` and `milestone`.

## Template Discovery

Templates use **strict matching**:

- `objective/task` looks in `.bwrb/templates/objective/task/`
- No inheritance from parent types

### Selection Precedence

1. `--template name` — Uses `.bwrb/templates/{type}/name.md`
2. `--no-template` — Skips templates entirely, uses schema defaults only
3. Default — Uses `.bwrb/templates/{type}/default.md` if it exists

**Note:** `--no-template` takes precedence. If both flags are specified, templates are skipped:

```bash
bwrb new task --template bug-report --no-template
# Result: no template used (--no-template wins)
```

## Best Practices

### Use `default.md` for Common Workflows

Create a `default.md` template for types you use frequently. It applies automatically without `--template`:

```bash
bwrb new task  # Uses default.md automatically
```

### Reserve Named Templates for Specialized Formats

Create named templates for specific use cases:

```
.bwrb/templates/task/
├── default.md       # Standard task
├── bug-report.md    # Bug with repro steps
└── sprint-item.md   # Sprint planning format
```

### Set Safe Defaults, Prompt for Critical Fields

Pre-fill fields with sensible defaults, but always prompt for fields that vary:

```yaml
defaults:
  status: backlog      # Safe default
  priority: medium     # Safe default
prompt-fields:
  - deadline           # Always ask (varies per task)
  - milestone          # Always ask (context-dependent)
```

### Use Date Expressions for Time-Sensitive Defaults

For recurring tasks with relative deadlines:

```yaml
# Weekly review: deadline always 7 days out
defaults:
  deadline: "today() + '7d'"

# End-of-month report: deadline always 30 days out
defaults:
  deadline: "today() + '1mon'"
```

### Validate Templates After Schema Changes

When you modify your schema, validate templates to catch broken references:

```bash
bwrb template validate
```

This catches:
- References to removed fields
- Invalid enum values
- Mismatched type paths

## Instance Scaffolding

Templates can define `instances` to automatically create related child notes when the parent note is created. This is useful for project templates that need consistent supporting files.

### Defining Instances

```yaml
---
type: template
template-for: project
description: Project with scaffolded research notes
defaults:
  status: in-flight
instances:
  - type: research
    filename: "Background Research.md"
    defaults:
      status: raw
  - type: research
    filename: "Competitor Analysis.md"
    defaults:
      status: raw
---

# Project Overview

## Goals

## Timeline
```

### Instance Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Type of note to create |
| `filename` | No | Override filename (default: `{type}.md`) |
| `template` | No | Template to use for the instance |
| `defaults` | No | Instance-specific default values |

### Behavior

When you run `bwrb new project --template with-research`:

1. The parent project note is created
2. Each instance file is created in the same directory
3. Existing instance files are **skipped** (not overwritten)
4. A summary shows what was created

```
✓ Created: Projects/My Project.md

Instances created:
  ✓ Projects/Background Research.md
  ✓ Projects/Competitor Analysis.md

✓ Created 3 files (1 parent + 2 instances)
```

### Skipping Instance Creation

Use `--no-instances` to create only the parent note:

```bash
bwrb new project --template with-research --no-instances
```

## Complete Example

A bug report template with all features:

```yaml
---
type: template
template-for: task
description: Bug report with reproduction steps
defaults:
  status: backlog
  priority: high
prompt-fields:
  - deadline
  - milestone
---

## Description

[Describe the bug]

## Steps to Reproduce

1. 
2. 
3. 

## Expected Behavior

## Actual Behavior

## Environment

- OS: 
- Version: 
```

## See Also

- [Templates overview](/templates/overview/)
- [bwrb template command](/reference/commands/template/)

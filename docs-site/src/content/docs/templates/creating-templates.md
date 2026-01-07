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

## Variable Substitution

Use variables in the template body:

- `{fieldName}` — Replaced with frontmatter value
- `{date}` — Today's date (YYYY-MM-DD)
- `{date:FORMAT}` — Custom date format

## Template Discovery

Templates use **strict matching**:

- `objective/task` looks in `.bwrb/templates/objective/task/`
- No inheritance from parent types

## See Also

- [Templates overview](/templates/overview/)
- [bwrb template command](/reference/commands/template/)

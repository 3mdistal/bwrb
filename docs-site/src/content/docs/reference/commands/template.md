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
| [list](/reference/commands/template/list/) | List templates |
| [new](/reference/commands/template/new/) | Create a new template |
| [edit](/reference/commands/template/edit/) | Edit an existing template |
| [delete](/reference/commands/template/delete/) | Delete a template |
| [validate](/reference/commands/template/validate/) | Validate templates against schema |

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

## See Also

- [Templates Overview](/templates/overview/) — Template concepts
- [Creating Templates](/templates/creating-templates/) — Template authoring guide

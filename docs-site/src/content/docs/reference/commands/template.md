---
title: bwrb template
description: Manage note templates
---

Manage reusable templates for note creation.

## Usage

```bash
bwrb template <subcommand>
```

## Subcommands

### list

View templates:

```bash
bwrb template list                    # All templates
bwrb template list task               # Templates for type
bwrb template list task bug-report    # Specific template
```

### new

Create a template:

```bash
bwrb template new task
bwrb template new task --name bug-report
bwrb template new task --json '{"defaults": {"priority": "high"}}'
```

### edit

Modify a template:

```bash
bwrb template edit task default
bwrb template edit task bug-report --json '{"defaults": {"status": "backlog"}}'
```

### delete

Remove a template:

```bash
bwrb template delete task bug-report
```

### validate

Check templates against schema:

```bash
bwrb template validate          # All templates
bwrb template validate task     # Type's templates
```

## See Also

- [Templates overview](/templates/overview/)
- [Creating templates](/templates/creating-templates/)

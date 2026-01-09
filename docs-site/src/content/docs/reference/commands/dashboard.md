---
title: bwrb dashboard
description: Run and manage saved queries
---

A dashboard is a saved list query. Run dashboards to execute saved queries and manage them with subcommands.

## Synopsis

```bash
bwrb dashboard [options] [name]
bwrb dashboard <subcommand>
```

## Running Dashboards

Execute a saved dashboard by name:

```bash
bwrb dashboard my-tasks
bwrb dashboard inbox --output json   # Override output format
```

## Options

| Option | Description |
|--------|-------------|
| `--output <format>` | Override output format: `text`, `paths`, `tree`, `link`, `json` |

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all saved dashboards |
| `new <name>` | Create a new dashboard |
| `edit [name]` | Edit an existing dashboard |

## Creating Dashboards

### From `bwrb list`

Save any list query as a dashboard:

```bash
bwrb list task --where "status='active'" --save-as "active-tasks"
bwrb list task --output tree --save-as "task-tree" --force
```

### With `dashboard new`

Create a dashboard directly:

```bash
bwrb dashboard new my-query --type task --where "status=active"
```

## Examples

```bash
# Run a dashboard
bwrb dashboard my-tasks

# Override output format
bwrb dashboard inbox --output json

# List all dashboards
bwrb dashboard list
bwrb dashboard list --output json

# Create a new dashboard
bwrb dashboard new my-query --type task --where "status=active"

# Edit a dashboard
bwrb dashboard edit my-tasks
```

## See Also

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — `--execute` vs `--force` semantics
- [bwrb list](/reference/commands/list/) — List and filter notes
- [Targeting Model](/reference/targeting/) — Selector reference


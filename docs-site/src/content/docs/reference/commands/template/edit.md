---
title: template edit
description: Edit an existing template
---

Edit an existing template interactively or via JSON patch.

## Synopsis

```bash
bwrb template edit [options] [type] [name]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type of template to edit |
| `name` | Template name (shows picker if omitted) |

## Options

| Option | Description |
|--------|-------------|
| `--json <data>` | Update template non-interactively (patch/merge semantics) |

## Examples

### Interactive Editing

```bash
# Edit with picker
bwrb template edit

# Edit specific template
bwrb template edit task bug-report
bwrb template edit objective/task default
```

### Non-interactive (JSON) Mode

```bash
# Update specific fields
bwrb template edit task bug-report --json '{"defaults": {"priority": "high"}}'

# Update description
bwrb template edit idea default --json '{"description": "Updated description"}'
```

## See Also

- [bwrb template](/reference/commands/template/) — Template command overview
- [Creating Templates](/templates/creating-templates/) — Template authoring guide

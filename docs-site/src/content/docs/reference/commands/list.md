---
title: bwrb list
description: Query and filter notes by type and fields
---

List notes matching filter criteria with flexible output formats.

## Synopsis

```bash
bwrb list [options] [positional]
```

The positional argument is auto-detected as type, path (contains `/`), or where expression (contains operators).

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type path (e.g., `idea`, `objective/task`) |
| `-p, --path <glob>` | Filter by file path glob (e.g., `Projects/**`, `Ideas/`) |
| `-w, --where <expr>` | Filter with expression (repeatable, ANDed together) |
| `-b, --body <query>` | Filter by body content search |

### Output

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `paths`, `tree`, `link`, `json` |
| `--fields <fields>` | Show frontmatter fields in a table (comma-separated) |
| `-L, --depth <n>` | Limit tree depth |

### Actions

| Option | Description |
|--------|-------------|
| `--open` | Open the first result (or pick interactively) |
| `--app <mode>` | How to open: `system`, `editor`, `visual`, `obsidian`, `print` |
| `--save-as <name>` | Save this query as a dashboard |
| `--force` | Overwrite existing dashboard when using `--save-as` |

## Output Formats

| Format | Description |
|--------|-------------|
| `text` | Note names (default) |
| `paths` | Vault-relative file paths |
| `tree` | Hierarchical tree view |
| `link` | Wikilinks (`[[Note Name]]`) |
| `json` | Full JSON data |

## Examples

### Basic Listing

```bash
# List all notes of a type
bwrb list task
bwrb list objective/milestone

# With field columns
bwrb list task --fields=status,priority
```

### Filtering

```bash
# By frontmatter values
bwrb list --type task --where "status == 'in-progress'"
bwrb list --type task --where "priority < 3 && !isEmpty(deadline)"

# By date
bwrb list --type task --where "deadline < today() + '7d'"

# By body content
bwrb list --body "TODO" --where "status == 'draft'"

# By path
bwrb list --path "Projects/**" --body "TODO"
```

### Hierarchy Functions

For recursive types with parent-child relationships:

```bash
# Root notes only
bwrb list --type task --where "isRoot()"

# Direct children
bwrb list --type task --where "isChildOf('[[Epic]]')"

# All descendants (with depth limit)
bwrb list --type task --where "isDescendantOf('[[Q1 Goals]]')" --depth 2
```

### Output Formats

```bash
bwrb list --type task --output json
bwrb list --type task --output paths
bwrb list --type task --output link      # [[Task 1]], [[Task 2]], ...
bwrb list --type task --output tree      # Hierarchical display
```

### Open from Results

```bash
bwrb list --type task --open                    # Pick from tasks and open
bwrb list --type task --where "status=inbox" --open
```

### Save as Dashboard

```bash
bwrb list --type task --where "status='active'" --save-as "active-tasks"
bwrb list --type task --output tree --save-as "task-tree" --force
```

## Shell Note

In zsh, use single quotes for expressions with `!` to avoid history expansion:

```bash
bwrb list --type task --where '!isEmpty(deadline)'
```

## See Also

- [Targeting Model](/reference/targeting/) — Full selector reference
- [bwrb dashboard](/reference/commands/dashboard/) — Run saved queries
- [bwrb search](/reference/commands/search/) — Interactive search with picker

---
title: bwrb list
description: Find, filter, inspect, and open notes
---

`list` is Bowerbird's canonical read-only note surface. It can resolve a note
by name, path, alias, or stable ID; rank fuzzy candidates; search body matches;
compose vault filters; print links, paths, content, or JSON; and open a result.

## Synopsis

```bash
bwrb list [options] [positional] [mode]
```

The first positional argument is auto-detected as type, path (contains `/`), or where expression (contains operators).

The optional second positional `[mode]` is the app mode used with `--open`
(`system`, `editor`, `visual`, `obsidian`, `print`) — parity with
the compatibility [`bwrb open`](/reference/commands/open/). Because `[mode]` is the **second**
positional, a lone positional is always treated as the smart filter, never the
mode: use `bwrb list task print --open`, not `bwrb list print --open` (which
would treat `print` as a type filter). To set the mode without a filter
positional, use the `--app` flag. An explicit `--app` flag always takes
precedence over the positional `[mode]`, an invalid mode value is rejected with
a clear error, and excess positional arguments beyond `[positional] [mode]` are
rejected.

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type path (e.g., `idea`, `objective/task`) |
| `-p, --path <glob>` | Filter by file path glob (e.g., `Projects/**`, `Ideas/`) |
| `-w, --where <expr>` | Filter with expression (repeatable, ANDed together) |
| `-b, --body <query>` | Filter by body content search |
| `--name <query>` | Resolve by note name, path, or declared alias |
| `--fuzzy <query>` | Rank approximate name and alias matches |
| `--matches` | Show detailed body matches instead of filtering note rows |
| `--threshold <0-1>` | Minimum fuzzy similarity (default: `0.5`) |
| `-C, --context <lines>` | Context lines for `--matches` (default: `2`) |
| `--no-context` | Hide context around detailed body matches |
| `-S, --case-sensitive` | Case-sensitive detailed body matching |
| `-E, --regex` | Treat the detailed body query as a regex |

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `paths`, `tree`, `link`, `content`, `json` |
| `--fields <fields>` | Show fields in a table (comma-separated). Accepts frontmatter fields plus the file stats `file.mtime`, `file.ctime`, `file.size` |
| `--sort <field>` | Sort by a frontmatter field, `name`, `_name`, `_path`, or a file stat (`file.mtime`, `file.ctime`, `file.size`) |
| `--desc` | Sort descending (requires `--sort`) |
| `--limit <n>` | Show only the first `n` matching notes |
| `--count` | Print only the number of matching notes |
| `-L, --depth <n>` | Limit tree depth |

### Actions

| Option | Description |
|--------|-------------|
| `-o, --open` | Open the first result (or pick interactively) |
| `--app <mode>` | How to open: `system`, `editor`, `visual`, `obsidian`, `print` |
| `--picker <mode>` | Selection mode: `auto`, `fzf`, `numbered`, `none` |
| `--preview` | Show a preview in the fzf picker |
| `--save-as <name>` | Save this query as a dashboard |
| `--force` | Overwrite existing dashboard when using `--save-as` |

## Output Formats

| Format | Description |
|--------|-------------|
| `text` | Note names (default) |
| `paths` | Vault-relative file paths |
| `tree` | Hierarchical tree view |
| `link` | Wikilinks (`[[Note Name]]`) |
| `content` | Complete Markdown file contents |
| `json` | Full JSON data |

Name, fuzzy, and detailed-match modes use the established search JSON shapes.
Fuzzy JSON includes similarity scores and the field that matched; detailed body
JSON includes line matches and context. Normal filtered-list JSON remains the
array of note frontmatter objects used by existing scripts.

## Resolution and Search Modes

The explicit modes keep smart positional filters unambiguous:

```bash
# Resolve a single entity by name, path, or alias
bwrb list --name "My Note" --picker none
bwrb list --name "Ideas/My Note.md" --output link --picker none

# Ranked approximate matches, including aliases
bwrb list --fuzzy "Stephen Yeg" --threshold 0.7 --output json

# Filter note rows by a literal, case-insensitive body query
bwrb list --body "TODO" --path "Projects/**"

# Inspect exact body matches with grep-style context and regex controls
bwrb list --body "TODO|FIXME" --matches --regex --context 0
```

`--type`, `--path`, and `--where` further scope all three search modes. `--limit`
also applies. Table, hierarchy, sort, count, and dashboard options belong to the
normal filtered-list mode and are rejected with the search modes rather than
being silently ignored.

## Examples

### Basic Listing

```bash
# List all notes of a type
bwrb list task
bwrb list objective/milestone

# With field columns
bwrb list task --fields=status,priority

# File stats can also be shown as columns (not just sorted on)
bwrb list task --fields=status,file.mtime,file.size
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

For notes with parent-child relationships:

```bash
# Root notes only
bwrb list --type task --where "isRoot()"

# Direct children
bwrb list --type task --where "isChildOf('[[Epic]]')"

# All descendants (with depth limit)
bwrb list --type task --where "isDescendantOf('[[Q1 Goals]]')" --depth 2

# Follow a relation field, then walk THAT target's ancestors.
# Matches tasks whose `context` is career or anything under it.
bwrb list --type task --where "under(context, '[[career]]')"
```

`under(field, '[[Node]]')` differs from `isDescendantOf`: it dereferences the
named relation `field` and walks the *target's* ancestor chain, rather than the
note's own `parent` chain. `isChildOf`/`isDescendantOf` walk only the literal
`parent` field (resolved over the whole vault, so chains through other types are
not truncated); relation fields like `context` or `milestone` are queried with
`under`. See [Targeting Model](/reference/targeting/) for details.

### Output Formats

```bash
bwrb list --type task --output json
bwrb list --type task --output paths
bwrb list --type task --output link      # [[Task 1]], [[Task 2]], ...
bwrb list --type task --output tree      # Hierarchical display
```

#### `--output tree`

`--output tree` renders a **parent hierarchy** whenever the matched notes carry
`parent` links — drawing the nesting directly from each note's `parent` relation.
This works for any entity type that models a hierarchy this way (for example a
`context`/`domain` type, see [Hierarchical Scope (Contexts as Notes)](/concepts/hierarchical-scope/)),
not only types marked `recursive`:

```bash
bwrb list --type context --output tree
```

```text
└── career
    └── Builder
        └── Vercel
```

When the matched notes have **no** `parent` links, `--output tree` instead groups
them by their vault directory. Use `-L`/`--depth` to limit how deep the tree
renders, and `--sort`/`--desc` to order siblings:

```bash
bwrb list --type context --output tree -L 2          # top two levels only
bwrb list --type context --output tree --sort name --desc
```

### Limiting and Counting

```bash
# Sort by frontmatter or display fields
bwrb list --type task --sort deadline
bwrb list --type task --sort priority --desc
bwrb list --sort name

# Sort by file stats (filesystem metadata, no frontmatter needed)
bwrb list --sort file.mtime --desc              # Most recently modified first
bwrb list --type task --sort file.ctime         # Oldest-created first
bwrb list --sort file.size --desc               # Largest notes first

# Show the first five matches after filtering
bwrb list --type task --where "status == 'in-progress'" --limit 5

# Print only the number of matches
bwrb list --type task --count
bwrb list --type task --count --output json  # {"count": 12}
```

The `file.*` keys read filesystem metadata and mirror the `file.*`
accessors available in `--where`: `file.mtime` (modification time),
`file.ctime` (creation time), and `file.size` (bytes). When used with
`--sort` they compare numerically. `bwrb recent` is
`bwrb list --sort file.mtime --desc` with a default limit of 20.

The same `file.*` keys can also be passed to `--fields` to render them as
table columns (and as keys in `--output json`):

```bash
bwrb list --type task --fields file.mtime,file.size,status
```

In the text table, `file.mtime`/`file.ctime` render as a local
`YYYY-MM-DD HH:MM` timestamp (matching `bwrb recent`'s MODIFIED column) and
`file.size` renders as a byte count. In `--output json`, `file.mtime`/
`file.ctime` are ISO-8601 strings and `file.size` is a number.

Missing sort values are always placed at the end, including with `--desc`.
`--count` reports the total number of matching notes before any `--limit` is applied.

### Open from Results

```bash
bwrb list --type task --open                    # Pick from tasks and open
bwrb list --type task --where "status=inbox" --open
bwrb list task print --open                      # Positional filter + app mode
bwrb list --name "My Note" --open --app editor --picker none
bwrb list --id "<uuid>" --open --app print --picker none
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

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — When to use `--force`
- [Targeting Model](/reference/targeting/) — Full selector reference
- [bwrb dashboard](/reference/commands/dashboard/) — Run saved queries
- [`search` compatibility command](/reference/commands/search/) — Legacy invocation mappings
- [`open` compatibility command](/reference/commands/open/) — Legacy invocation mappings

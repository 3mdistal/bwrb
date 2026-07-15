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
(`system`, `editor`, `visual`, `obsidian`, `print`). Because `[mode]` is the **second**
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
| `-b, --body <query>` | Filter by Markdown body content; YAML frontmatter is excluded |
| `--name <query>` | Resolve by note name, path, or declared alias |
| `--fuzzy <query>` | Rank approximate name and alias matches |
| `--matches` | Show detailed body matches instead of filtering note rows |
| `--threshold <0-1>` | Minimum fuzzy similarity (default: `0.5`) |
| `-C, --context <lines>` | Context lines for `--matches` (default: `2`) |
| `--no-context` | Hide context around detailed body matches |
| `-S, --case-sensitive` | Case-sensitive detailed body matching |
| `-E, --regex` | Treat the detailed body query as a regex |
| `--lineage <target>` | Render the complete fork lineage for one exact path, name, alias, or stable UUID target |

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `paths`, `tree`, `link`, `content`, `json` |
| `--fields <fields>` | Show fields in a table (comma-separated). Accepts frontmatter fields plus the file stats `file.mtime`, `file.ctime`, `file.size` |
| `--sort <field>` | Sort by a frontmatter field, `name`, `_name`, `_path`, or a file stat (`file.mtime`, `file.ctime`, `file.size`) |
| `--desc` | Sort descending (requires `--sort`) |
| `--limit <n>` | Limit displayed results; never narrows name-mode selection |
| `--count` | Print only the number of matching notes |
| `--receipt` | With `--output json`, return query metadata, counts, truncation, and data rows |
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

Use `--receipt --output json` for applied selectors/settings, pre-limit matched
count, returned count, `truncated`, and rows under `data`. Without `--receipt`,
normal filtered-list JSON remains the raw array. Receipt mode is JSON-only and
incompatible with `--count`, `--open`, lineage, and name/fuzzy/detailed-match
modes; it reports one execution's target set, not an atomic vault snapshot.
Fuzzy JSON includes similarity scores and the field that matched; detailed body
JSON includes line matches and context. Normal filtered-list JSON remains the
array of note frontmatter objects used by existing scripts. Each row also has a
`revision`: an opaque digest of the exact Markdown bytes read for that row.
Treat it only as an observation token—do not infer ordering or meaning from its
format. Pass it unchanged to guarded JSON edits when a shared record must not
silently overwrite a newer change.

With `--matches`, text output shows grep-style line details and JSON preserves
structured match details. `paths` and `link` emit each matching note once, while
`content` emits each complete matching Markdown file. Output formats do not
quietly collapse into text merely because match detail is available.

## Resolution and Search Modes

The explicit modes keep smart positional filters unambiguous:

```bash
# Resolve a single entity by name, path, or alias
bwrb list --name "My Note" --picker none
bwrb list --name "Ideas/My Note.md" --output link --picker none

# Ranked approximate matches, including aliases
bwrb list --fuzzy "Stephen Yeg" --threshold 0.7 --output json

# Filter note rows by a literal, case-insensitive file-content query
bwrb list --body "TODO" --path "Projects/**"

# Inspect exact file matches with grep-style context and regex controls
bwrb list --body "TODO|FIXME" --matches --regex --context 0
```

`--type`, `--path`, and `--where` further scope all three search modes. `--limit`
also applies: it caps displayed candidates in name mode, ranked candidates in
fuzzy mode, and matching files in detailed body-match mode. Table, hierarchy,
sort, count, and dashboard options belong to the normal filtered-list mode and
are rejected with the search modes rather than being silently ignored.

Name-mode limiting happens only after resolution. An interactive picker still
shows every matching candidate, and `--picker none` still reports ambiguity
against the complete set. Consequently, `--name "Duplicate" --limit 1 --open`
cannot silently open one of two notes named `Duplicate`; select one
interactively or pass its exact relative path.

If `--name` exactly identifies a path, basename, or declared alias that the
composed filters exclude, the command reports no match. It never substitutes a
fuzzy neighbour for an exact target.

## Fork Lineage

`bwrb list --lineage <target>` follows the immutable `forked-from` UUID edges
for one document and returns its complete connected lineage component. That
means every ancestor and descendant plus collateral branches: siblings,
cousins, and their descendants. Querying any member returns the same physical
family tree; only the target marker and target-relative JSON metadata change.
The target uses the same exact resolution surfaces as `new --fork`: an
absolute or vault-relative managed path (with or without `.md`), basename,
frontmatter name, declared alias, or case-insensitive stable UUID. It never
falls back to fuzzy matching.

With no `--output`, lineage mode renders a structural tree. Explicit
`--output tree` does the same, and marks the selected note with `(target)`:

```text
Briefs/Launch Brief.md
└── Briefs/Launch Brief v2.md (target)
    └── Briefs/Launch Brief v3.md
```

The other canonical outputs are `paths`, `link`, `content`, and `json`. JSON is
stable and machine-readable:

```json
{
  "target": { "path": "Briefs/Launch Brief v2.md", "id": "..." },
  "nodes": [
    {
      "path": "Briefs/Launch Brief.md",
      "id": "...",
      "forked_from": null,
      "depth": -1,
      "relationship": "ancestor"
    },
    {
      "path": "Briefs/Launch Brief v2.md",
      "id": "...",
      "forked_from": "...",
      "depth": 0,
      "relationship": "target"
    },
    {
      "path": "Briefs/Alternate Launch Brief v2.md",
      "id": "...",
      "forked_from": "...",
      "depth": 0,
      "relationship": "related"
    }
  ],
  "warnings": []
}
```

`depth` is a signed generation offset: the node's generation in the rendered
physical tree minus the target's generation. Thus an ancestor is usually
negative and a descendant positive, while a same-generation sibling is
`related` at depth `0`; cousins can have negative, zero, or positive depth.
`relationship` is `ancestor` for the target's authored parent chain, `target`
for the selected note, `descendant` for notes reachable downward from it, and
`related` for every other member of the same component. On a malformed cycle,
the authored ancestor classification takes precedence and one deterministic
cycle edge is broken only for rendering and generation calculation. Paths are
vault-relative, authored UUID casing is preserved, and each physical note
appears at most once.

Malformed graphs remain inspectable without inventing history. Cycles,
dangling parents, invalid `forked-from` values, and child notes without a valid
ID produce structured `fork-cycle`, `dangling-forked-from`,
`invalid-forked-from`, or `missing-lineage-id` warnings. Text outputs write
warnings to stderr; JSON includes them only in `warnings`. A child without a
valid ID is included once as a terminal node. A target without a valid ID, or a
duplicate ID affecting the reached lineage, is a hard validation error; the
duplicate error lists every candidate path.

Lineage promises a complete connected component, so it rejects positional filters and
all query, search, hierarchy, truncation, sorting, field, dashboard, picker,
preview, and open actions rather than silently narrowing the graph.

```bash
bwrb list --lineage "Briefs/Launch Brief"              # tree
bwrb list --lineage "Briefs/Launch Brief" --output paths
bwrb list --lineage 8f48f6a8-55c1-4ea7-9f4b-96735ed24af3 --output link
bwrb list --lineage "Launch Brief v2" --output json
```

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

# By Markdown body content (YAML frontmatter excluded)
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
- [bwrb lineage](/reference/commands/lineage/) — Adopt known existing revisions into lineage
- [bwrb dashboard](/reference/commands/dashboard/) — Run saved queries

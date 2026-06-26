---
title: bwrb search
description: Find notes by name or content
---

Search for notes by name or content, with interactive selection and multiple output formats.

## Synopsis

```bash
bwrb search [options] [query] [mode]
```

The optional second positional `[mode]` is the app mode used with `--open`
(`system`, `editor`, `visual`, `obsidian`, `print`) — parity with
[`bwrb open`](/reference/commands/open/). For example,
`bwrb search "My Note" --open print` prints the resolved path. An explicit
`--app` flag always takes precedence over the positional `[mode]`, an invalid
mode value is rejected with a clear error, and a third excess positional is
rejected.

## Modes

Search operates in three modes:

- **Name search** (default): Searches by note name, basename, or path
- **Fuzzy search** (`--fuzzy`): Ranked approximate matching over note names and aliases, with scores
- **Content search** (`--body`): Full-text search across note contents using ripgrep

## Path Filtering

`-p, --path <pattern>` scopes the candidate notes to a path glob (e.g.
`"Projects/**"`) using the same normalization as `list` and the bulk commands.
It applies in **all three modes**:

- **Name search** — narrows resolution so the glob can disambiguate or exclude
  matches by directory (e.g. `search Sample --path "Ideas/**"`).
- **Fuzzy search** (`--fuzzy`) — ranks only candidates inside the glob.
- **Content search** (`--body`) — prefilters files before the content scan, so
  `--limit` applies to the path-scoped set.

`--path-glob` is a **deprecated alias** for `--path`. If you pass both, `--path`
wins and `--path-glob` is ignored — `search` prints a warning to stderr so the
ignored value is never silent.

## Options

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `paths`, `link`, `content`, `json` |
| `--preview` | Show file preview in fzf picker |
| `--picker <mode>` | Selection mode: `auto`, `fzf`, `numbered`, `none` |

### Actions

| Option | Description |
|--------|-------------|
| `-o, --open` | Open the selected note after search |
| `--edit` | Edit the selected note's frontmatter after search |
| `--json <patch>` | JSON patch data for `--edit` mode (non-interactive) |
| `--app <mode>` | How to open: `system`, `editor`, `visual`, `obsidian`, `print` |

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Restrict search to a type |
| `-p, --path <pattern>` | Filter by file path glob pattern (applies in **all** modes — name, `--fuzzy`, and `--body`) |
| `-w, --where <expr>` | Filter results by frontmatter expression (repeatable) |
| `-b, --body` | Enable content search mode |
| `--fuzzy` | Enable fuzzy ranked matching over names and aliases |

### Fuzzy Search Options

| Option | Description |
|--------|-------------|
| `--fuzzy` | Enable fuzzy ranked matching |
| `--threshold <0-1>` | Minimum similarity score to include a match (default: `0.5`) |
| `-l, --limit <count>` | Maximum ranked results (default: `10`) |

### Content Search Options

| Option | Description |
|--------|-------------|
| `-C, --context <lines>` | Lines of context around matches (default: 2) |
| `--no-context` | Do not show context lines |
| `-S, --case-sensitive` | Case-sensitive search (default: case-insensitive) |
| `-E, --regex` | Treat pattern as regex (default: literal) |
| `-l, --limit <count>` | Maximum files to return (default: 100) |

`--context` and `--limit` are strictly validated, consistent with `--fuzzy`'s
`--threshold` / `--limit`: a malformed value (e.g. `--limit abc`, `--limit 2.7`,
`--context -1`) is rejected with a clear error rather than being silently coerced.
`--context` accepts `0` (equivalent to `--no-context`); `--limit` must be a
positive integer.

## Output Formats

| Format | Description |
|--------|-------------|
| `text` | Note name (default) |
| `paths` | Vault-relative path with extension |
| `link` | Wikilink format (`[[Note Name]]`) |
| `content` | Full file contents (frontmatter + body) |
| `json` | JSON with metadata and matches |

## Examples

### Name Search

```bash
# Find by name
bwrb search "My Note"

# Scope name resolution to a directory (disambiguates duplicate basenames)
bwrb search "Sample" --path "Ideas/**"

# Output as wikilink
bwrb search "My Note" --output link
# Output: [[My Note]]

# Find and open with default app (system by default)
bwrb search "My Note" --open

# Find and open in $EDITOR
bwrb search "My Note" --open --app editor

# Find and open with a positional app mode (parity with `open`)
bwrb search "My Note" --open print

# Find and edit frontmatter
bwrb search "My Note" --edit

# Non-interactive edit
bwrb search "My Note" --edit --json '{"status":"settled"}'
```

### Fuzzy Search

Fuzzy search answers "does an entity like X already exist?" before you (or an
AI agent) create a new note. It returns **ranked** candidates with a visible
similarity score (`1.0` = exact match), matching against each note's name and
its declared aliases.

```bash
# Ranked near-matches by name or alias
bwrb search "Stephen Yeg" --fuzzy

# Tighten the match cutoff (default threshold is 0.5)
bwrb search "Steve" --fuzzy --threshold 0.7

# Cap the number of ranked results (default 10)
bwrb search "Steve" --fuzzy --limit 3

# JSON output with scores for an agent to consume
bwrb search "Steve" --fuzzy --output json

# Print the full contents of ranked matches, best-first
bwrb search "Steve" --fuzzy --output content

# Open the best fuzzy match (picker on ambiguity in a terminal)
bwrb search "Stephen Yeg" --fuzzy --open

# Open the best match in $EDITOR
bwrb search "Stephen Yeg" --fuzzy --open --app editor

# Edit the best match's frontmatter
bwrb search "Stephen Yeg" --fuzzy --edit --json '{"status":"settled"}'
```

All output formats work uniformly across search modes. With `--fuzzy`,
`--output content` prints the full file contents (frontmatter + body) of the
ranked matches — identical in shape to plain `search --output content` — emitted
best-first by score.

`--open` and `--edit` work with `--fuzzy` too, reusing the same open/edit and
app-mode handling as the other search modes. In an interactive terminal with
multiple matches, you get the picker (ordered best-first by score); otherwise
(non-interactive, `--picker none`, JSON mode, or a single match) the **best**
match is acted on. A query with no matches is a hard error rather than a silent
no-op.

#### What participates in matching

- The note **name** (file basename, without `.md`) — always.
- Every declared **alias** (the field carrying the `alias` role) — for
  schema-typed entities. A note like `Steve Yegge` with aliases `Stevey` /
  `Steve Y` is matchable by any of those strings.

Each note contributes its single best-scoring field. An exact name match always
scores `1.0` and ranks first; results below the threshold are dropped, and the
remainder are returned best-first up to the limit.

#### JSON output shape

```json
{
  "success": true,
  "data": [
    {
      "name": "Steve Yegge",
      "score": 0.8333,
      "matchedField": "alias",
      "matchedValue": "Stevey",
      "aliases": ["Stevey", "Steve Y"],
      "wikilink": "[[Steve Yegge]]",
      "path": "People/Steve Yegge.md",
      "absolutePath": "/vault/People/Steve Yegge.md"
    }
  ]
}
```

`matchedField` is `"name"` or `"alias"`; `matchedValue` is the specific string
that produced the score. An empty `data` array means no candidate met the
threshold.

### Content Search

```bash
# Search all notes for "deploy"
bwrb search "deploy" --body

# Search only in tasks
bwrb search "deploy" -b -t task

# Restrict to a path glob
bwrb search "deploy" -b --path "Projects/**"

# Filter by frontmatter
bwrb search "TODO" -b --where "status != 'done'"

# Regex search
bwrb search "error.*log" -b --regex

# JSON output with matches
bwrb search "deploy" -b --output json

# Search and open first match
bwrb search "deploy" -b --open
```

### Piping

```bash
# Open results in VS Code
bwrb search "bug" --output paths | xargs -I {} code {}
```

## Picker Modes

| Mode | Behavior |
|------|----------|
| `auto` | Use fzf if available, else numbered select (default) |
| `fzf` | Force fzf (error if unavailable) |
| `numbered` | Force numbered select |
| `none` | Error on ambiguity (for non-interactive use) |

## Wikilink Format

Uses shortest unambiguous form:
- Unique basename: `[[My Note]]`
- Ambiguous (multiple notes with same name): `[[Ideas/My Note]]`

Disambiguation is always evaluated against the **whole vault**, even when
`--path` scopes the search. A basename that is duplicated elsewhere in the vault
stays path-qualified (`[[Ideas/My Note]]`) so the emitted link is unambiguous in
Obsidian — even if only one copy falls inside the `--path` glob.

## App Mode Precedence

1. `--app` flag (explicit)
2. `BWRB_DEFAULT_APP` environment variable
3. `config.open_with` in `.bwrb/schema.json`
4. Fallback: `system`

## See Also

- [bwrb open](/reference/commands/open/) — Alias for `search --open`
- [bwrb edit](/reference/commands/edit/) — Alias for `search --edit`
- [Targeting Model](/reference/targeting/) — Selector reference

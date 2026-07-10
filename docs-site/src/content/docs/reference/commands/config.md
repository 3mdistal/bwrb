---
title: bwrb config
description: Vault configuration settings
---

Manage vault-wide configuration options.

## Synopsis

```bash
bwrb config <subcommand>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [list](#list) | Show configuration values |
| [edit](#edit) | Edit configuration values |

## Available Options

| Option | Description | Values |
|--------|-------------|--------|
| `link_format` | How relations are formatted | `wikilink`, `markdown` |
| `editor` | Terminal editor command | Path or command |
| `visual` | GUI editor command | Path or command |
| `open_with` | Default app for opening notes | `system`, `editor`, `visual`, `obsidian` |
| `obsidian_vault` | Obsidian vault name for URI scheme | String |
| `default_dashboard` | Dashboard used when no name is passed | Dashboard name or empty string |
| `excluded_directories` | Directory prefixes excluded from discovery and targeting | JSON string array |
| `date_format` | Pattern for generated full dates and unambiguous parsing | String using `YYYY`, `MM`, and `DD` tokens |
| `date_granularity` | Default coarsest precision for date fields | `day`, `month`, `year` |
| `mention_exclude_types` | Types excluded as mention targets | JSON string array |
| `mention_exclude_paths` | Path globs excluded as mention targets | JSON string array |
| `mention_link_once` | Limit auto-fixes to one link per note/target pair | Boolean |

This is the command's complete editable subset. Nested `calendars` definitions
remain a schema workflow while guided calendar authoring is tracked in
[#790](https://github.com/3mdistal/bwrb/issues/790). Advanced
`mention_fuzzy_threshold` and `mention_corpus_*` tuning also remains
schema-only. Edit those settings directly in `.bwrb/schema.json` and check the
result with `bwrb schema validate`.

When unset, `date_format` is `YYYY-MM-DD` and `date_granularity` is `day`.
Through `config edit`, `date_format` requires each of `YYYY`, `MM`, and `DD`
exactly once. Supported patterns include `YYYY-MM-DD`, `MM/DD/YYYY`,
`DD/MM/YYYY`, and `DD-MM-YYYY`.

Gregorian date fields are canonicalized to `YYYY-MM-DD` when written, while
partial dates remain ISO (`YYYY-MM` or `YYYY`). The configured pattern lets
Bowerbird parse matching generated or user-supplied full dates without guessing
their month/day order. It also applies to generated date placeholders outside
date frontmatter fields. Once `date_format` is explicitly set, non-ISO full-date
input must match that pattern; canonical `YYYY-MM-DD` and permitted ISO partials
remain accepted. Without an explicit setting, legacy unambiguous slash/dash
input remains accepted.

## Configuration Location

Configuration is stored in `.bwrb/schema.json` under the `config` key.

---

## list

Display vault configuration values.

### Synopsis

```bash
bwrb config list [options] [option]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `option` | Specific option to show (shows all if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `json` |

### Examples

```bash
# Show all configuration
bwrb config list

# Show specific option
bwrb config list open_with
bwrb config list link_format
bwrb config list date_format

# JSON output
bwrb config list --output json
```

---

## edit

Modify vault configuration values.

### Synopsis

```bash
bwrb config edit [options] [option]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `option` | Specific option to edit (prompts if omitted) |

### Options

| Option | Description |
|--------|-------------|
| `--json <value>` | Set value directly (JSON mode) |
| `--output <format>` | Output format: `text`, `json` |

### Examples

#### Interactive Editing

```bash
# Edit with picker
bwrb config edit

# Edit specific option
bwrb config edit open_with
bwrb config edit link_format
bwrb config edit date_granularity
```

#### Non-interactive (JSON) Mode

```bash
# Set string value
bwrb config edit open_with --json '"editor"'

# Set complex value
bwrb config edit obsidian_vault --json '"My Vault"'

# Set date writing and partial-date defaults
bwrb config edit date_format --json '"DD/MM/YYYY"'
bwrb config edit date_granularity --json '"month"'

# Set arrays and booleans
bwrb config edit excluded_directories --json '["Archive","Templates"]'
bwrb config edit mention_exclude_paths --json '["Imports/**"]'
bwrb config edit mention_link_once --json 'true'
```

---

## See Also

- [Schema](/concepts/schema/) — Schema structure

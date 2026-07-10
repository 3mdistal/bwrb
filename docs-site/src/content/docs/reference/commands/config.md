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
| `mention_exclude_types` | Types excluded as mention targets | JSON string array |
| `mention_exclude_paths` | Path globs excluded as mention targets | JSON string array |
| `mention_link_once` | Limit auto-fixes to one link per note/target pair | Boolean |

This is the command's complete editable subset. Other valid schema settings —
including `date_format`, `date_granularity`, `calendars`,
`mention_fuzzy_threshold`, and the `mention_corpus_*` keys — must currently be
edited directly in `.bwrb/schema.json` and checked with
`bwrb schema validate`. The difference is tracked in
[#809](https://github.com/3mdistal/bwrb/issues/809).

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
```

#### Non-interactive (JSON) Mode

```bash
# Set string value
bwrb config edit open_with --json '"editor"'

# Set complex value
bwrb config edit obsidian_vault --json '"My Vault"'

# Set arrays and booleans
bwrb config edit excluded_directories --json '["Archive","Templates"]'
bwrb config edit mention_exclude_paths --json '["Imports/**"]'
bwrb config edit mention_link_once --json 'true'
```

---

## See Also

- [Schema](/concepts/schema/) — Schema structure

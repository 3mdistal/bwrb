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
| `-o, --output <format>` | Output format: `text`, `json` |

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
| `-o, --output <format>` | Output format: `text`, `json` |

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
```

---

## See Also

- [Schema concepts](/concepts/schema/) — Schema structure

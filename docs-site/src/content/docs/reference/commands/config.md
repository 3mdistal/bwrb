---
title: bwrb config
description: Vault configuration settings
---

Manage vault-wide configuration options.

## Usage

```bash
bwrb config <subcommand>
```

## Subcommands

### list

View configuration:

```bash
bwrb config list              # All options
bwrb config list link_format  # Specific option
```

### edit

Modify configuration:

```bash
bwrb config edit link_format
bwrb config edit --json '{"link_format": "markdown"}'
```

## Available Options

| Option | Description | Values |
|--------|-------------|--------|
| `link_format` | How relations are formatted | `wikilink`, `markdown` |
| `editor` | Editor command | Path or command |
| `visual` | Visual editor | Path or command |
| `open_with` | Default open app | `system`, `editor`, `obsidian` |
| `obsidian_vault` | Obsidian vault name | String |

## See Also

- [Schema concepts](/concepts/schema/)

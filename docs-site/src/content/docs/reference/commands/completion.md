---
title: bwrb completion
description: Shell completion scripts
---

Generate shell completion scripts for tab completion.

## Synopsis

```bash
bwrb completion <shell>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `shell` | Shell type: `bash`, `zsh`, `fish` |

## Installation

### Bash

Add to `~/.bashrc`:

```bash
eval "$(bwrb completion bash)"
```

### Zsh

Add to `~/.zshrc`:

```zsh
eval "$(bwrb completion zsh)"
```

### Fish

Run once to install:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

## What Gets Completed

| Context | Completions |
|---------|-------------|
| `bwrb <TAB>` | Visible commands: `new`, `edit`, `delete`, `list`, `recent`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `init`, `config`, `completion` |
| `bwrb schema <TAB>` | Schema subcommands, including `types`, `fields`, and `discover` |
| `bwrb template <TAB>` | Template subcommands: `list`, `validate`, `new`, `edit`, `delete` |
| `bwrb recent -<TAB>` | Options including `--open`, `--app`, `--save-as`, and `--force` |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`, etc. |
| `bwrb new <TAB>` | Types from your schema |
| `bwrb list --type <TAB>` | Types from your schema |
| `bwrb list --path <TAB>` | Directories in your vault |

## Notes

- Completions are generated dynamically from your vault's schema
- Ensure `BWRB_VAULT` is set or run from within a vault directory
- Root command and maintained subcommand candidates are contract-tested against
  the built CLI help surface
- The hidden compatibility commands `open` and `search` remain callable but are
  not root completion candidates; use `list` for new workflows
- Restart your shell after adding the completion script

## See Also

- [Shell completion guide](/automation/shell-completion/) — Detailed setup

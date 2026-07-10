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
| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, `config` |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`, etc. |
| `bwrb new <TAB>` | Types from your schema |
| `bwrb list --type <TAB>` | Types from your schema |
| `bwrb list --path <TAB>` | Directories in your vault |

## Notes

- Completions are generated dynamically from your vault's schema
- Ensure `BWRB_VAULT` is set or run from within a vault directory
- `init` is visible in `bwrb --help` but is currently missing from root command
  completion candidates ([#810](https://github.com/3mdistal/bwrb/issues/810))
- The hidden compatibility commands `open` and `search` remain callable but are
  not root completion candidates; use `list` for new workflows
- Restart your shell after adding the completion script

## See Also

- [Shell completion guide](/automation/shell-completion/) — Detailed setup

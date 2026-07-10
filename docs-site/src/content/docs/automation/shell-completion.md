---
title: Shell Completion
description: Tab completion for commands, types, and paths
---

Enable tab completion for faster CLI usage.

## Setup

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

Run once:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

## What Gets Completed

| Context | Completion |
|---------|------------|
| `bwrb <TAB>` | Visible commands: `new`, `edit`, `delete`, `list`, `recent`, `schema`, `audit`, `bulk`, `template`, `lineage`, `dashboard`, `init`, `config`, `completion` |
| `bwrb schema <TAB>` | Subcommands: `types`, `fields`, `validate`, `discover`, `new`, `edit`, `delete`, `list`, `diff`, `migrate`, `history` |
| `bwrb template <TAB>` | Subcommands: `list`, `validate`, `new`, `edit`, `delete` |
| `bwrb lineage <TAB>` | Subcommand: `adopt` |
| `bwrb recent -<TAB>` | Options including `--open`, `--app`, `--save-as`, and `--force` |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`... |
| `bwrb new <TAB>` | Types from schema: `task`, `idea`... |
| `bwrb list --path <TAB>` | Directories: `Ideas/`, `Projects/`... |

## Vault Awareness

Completions are context-aware:

- Types come from your vault's schema
- Paths come from your vault's directory structure
- No hard-coded values

Root command and maintained subcommand candidates are contract-tested against
the built CLI help surface. The hidden compatibility commands `open` and
`search` remain callable but are intentionally not taught as canonical root
candidates.

## See Also

- [bwrb completion command](/reference/commands/completion/)
